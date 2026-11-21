// Offline check for aux_delegate_batch: real parallelism, per-task routing, and a
// failing task never sinks the batch.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `aux-batch-check-${process.pid}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
process.env.DSH_HOME = dir;

writeFileSync(join(dir, "aux-models.json"), JSON.stringify({
  version: 2,
  defaultModel: "a1",
  weights: { quality: 0.7, cost: 0.3 },
  routing: { askBelowConfidence: 0, askAboveCost: 99, maxCostPerCall: 99, maxRounds: 6, breakerFailures: 3, cooldownMinutes: 10 },
  channels: [
    {
      id: "p1", name: "p1", provider: "p1", multiplier: 1, cacheHitRate: 0, stability: 10,
      models: [
        { id: "a1", label: "Alpha", model: "m-a", qualityTier: 3, strengths: ["code_generation"], contextWindow: 100000, maxOutputTokens: 4096, supportsTools: true, pricing: { inputPerM: 1, outputPerM: 2 } },
        { id: "b1", label: "Beta", model: "m-b", qualityTier: 2, strengths: ["code_generation"], contextWindow: 100000, maxOutputTokens: 4096, supportsTools: true, pricing: { inputPerM: 1, outputPerM: 2 } },
      ],
    },
    {
      id: "p2", name: "p2", provider: "p2", multiplier: 1, cacheHitRate: 0, stability: 10,
      models: [
        { id: "c1", label: "Gamma", model: "m-c", qualityTier: 2, strengths: ["code_generation"], contextWindow: 100000, maxOutputTokens: 4096, supportsTools: true, pricing: { inputPerM: 1, outputPerM: 2 } },
        { id: "boom", label: "Boom", model: "m-boom", qualityTier: 2, strengths: ["code_generation"], contextWindow: 100000, maxOutputTokens: 4096, supportsTools: true, pricing: { inputPerM: 1, outputPerM: 2 } },
      ],
    },
  ],
}, null, 2));

const { runBatch } = await import("./index.js");

let failures = 0;
const seen = [];
function check(name, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  seen.push(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}
function assert(name, cond, detail) {
  check(name, Boolean(cond), true);
  if (!cond && detail !== undefined) seen.push(`      ${detail}`);
}
async function throws(name, run, pattern) {
  try {
    await run();
    seen.push(`FAIL ${name} — did not throw`);
    failures++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ok = pattern.test(message);
    seen.push(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${JSON.stringify(message)} vs ${pattern}`}`);
    if (!ok) failures++;
  }
}

const DELAY_MS = 120;
let calls = 0;
const ctx = {
  llm: {
    stream: async function* (request) {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      if (request.model === "m-boom") throw new Error("aux-models: p2/m-boom failed: 502 tunnel");
      const prompt = request.messages[0].content.map(block => block.text ?? "").join("\n");
      yield { type: "text-delta", index: 0, text: `答: ${prompt.slice(0, 12)}` };
      yield { type: "usage", usage: { inputTokens: 30, outputTokens: 8 } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
};

const settings = { fallback: true };
const exec = { sessionId: "check-batch" };

// 1. empty batch is rejected
await throws("empty batch", () => runBatch(ctx, settings, { tasks: [] }, exec), /requires `tasks`/);

// 2. three tasks run concurrently, in order, each routed
calls = 0;
const batch = await runBatch(ctx, settings, { tasks: ["任务一 alpha", "任务二 beta", "任务三 gamma"] }, exec);
check("all three finished", batch.done, 3);
check("one call per task", calls, 3);
assert("report has one line per task", /1\. ✓/.test(batch.report) && /3\. ✓/.test(batch.report));
assert("parallel", batch.elapsedMs < DELAY_MS * 2.5, `elapsedMs=${batch.elapsedMs} (serial would be ~${DELAY_MS * 3})`);
assert("spend is tracked", batch.spentUsd > 0, `spentUsd=${batch.spentUsd}`);

// 3. a pinned model is honoured, and results keep the input order
const pinned = await runBatch(ctx, settings, { tasks: [{ task: "任务 pm", model: "c1" }, { task: "任务 pm2", model: "b1" }, { task: "任务 pm3", model: "a1" }] }, exec);
check("pinned models used in order", pinned.results.map(result => result.id), ["c1", "b1", "a1"]);

// 4. one dead task does not sink the rest
const partial = await runBatch(ctx, settings, {
  tasks: [{ task: "任务 ok1", model: "a1" }, { task: "任务 boom", model: "boom" }, { task: "任务 ok2", model: "c1" }],
}, exec);
check("dead task isolated", partial.done, 2);
assert("failure is reported inline", /✗ boom/.test(partial.report), partial.report);
assert("the survivors answered", partial.results.filter(result => result.ok).length === 2);

// 5. budget guard refuses before sending anything (each task fits, the sum does not)
calls = 0;
await throws("budget guard", () => runBatch(ctx, settings, { tasks: ["任务一", "任务二", "任务三"], max_cost: 0.005 }, exec), /over the \$/);
check("budget guard sent nothing", calls, 0);

// 6. tool loop failures degrade to a per-task error instead of throwing
const withTools = await runBatch(ctx, settings, { tasks: [{ task: "任务 tools", model: "a1", tools: true }] }, exec);
check("tool task fails cleanly", withTools.done, 0);
assert("tool failure has an error string", typeof withTools.results[0].error === "string", JSON.stringify(withTools.results[0]));

rmSync(dir, { recursive: true, force: true });
for (const line of seen) console.log(line);
if (failures > 0) {
  console.error(`check-batch: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check-batch: ok");
