/**
 * Round-trip test: the real registry file 鈫?host state view 鈫?browser strip 鈫? * host save 鈫?reload. Proves the settings page cannot silently drop or corrupt
 * the registry the user already has on disk.
 *
 *   node check-roundtrip.mjs
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRegistry,
  loadRegistry,
  registryStateView,
  writeRegistryFile,
} from "file:///F:/DS_WorkSpace/dsh-aux-models/index.js";

const failures = [];
function assert(label, condition, detail = "") {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` ${detail}`}`);
  if (!condition) failures.push(label);
}

/* the browser half, loaded the way the Harness loads it */
const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
let spec = null;
const window = { __ModuleLoader__: { load: value => { spec = value; } } };
new Function("window", source)(window);
const client = spec.factory(name => {
  if (name === "react") return { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {} };
  throw new Error(`unexpected require(${name})`);
});
const stripRegistry = client.__internals && client.__internals.stripRegistry;
assert("client exposes stripRegistry", typeof stripRegistry === "function");

const realPath = "F:\\DSH\\DSH-Home\\aux-models.json";
assert("real registry exists", existsSync(realPath), realPath);
const before = await loadRegistry({ registryPath: realPath });
assert("real registry has channels", before.channels.length > 0, JSON.stringify(before.channels.map(c => c.id)));
assert("real registry has weights", typeof before.weights?.quality === "number");

const workDir = mkdtempSync(join(tmpdir(), "aux-roundtrip-"));
const workPath = join(workDir, "aux-models.json");
const config = { registryPath: workPath };
writeRegistryFile(config, before);

const state = await registryStateView(config);
assert("state view is ok", state.ok === true);
assert("state view exposes channels", Array.isArray(state.channels) && state.channels.length > 0);
const modelCount = state.channels.reduce((n, c) => n + (c.models?.length ?? 0), 0);
assert("state view exposes models", modelCount > 0, `models=${modelCount}`);
assert("state view carries computed fields", typeof state.channels[0].models[0].effective?.inputPerM === "number");

const stripped = stripRegistry(state);
assert("strip keeps channel count", stripped.channels.length === state.channels.length);
const strippedModels = stripped.channels.reduce((n, c) => n + (c.models?.length ?? 0), 0);
assert("strip keeps model count", strippedModels === modelCount, `${strippedModels} vs ${modelCount}`);
assert("strip drops computed fields", stripped.channels[0].models[0].effective === undefined);
assert("strip keeps pricing", typeof stripped.channels[0].models[0].pricing?.inputPerM === "number");
assert("strip keeps strengths", Array.isArray(stripped.channels[0].models[0].strengths));

/* save what the browser would send, then read it back */
const saved = buildRegistry(stripped);
writeRegistryFile(config, saved);
const reloaded = await loadRegistry({ registryPath: workPath });

const shape = registry => ({
  weights: registry.weights,
  routing: {
    askBelowConfidence: registry.routing.askBelowConfidence,
    askAboveCost: registry.routing.askAboveCost,
    maxCostPerCall: registry.routing.maxCostPerCall,
    maxRounds: registry.routing.maxRounds,
  },
  defaultModel: registry.defaultModel,
  channels: registry.channels.map(c => ({
    id: c.id,
    provider: c.provider,
    multiplier: c.multiplier,
    cacheHitRate: c.cacheHitRate,
    stability: c.stability,
    enabled: c.enabled,
    models: c.models.map(m => ({
      id: m.id,
      model: m.model,
      mapsTo: m.mapsTo ?? "",
      qualityTier: m.qualityTier,
      strengths: [...(m.strengths ?? [])].sort(),
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsTools: m.supportsTools,
      enabled: m.enabled,
      pricing: m.pricing
        ? { inputPerM: m.pricing.inputPerM, outputPerM: m.pricing.outputPerM, source: m.pricing.source ?? "" }
        : null,
    })),
  })),
});

const left = JSON.stringify(shape(before));
const right = JSON.stringify(shape(reloaded));
assert("round-trip preserves the registry", left === right, `\n  before=${left.slice(0, 300)}\n  after =${right.slice(0, 300)}`);

/* a brand new channel added in the browser must survive too */
const grown = JSON.parse(JSON.stringify(stripped));
grown.channels.push({
  id: "test-gw",
  name: "Test GW",
  provider: "test-provider",
  multiplier: 1,
  cacheHitRate: 0,
  stability: 8,
  enabled: true,
  models: [
    {
      id: "tiny",
      label: "Tiny",
      model: "tiny-model",
      qualityTier: 1,
      strengths: ["general"],
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: false,
      enabled: true,
      pricing: { inputPerM: 0.1, outputPerM: 0.4, source: "manual" },
    },
  ],
});
writeRegistryFile(config, buildRegistry(grown));
const afterAdd = await loadRegistry({ registryPath: workPath });
const added = afterAdd.channels.find(c => c.id === "test-gw");
assert("new channel survives a save", !!added, JSON.stringify(afterAdd.channels.map(c => c.id)));
assert("new channel keeps its model", added?.models?.[0]?.id === "tiny" && added.models[0].model === "tiny-model");
assert("new channel keeps manual price", added?.models?.[0]?.pricing?.inputPerM === 0.1);
const effective = added?.models?.[0]?.pricing ? 0.1 : NaN;
assert("effective price is derived, not stored", JSON.parse(readFileSync(workPath, "utf8")).channels.find(c => c.id === "test-gw").models[0].effective === undefined, `derived=${effective}`);

rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\ncheck-roundtrip: ${failures.length} failure(s) — ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ncheck-roundtrip: ok");

