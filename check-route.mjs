/**
 * Offline self-check for the v2 router: no Harness, no network, no credentials.
 *
 *   node check-route.mjs
 *
 * It builds a synthetic registry (two channels, three models with different
 * tiers/prices/strengths), fabricates statistics, and asserts the routing
 * decisions that matter:
 *
 *   1. a cheap factual question goes to the cheap route, not the frontier one;
 *   2. a code task with tools:true never picks a model without tool calling;
 *   3. the quality/cost weights actually move the winner;
 *   4. measured quality overrides the declared tier once samples exist;
 *   5. a budget below every estimate reports the rejected candidates;
 *   6. a model in breaker state is ranked down.
 */

import assert from "node:assert/strict";

const registry = {
  path: "(synthetic)",
  missing: false,
  version: 2,
  weights: { quality: 0.7, cost: 0.3 },
  routing: { askBelowConfidence: 0.15, askAboveCost: 0.05, maxCostPerCall: 0.5, maxRounds: 6, breakerFailures: 3, cooldownMinutes: 10 },
  channels: [],
  models: [
    {
      id: "frontier",
      label: "Frontier",
      provider: "p",
      model: "m-frontier",
      qualityTier: 3,
      strengths: ["code_generation", "technical_design"],
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      supportsTools: true,
      pricing: { inputPerM: 10, outputPerM: 50 },
      enabled: true,
      channel: "a",
      multiplier: 1,
      cacheHitRate: 0,
      stability: 9,
    },
    {
      id: "mid",
      label: "Mid",
      provider: "p",
      model: "m-mid",
      qualityTier: 2,
      strengths: ["code_understanding", "writing"],
      contextWindow: 200000,
      maxOutputTokens: 32000,
      supportsTools: true,
      pricing: { inputPerM: 1, outputPerM: 4 },
      enabled: true,
      channel: "a",
      multiplier: 1,
      cacheHitRate: 0,
      stability: 8,
    },
    {
      id: "cheap",
      label: "Cheap",
      provider: "p",
      model: "m-cheap",
      qualityTier: 1,
      strengths: ["factual_lookup", "writing"],
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsTools: false,
      pricing: { inputPerM: 0.2, outputPerM: 1.2 },
      enabled: true,
      channel: "b",
      multiplier: 1,
      cacheHitRate: 0,
      stability: 9,
    },
  ],
  defaultModel: "mid",
};

const emptyStats = { version: 2, cells: {}, failures: {} };
const { routeTask, classifyTask, estimateCost, qualityEstimate } = await import("./index.js");

/* 1. classification */
assert.equal(classifyTask("写一个 Python 函数解析 CSV").type, "code_generation");
assert.equal(classifyTask("解释一下这段代码做了什么").type, "code_understanding");
assert.equal(classifyTask("这个接口该怎么设计，有什么权衡").type, "technical_design");
assert.equal(classifyTask("对比两种方案的成本，做个分析").type, "analytical_reasoning");
assert.equal(classifyTask("帮我写封邮件给团队").type, "writing");
assert.equal(classifyTask("首都多少人口").type, "factual_lookup");
// regression: a code marker must outrank the generic 改写 writing verb
assert.equal(classifyTask("把这段 Python 解析 CSV 的函数改写一下").type, "code_generation");
assert.equal(classifyTask("rewrite this TypeScript function to be faster").type, "code_generation");
assert.equal(classifyTask("把这段说明文档润色一下").type, "writing");
assert.equal(classifyTask("你好").type, "general");
console.log("classify: ok");

/* 2. a cheap factual lookup under cost pressure prefers the cheap route */
const cheapPick = routeTask(registry, emptyStats, "查一下首都是哪里", { strategy: "cheap" });
assert.equal(cheapPick.chosen.id, "cheap", `expected cheap route, got ${cheapPick.chosen.id}`);
console.log(`cheap strategy → ${cheapPick.chosen.id} (score ${cheapPick.ranking[0].score.toFixed(3)})`);

/* 3. tools:true must exclude the non-tool model */
const toolPick = routeTask(registry, emptyStats, "翻一下仓库里 index.js 的实现", { tools: true, strategy: "cheap" });
assert.notEqual(toolPick.chosen.id, "cheap");
assert.ok(toolPick.rejected.some(item => item.entry.id === "cheap" && /supportsTools/.test(item.reason)));
console.log(`tools:true → ${toolPick.chosen.id}, cheap excluded for supportsTools`);

/* 4. weights really move the winner */
const qualityFirst = routeTask({ ...registry, weights: { quality: 0.95, cost: 0.05 } }, emptyStats, "写一份架构设计文档", {});
const costFirst = routeTask({ ...registry, weights: { quality: 0.05, cost: 0.95 } }, emptyStats, "写一份架构设计文档", {});
assert.notEqual(qualityFirst.chosen.id, costFirst.chosen.id, "weights had no effect");
console.log(`weights: quality-first → ${qualityFirst.chosen.id}, cost-first → ${costFirst.chosen.id}`);

/* 5. measured quality overrides the declared tier */
const learned = {
  version: 2,
  cells: {
    "cheap|code_generation": { n: 40, qualitySum: 39, failN: 1, latencySumMs: 40000, tokensIn: 0, tokensOut: 0 },
  },
  failures: {},
};
const learnedPick = routeTask(registry, learned, "写一个模块", { strategy: "auto" });
const cheapRank = learnedPick.ranking.find(item => item.entry.id === "cheap");
const frontierRank = learnedPick.ranking.find(item => item.entry.id === "frontier");
assert.ok(cheapRank.quality.samples === 40 && cheapRank.quality.value > 0.9);
assert.ok(cheapRank.score > frontierRank.score, "learned 40/40 quality did not outweigh the tier-3 prior");
console.log(`learned: cheap=${cheapRank.quality.value.toFixed(3)} > frontier=${frontierRank.quality.value.toFixed(3)} → winner ${learnedPick.chosen.id}`);

/* 6. breaker state demotes a flaky model */
const flaky = {
  version: 2,
  cells: {},
  failures: { frontier: [{ at: Date.now() - 60000, message: "502" }, { at: Date.now() - 30000, message: "502" }, { at: Date.now() - 1000, message: "502" }] },
};
const flakyPick = routeTask(registry, flaky, "写一个模块", { strategy: "best" });
const flakyRank = flakyPick.ranking.find(item => item.entry.id === "frontier");
assert.ok(flakyRank.health.breaker, "breaker did not trip on 3 recent failures");
assert.ok(flakyRank.score < flakyRank.quality.value, "breaker did not demote the score");
console.log(`breaker: frontier score ${flakyRank.score.toFixed(3)} (quality ${flakyRank.quality.value.toFixed(3)}), winner ${flakyPick.chosen.id}`);

/* 7. impossible budget reports why */
let threw = null;
try {
  routeTask(registry, emptyStats, "写一个模块", { tools: true, maxCost: 1e-9 });
} catch (error) {
  threw = error;
}
assert.ok(threw && /no auxiliary model fits/.test(threw.message), "budget filter did not reject everything");
console.log(`budget: ${threw.message.slice(0, 120)}…`);

/* 8. price math: 0.14x multiplier with 80% cache hits */
const priced = registry.models[0];
const { effectivePricing } = await import("./index.js");
const price = effectivePricing({ ...priced, multiplier: 0.14, cacheHitRate: 0.8 });
const expectedIn = 10 * 0.14 * (0.2 + 0.8 * 0.1);
assert.ok(Math.abs(price.inputPerM - expectedIn) < 1e-9, `input price ${price.inputPerM} != ${expectedIn}`);
assert.ok(Math.abs(price.outputPerM - 50 * 0.14) < 1e-9);
const oneCall = estimateCost({ ...priced, multiplier: 0.14, cacheHitRate: 0.8 }, 20000, 2000);
console.log(`price: $${price.inputPerM.toFixed(3)}/M in, $${price.outputPerM.toFixed(3)}/M out; 20k+2k ≈ $${oneCall.toFixed(4)}`);

/* 9. learned evidence decays and is capped, so old wins cannot lock a cell in */
const tier1 = { id: "cheap", qualityTier: 1 };
const fresh = qualityEstimate(tier1, { cells: { "cheap|code_generation": { n: 40, qualitySum: 40, lastAt: Date.now() } } }, "code_generation");
const stale = qualityEstimate(tier1, { cells: { "cheap|code_generation": { n: 40, qualitySum: 40, lastAt: Date.now() - 60 * 24 * 3600 * 1000 } } }, "code_generation");
const capped = qualityEstimate(tier1, { cells: { "cheap|code_generation": { n: 5000, qualitySum: 5000, lastAt: Date.now() } } }, "code_generation");
assert.ok(fresh.value > 0.9, `fresh quality ${fresh.value}`);
assert.ok(stale.value < fresh.value - 0.2, `stale quality ${stale.value} did not decay (fresh ${fresh.value})`);
assert.ok(fresh.decay === 1 && stale.decay < 0.1, `decay factors ${fresh.decay} / ${stale.decay}`);
assert.ok(capped.effectiveSamples === 200, `cap not applied: ${capped.effectiveSamples}`);
assert.ok(capped.value < 0.99, `cap did not clip the mean: ${capped.value}`);
console.log(`decay: fresh=${fresh.value.toFixed(3)} stale=${stale.value.toFixed(3)} capped=${capped.value.toFixed(3)} (effective ${capped.effectiveSamples})`);

/* 10. transient failures are retryable, auth failures are not */
const { isTransientFailure } = await import("./index.js");
assert.ok(isTransientFailure(new Error('aux-models: dieqi/gpt-6-astra failed: error: 502 "cannot resolve tunnel destination cfapi.dieqiyun.top (ETIMEDOUT)"')));
assert.ok(isTransientFailure(new Error("socket hang up")));
assert.ok(isTransientFailure(new Error("aux-models: dieqi/gpt-6-astra timed out after 180000ms")));
assert.ok(!isTransientFailure(new Error('401 "INVALID_API_KEY"')));
assert.ok(!isTransientFailure(new Error("aux-models: dieqi/gpt-6-astra returned no text")));
console.log("transient: 502/timeout retryable, 401/empty not");

console.log("check-route: ok");
