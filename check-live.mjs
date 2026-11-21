/**
 * Boot the plugin the way the Host does (apply() with a Cordis-shaped ctx),
 * serve the settings routes on a REAL http server, and drive them with fetch.
 *
 *   node check-live.mjs
 *
 * This is the closest thing to a live check that runs without restarting the
 * desktop client: it covers apply() wiring, ctx.effect disposal, the
 * webServer.register contract, same-origin handling, JSON bodies, and one
 * aux_delegate call through a stubbed llm.stream.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "./index.js";

const failures = [];
function assert(label, condition, detail = "") {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` ${detail}`}`);
  if (!condition) failures.push(label);
}

/* -------------------------------------------------------------------------- */
/* a Cordis-shaped context                                                    */
/* -------------------------------------------------------------------------- */

const workDir = mkdtempSync(join(tmpdir(), "aux-live-"));
const registryPath = join(workDir, "aux-models.json");
plugin.writeRegistryFile(
  { registryPath },
  plugin.buildRegistry({
    version: 2,
    defaultModel: "astra",
    weights: { quality: 0.7, cost: 0.3 },
    channels: [
      {
        id: "gpt",
        name: "GPT",
        provider: "dieqi",
        multiplier: 0.14,
        cacheHitRate: 0.8,
        stability: 7,
        enabled: true,
        models: [
          {
            id: "astra",
            label: "Astra",
            model: "gpt-6-astra",
            qualityTier: 3,
            strengths: ["code_generation", "analytical_reasoning"],
            supportsTools: true,
            pricing: { inputPerM: 10, outputPerM: 50, source: "test" },
          },
          {
            id: "mini",
            label: "Mini",
            model: "gpt-mini",
            qualityTier: 1,
            strengths: ["general"],
            supportsTools: false,
            pricing: { inputPerM: 0.1, outputPerM: 0.4, source: "test" },
          },
        ],
      },
    ],
  }),
);

const registeredRoutes = new Map();
const tools = [];
const sections = [];
const disposers = [];
const llmCalls = [];
const failingModels = new Set();
const truncatedOnce = new Set();

const providerConfig = { providers: { dieqi: { displayName: "蝶祈云", api: "openai-completions", baseURL: "https://cfapi.dieqiyun.top/v1", apiKeyEnv: "DIEQI_API_KEY", models: [{ id: "gpt-6-astra" }] } } };
const editorRow = { options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: providerConfig } };
const editor = {
  entries: () => [editorRow],
  configuration: () => [{ entry: editorRow, inherited: {}, override: structuredClone(editorRow.options.config) }],
  async edit(entry, change) { entry.options.config = change(entry.options.config, {}); },
};
const credentials = {
  store: { DIEQI_API_KEY: "sk-live-test" },
  async describe(ref) { return { configured: !!this.store[ref], writable: true, source: "test" }; },
  async resolve(ref) { return this.store[ref] ? { value: this.store[ref] } : undefined; },
  async set(ref, value) { this.store[ref] = value; },
};

const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === "function") disposers.push(dispose); else disposers.push(() => {}); },
  inject(_names, fn) { fn({ webServer: { register({ path, handler }) { registeredRoutes.set(path, handler); return () => registeredRoutes.delete(path); } } }); },
  tools: {
    register(definition) { tools.push(definition); return () => {}; },
    schemas() { return []; },
    async execute() { return { isError: false, value: {}, content: [] }; },
  },
  systemPrompt: {
    section(spec) { sections.push(spec); return () => {}; },
    async assemble() { return { sections: sections.map(s => ({ name: s.name, text: typeof s.text === "function" ? s.text() : s.text })) }; },
  },
  get(name) {
    if (name === "configEditor") return editor;
    if (name === "credentials") return credentials;
    return undefined;
  },
  llm: {
    async *stream(request) {
      llmCalls.push(request);
      if (failingModels.has(request.model)) {
        throw new Error('aux-models: dieqi/gpt-6-astra failed: error: 502 "cannot resolve tunnel destination cfapi.dieqiyun.top (ETIMEDOUT)"');
      }
      if (truncatedOnce.has(request.model)) {
        // Reasoning routes can spend the whole budget thinking and emit no text.
        truncatedOnce.delete(request.model);
        yield { type: "usage", usage: { inputTokens: 900, outputTokens: 400 } };
        yield { type: "finish", reason: { kind: "max-tokens" } };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "pong" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "pong" } };
      yield { type: "usage", usage: { inputTokens: 1000, outputTokens: 20 } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
};

await plugin.apply(ctx, { registryPath, statsPath: join(workDir, "aux-stats.json"), debug: true });

/* -------------------------------------------------------------------------- */
/* wiring                                                                     */
/* -------------------------------------------------------------------------- */

assert("registers five tools", tools.length === 5, tools.map(t => t.name).join(","));
assert("aux_models registered", tools.some(t => t.name === "aux_models"));
assert("aux_route registered", tools.some(t => t.name === "aux_route"));
assert("aux_delegate registered", tools.some(t => t.name === "aux_delegate"));
assert("aux_delegate_batch registered", tools.some(t => t.name === "aux_delegate_batch"));
assert("debug tool registered", tools.some(t => t.name === "aux_prompt_peek"));
const everyToolHasOutput = tools.every(t => t.output && typeof t.output.render === "function" && t.output.schema);
assert("every tool declares output", everyToolHasOutput, JSON.stringify(tools.map(t => t.name)));
assert("registers policy + routing sections", sections.length === 2 && sections.some(s => s.name === "aux-models:policy") && sections.some(s => s.name === "aux-models:routing"), JSON.stringify(sections.map(s => s.name)));
assert("policy sits next to PLAN_POLICY and routing stays by the tool docs", sections.find(s => s.name === "aux-models:policy")?.order === 550 && sections.find(s => s.name === "aux-models:routing")?.order === 2790);
const guidance = (() => { const spec = sections.find(s => s.name === "aux-models:routing"); return spec && typeof spec.text === "function" ? spec.text() : ""; })();
assert("guidance mentions the models", guidance.includes("astra") && guidance.includes("$0.39/M"), guidance.slice(0, 200));

const expectedRoutes = [
  "/dsh-aux-models/balance-prices",
  "/dsh-aux-models/discover",
  "/dsh-aux-models/preview",
  "/dsh-aux-models/route",
  "/dsh-aux-models/route-remove",
  "/dsh-aux-models/routes",
  "/dsh-aux-models/save",
  "/dsh-aux-models/state",
  "/dsh-aux-models/test",
  "/dsh-aux-models/eval",
  "/dsh-aux-models/eval/run",
  "/dsh-aux-models/eval/status",
  "/dsh-aux-models/eval/stop",
];
assert("all routes registered", expectedRoutes.every(p => registeredRoutes.has(p)), [...registeredRoutes.keys()].join(","));

/* -------------------------------------------------------------------------- */
/* real http round trips                                                      */
/* -------------------------------------------------------------------------- */

const server = createServer((req, res) => {
  const handler = registeredRoutes.get(new URL(req.url, "http://127.0.0.1").pathname);
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  Promise.resolve(handler(req, res)).catch(error => {
    res.writeHead(500).end(String(error));
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let response = await fetch(`${origin}/dsh-aux-models/state`);
let payload = await response.json();
assert("state 200", response.status === 200);
assert("state exposes two models", payload.channels[0].models.length === 2, JSON.stringify(payload.channels?.[0]?.models?.map(m => m.id)));
assert("state price reflects 0.14x and 80% cache", payload.channels[0].models[0].effective.inputPerM === 0.392, JSON.stringify(payload.channels[0].models[0].effective));
const statePayload = payload;

response = await fetch(`${origin}/dsh-aux-models/state`, { method: "POST" });
assert("state rejects POST", response.status === 405, String(response.status));

response = await fetch(`${origin}/dsh-aux-models/preview`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ task: "把这段 Python 解析 CSV 的函数改写一下", strategy: "cheap" }),
});
payload = await response.json();
assert("preview 200", response.status === 200, JSON.stringify(payload));
assert("preview classifies code", payload.taskType === "code_generation", payload.taskType);
assert("preview picked the cheap model", payload.chosen && payload.chosen.id === "mini", JSON.stringify(payload.chosen));
assert("preview priced it", payload.estimate && payload.estimate.usd > 0, JSON.stringify(payload.estimate));
assert("preview lists the ranking", payload.ranking.length === 2, JSON.stringify(payload.ranking.map(r => r.id)));

response = await fetch(`${origin}/dsh-aux-models/preview`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://evil.example" },
  body: JSON.stringify({ task: "hi" }),
});
assert("preview rejects cross-origin", response.status === 403, String(response.status));

response = await fetch(`${origin}/dsh-aux-models/save`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ registry: { ...statePayload, weights: { quality: 0.5, cost: 0.5 } } }),
});
assert("save 200", response.status === 200, String(response.status));
const saved = JSON.parse(readFileSync(registryPath, "utf8"));
assert("save persisted the weights", saved.weights.quality === 0.5 && saved.weights.cost === 0.5, JSON.stringify(saved.weights));

response = await fetch(`${origin}/dsh-aux-models/save`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://evil.example" },
  body: JSON.stringify({ registry: { ...statePayload } }),
});
assert("save rejects cross-origin", response.status === 403, String(response.status));

response = await fetch(`${origin}/dsh-aux-models/route`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({
    provider: "dieqi-img",
    displayName: "蝶祈云 图片",
    api: "openai-completions",
    baseURL: "https://cfimg.dieqiyun.top/v1",
    apiKeyEnv: "DIEQI_IMG_KEY",
    apiKey: "sk-image-test",
    models: [{ id: "gpt-image-2.6-flare" }],
  }),
});
payload = await response.json();
assert("route 200", response.status === 200, JSON.stringify(payload));
assert("route written to config", !!editorRow.options.config.providers["dieqi-img"]);
assert("route key stored", credentials.store.DIEQI_IMG_KEY === "sk-image-test");

response = await fetch(`${origin}/dsh-aux-models/routes`);
payload = await response.json();
assert("routes lists both", payload.providers.map(p => p.id).sort().join(",") === "dieqi,dieqi-img", JSON.stringify(payload.providers.map(p => p.id)));

response = await fetch(`${origin}/dsh-aux-models/route-remove`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ provider: "dieqi" }),
});
payload = await response.json();
assert("removing an in-use route is refused", response.status === 409, JSON.stringify(payload));
assert("refusal names the models", String(payload.error).includes("astra"), String(payload.error));

response = await fetch(`${origin}/dsh-aux-models/route-remove`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ provider: "dieqi-img" }),
});
payload = await response.json();
assert("removing an unused route works", response.status === 200, JSON.stringify(payload));
assert("config no longer has it", editorRow.options.config.providers["dieqi-img"] === undefined);

/* the /test route goes through the stubbed llm.stream */
response = await fetch(`${origin}/dsh-aux-models/test`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ modelId: "astra" }),
});
payload = await response.json();
assert("test route ok", payload.ok === true, JSON.stringify(payload));
assert("test route text", payload.text === "pong", JSON.stringify(payload));
assert("test route priced the call", typeof payload.costUsd === "number" && payload.costUsd > 0, JSON.stringify(payload));

/* the eval console: bank index, guarded start, status, stop */

response = await fetch(`${origin}/dsh-aux-models/eval`);
payload = await response.json();
assert("eval: GET ok", response.status === 200 && payload.ok === true, JSON.stringify(payload).slice(0, 160));
assert("eval: lists banks", Array.isArray(payload.banks) && payload.banks.length >= 1, JSON.stringify(payload.banks ?? []).slice(0, 200));
assert("eval: bundled bank is runnable", payload.banks.some(b => b.id === "bundled" && b.usable && b.tasks > 0), JSON.stringify(payload.banks ?? []).slice(0, 240));
assert("eval: not running initially", payload.running === false, String(payload.running));

response = await fetch(`${origin}/dsh-aux-models/eval/run`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ bank: "/definitely/missing/bank.json", budgetUsd: 1 }),
});
payload = await response.json();
assert("eval: rejects a missing bank", response.status === 400, JSON.stringify(payload));

response = await fetch(`${origin}/dsh-aux-models/eval/run`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://evil.example" },
  body: JSON.stringify({ bank: "bundled" }),
});
assert("eval: rejects cross-origin start", response.status === 403, String(response.status));

response = await fetch(`${origin}/dsh-aux-models/eval/status`);
payload = await response.json();
assert("eval: status ok", response.status === 200 && payload.running === false, JSON.stringify(payload).slice(0, 160));

response = await fetch(`${origin}/dsh-aux-models/eval/stop`, { method: "POST", headers: { "content-type": "application/json" } });
payload = await response.json();
assert("eval: stop without a run is 409", response.status === 409, JSON.stringify(payload));

/* -------------------------------------------------------------------------- */
/* the /dsh-aux-models/balance-prices bridge behind the 价格设置 page */
response = await fetch(`${origin}/dsh-aux-models/balance-prices`);
payload = await response.json();
assert("balance-prices: GET ok", response.status === 200 && payload.ok === true, JSON.stringify(payload).slice(0, 160));
assert("balance-prices: exposes defaults", !!payload.defaults?.["gpt-6-astra"], JSON.stringify(payload.defaults ?? {}).slice(0, 160));

response = await fetch(`${origin}/dsh-aux-models/balance-prices`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ model: "gpt-6-astra", prices: { peak: { cacheMiss: 1.5, cacheHit: 0.15, output: 7.5 } } }),
});
payload = await response.json();
assert("balance-prices: POST saves", response.status === 200 && payload.prices?.peak?.output === 7.5, JSON.stringify(payload));

response = await fetch(`${origin}/dsh-aux-models/balance-prices`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ model: "gpt-6-astra", prices: { peak: { cacheMiss: -1, cacheHit: 0, output: 0 } } }),
});
assert("balance-prices: rejects negative", response.status === 400, String(response.status));

response = await fetch(`${origin}/dsh-aux-models/balance-prices`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ model: "gpt-6-astra", reset: true }),
});
payload = await response.json();
assert("balance-prices: reset clears", response.status === 200 && payload.prices === null, JSON.stringify(payload));

/* -------------------------------------------------------------------------- */
/* tool execution through the registered definitions                          */
/* -------------------------------------------------------------------------- */

const byName = Object.fromEntries(tools.map(t => [t.name, t]));
const listed = await byName.aux_models.execute({}, {});
assert("aux_models lists both models", listed.includes("astra") && listed.includes("mini"), listed);
assert("aux_models shows the learned column", listed.includes("样本"), listed.slice(0, 160));

const routed = await byName.aux_route.execute({ task: "把这段 Python 解析 CSV 的函数改写一下", strategy: "cheap" }, {});
assert("aux_route picked the cheap model", routed.chosen === "mini", JSON.stringify(routed));
assert("aux_route classified as code", routed.taskType === "code_generation", routed.taskType);

const delegated = await byName.aux_delegate.execute({ task: "say pong" }, { sessionId: "s-live", signal: undefined });
assert("aux_delegate answered", delegated.text === "pong", JSON.stringify(delegated));
assert("aux_delegate costed the call", typeof delegated.costUsd === "number" && delegated.costUsd > 0, JSON.stringify(delegated));
assert("aux_delegate auto-routed", String(delegated.routedBy).startsWith("router:"), delegated.routedBy);
assert("aux_delegate passed the route to llm", llmCalls.at(-1).provider === "dieqi" && ["gpt-6-astra", "gpt-mini"].includes(llmCalls.at(-1).model), JSON.stringify(llmCalls.at(-1)));
assert("aux_delegate caps output by default", llmCalls.at(-1).maxTokens === 1600, String(llmCalls.at(-1).maxTokens));

const pinned = await byName.aux_delegate.execute({ task: "say pong", model: "astra" }, { sessionId: "s-live", signal: undefined });
assert("explicit model wins", pinned.model === "dieqi/gpt-6-astra" && llmCalls.at(-1).model === "gpt-6-astra", JSON.stringify(pinned));
assert("explicit model is dearer than the cheap one", pinned.costUsd > delegated.costUsd, `${pinned.costUsd} vs ${delegated.costUsd}`);

/* -------------------------------------------------------------------------- */
/* transient-failure fallback                                                 */
/* -------------------------------------------------------------------------- */

/* strategy=best picks the frontier route; make it fail the way the relay does. */
failingModels.add("gpt-6-astra");
const fellBack = await byName.aux_delegate.execute({ task: "design the retry policy for this API", strategy: "best" }, { sessionId: "s-live", signal: undefined });
assert("fallback answered", fellBack.text === "pong", JSON.stringify(fellBack));
assert("fallback moved to another route", fellBack.model !== "dieqi/gpt-6-astra", fellBack.model);
assert("fallback names the model it left", fellBack.fellBackFrom === "astra", JSON.stringify(fellBack));
assert("fallback explains itself", /failed \(.*502.*\); fell back to /.test(String(fellBack.note)), String(fellBack.note));

/* an explicitly pinned model must NOT silently change (the caller asked for it) */
let pinError = null;
try {
  await byName.aux_delegate.execute({ task: "say pong", model: "astra" }, { sessionId: "s-live", signal: undefined });
} catch (error) {
  pinError = error;
}
assert("explicit model does not fall back", pinError !== null && /502/.test(pinError.message), pinError && pinError.message);

/* no candidate left → the failure surfaces instead of looping */
failingModels.add("gpt-mini");
let bothError = null;
try {
  await byName.aux_delegate.execute({ task: "design the retry policy for this API", strategy: "best" }, { sessionId: "s-live", signal: undefined });
} catch (error) {
  bothError = error;
}
assert("exhausted fallback surfaces the error", bothError !== null && /502|both /.test(bothError.message), bothError && bothError.message);
failingModels.clear();

/* a reasoning route that burned its budget gets one retry with a doubled cap */
truncatedOnce.add("gpt-6-astra");
const headroom = await byName.aux_delegate.execute({ task: "say pong", model: "astra" }, { sessionId: "s-live", signal: undefined });
assert("retries when reasoning ate the whole budget", headroom.text === "pong", JSON.stringify(headroom));
assert("the retry jumps to the ceiling", llmCalls.at(-1).maxTokens === 8000, String(llmCalls.at(-1).maxTokens));

/* the stats file recorded the outcome */
const stats = JSON.parse(readFileSync(join(workDir, "aux-stats.json"), "utf8"));
assert("stats recorded a cell", Object.keys(stats.cells ?? {}).length > 0, JSON.stringify(stats).slice(0, 200));

/* -------------------------------------------------------------------------- */
/* disposal                                                                   */
/* -------------------------------------------------------------------------- */

for (const dispose of disposers) dispose();
assert("dispose unregistered the routes", registeredRoutes.size === 0, `${registeredRoutes.size} left`);

/* -------------------------------------------------------------------------- */
/* headless composition: no webServer, so no Settings page and no HTTP routes  */
/* -------------------------------------------------------------------------- */

const headlessTools = [];
const headlessSections = [];
const headlessCtx = {
  effect(fn) { const dispose = fn(); if (typeof dispose !== "function") throw new Error("effect returned no disposer"); },
  // Cordis defers `inject` until the named services exist; with no webServer the
  // callback must simply never run, and apply() must still finish.
  inject(names, fn) { if (!names.includes("webServer")) fn({}); },
  tools: { register(definition) { headlessTools.push(definition); return () => {}; }, schemas() { return []; }, async execute() { throw new Error("not used"); } },
  systemPrompt: { section(spec) { headlessSections.push(spec); return () => {}; }, async assemble() { return { sections: [] }; } },
  get() { return undefined; },
  llm: { async *stream() { throw new Error("not used"); } },
};
let headlessError = null;
try {
  await plugin.apply(headlessCtx, { registryPath, statsPath: join(workDir, "aux-stats.json") });
} catch (error) {
  headlessError = error;
}
assert("apply survives a headless composition", headlessError === null, headlessError && headlessError.message);
assert("headless still registers the tools", headlessTools.length === 4, `${headlessTools.length} tools`);
assert("headless still registers both prompt sections", headlessSections.length === 2, `${headlessSections.length} sections`);

server.close();
rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\ncheck-live: ${failures.length} failure(s) — ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ncheck-live: ok");
