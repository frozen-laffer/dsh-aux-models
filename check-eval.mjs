// Verifies that $DSH_HOME/aux-eval.json actually moves the router, and that a
// missing or corrupt file changes nothing.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `aux-eval-check-${process.pid}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
process.env.DSH_HOME = dir;

const mod = await import("./index.js");
const { buildRegistry, routeTask } = mod;

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

const registry = buildRegistry({
  version: 2,
  defaultModel: "cheap",
  weights: { quality: 0.7, cost: 0.3 },
  routing: { askBelowConfidence: 0, askAboveCost: 99, maxCostPerCall: 99, maxRounds: 6, breakerFailures: 3, cooldownMinutes: 10 },
  channels: [
    {
      id: "ch",
      name: "test",
      provider: "prov",
      multiplier: 1,
      cacheHitRate: 0,
      stability: 10,
      models: [
        { id: "cheap", label: "Cheap", model: "cheap-1", qualityTier: 1, strengths: ["code_generation"], contextWindow: 100000, maxOutputTokens: 4096, supportsTools: true, pricing: { inputPerM: 1, outputPerM: 2 } },
        { id: "dear", label: "Dear", model: "dear-1", qualityTier: 3, strengths: ["code_generation"], contextWindow: 100000, maxOutputTokens: 4096, supportsTools: true, pricing: { inputPerM: 1, outputPerM: 2 } },
      ],
    },
  ],
});

const emptyStats = { version: 2, cells: {}, failures: {} };
const task = "写一个 Python 函数解析 CSV 并统计缺失率";
const baseline = routeTask(registry, emptyStats, task, { strategy: "best" });
check("without eval, tier 3 wins on quality", baseline.chosen.id, "dear");
const blendedBefore = baseline.ranking.find((r) => r.entry.id === "cheap").quality;
check("cheap has no eval signal yet", blendedBefore.evalTotal ?? null, null);

writeFileSync(
  join(dir, "aux-eval.json"),
  JSON.stringify({
    version: 1,
    models: {
      cheap: { pass: 2, total: 2, rate: 1, avgMs: 5, cost: 0.001, byType: { code_generation: { pass: 2, total: 2, rate: 1 } } },
      dear: { pass: 0, total: 2, rate: 0, avgMs: 9, cost: 0.02, byType: { code_generation: { pass: 0, total: 2, rate: 0 } } },
    },
  }),
  "utf8",
);

const after = routeTask(registry, emptyStats, task, { strategy: "best" });
const cheap = after.ranking.find((r) => r.entry.id === "cheap");
const dear = after.ranking.find((r) => r.entry.id === "dear");
check("eval passes through to the ranking", cheap.quality.evalPass, 2);
check("eval total passes through", cheap.quality.evalTotal, 2);
assert("eval lifts the cheap model's quality", cheap.quality.value > blendedBefore.value, `${cheap.quality.value} vs ${blendedBefore.value}`);
assert("eval drags the dear model down", dear.quality.value < 0.9, dear.quality.value);
check("the eval-backed cheap model now wins", after.chosen.id, "cheap");

// A corrupt file must be ignored, not crash the router.
writeFileSync(join(dir, "aux-eval.json"), "{ this is not json", "utf8");
const corrupt = routeTask(registry, emptyStats, task, { strategy: "best" });
check("corrupt eval file falls back to prior", corrupt.chosen.id, "dear");

rmSync(dir, { recursive: true, force: true });
for (const line of seen) console.log(line);
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-eval: ok");
