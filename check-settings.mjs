/**
 * Offline check for the settings page host half (no DSH runtime needed).
 *
 *   node check-settings.mjs
 *
 * Copies the live registry to a temp file, renders the state view, simulates the
 * client's strip-and-save round trip, and verifies the file survives it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildRegistry, loadRegistry, registryStateView, settingsHandlers, writeRegistryFile } from "./index.js";

const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
  if (!ok) failures.push(label);
}
function assert(label, condition, detail = "") {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` ${detail}`}`);
  if (!condition) failures.push(label);
}

const dir = mkdtempSync(join(tmpdir(), "aux-settings-"));
const registryPath = join(dir, "aux-models.json");
// A fixed fixture, not the live registry: the assertions below pin exact channel
// and model ids, and the user's registry legitimately grows (extra channels such
// as chan-b). check-roundtrip.mjs is the one that round-trips the real file.
const FIXTURE = {
  version: 2,
  defaultModel: "gamma",
  weights: { quality: 0.7, cost: 0.3 },
  channels: [{
    id: "chan-legacy",
    name: "fixture",
    provider: "relay",
    multiplier: 0.14,
    cacheHitRate: 0.8,
    stability: 5,
    enabled: true,
    models: [
      { id: "alpha", label: "Aux Large", model: "aux-large", qualityTier: 3, strengths: ["code_generation"], supportsTools: true, pricing: { inputPerM: 10, outputPerM: 50 } },
      { id: "gamma", label: "Aux Lite 5.6", model: "aux-lite-56", qualityTier: 3, strengths: ["writing"], supportsTools: true, pricing: { inputPerM: 10, outputPerM: 50 } },
      { id: "aux-audit", label: "Codex Auto Review", model: "aux-review", qualityTier: 2, strengths: ["code_understanding"], supportsTools: false, pricing: { inputPerM: 10, outputPerM: 50 } },
    ],
  }],
};
writeFileSync(registryPath, JSON.stringify(FIXTURE, null, 2) + "\n", "utf8");
const config = { registryPath, statsPath: join(dir, "aux-stats.json") };

const state = await registryStateView(config);
check("channels", state.channels.length, 1);
check("models in channel", state.channels[0].models.map(m => m.id), ["alpha", "gamma", "aux-audit"]);
assert("state.path is the config path", state.path === registryPath, state.path);
assert("task types", state.taskTypes.length === 7, JSON.stringify(state.taskTypes));
assert("weights surfaced", Number(state.weights.quality) === 0.7 && Number(state.weights.cost) === 0.3, JSON.stringify(state.weights));

const alpha = state.channels[0].models.find(m => m.id === "alpha");
assert("effective price known", alpha.effective.known === true, JSON.stringify(alpha.effective));
assert("effective input = 10 * 0.14 * cache mix", Math.abs(alpha.effective.inputPerM - 0.392) < 1e-9, String(alpha.effective.inputPerM));
assert("effective output = 10 * ... no: 50 * 0.14", Math.abs(alpha.effective.outputPerM - 7) < 1e-9, String(alpha.effective.outputPerM));
assert("learned quality for every task type", Object.keys(alpha.quality).length === 7, JSON.stringify(alpha.quality));
assert("health present", alpha.health && typeof alpha.health.breaker === "boolean", JSON.stringify(alpha.health));
assert("totals present", Number.isFinite(state.totals.calls) && Number.isFinite(state.totals.usd), JSON.stringify(state.totals));

// Simulate what client.js sends back: drop server-computed fields, keep the form.
const roundTrip = {
  version: 2,
  defaultModel: state.defaultModel,
  defaultSystem: state.defaultSystem,
  weights: state.weights,
  routing: state.routing,
  channels: state.channels.map(channel => ({
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    multiplier: channel.multiplier,
    cacheHitRate: channel.cacheHitRate,
    stability: channel.stability,
    enabled: channel.enabled,
    models: channel.models.map(model => ({
      id: model.id,
      label: model.label,
      model: model.model,
      mapsTo: model.mapsTo,
      qualityTier: model.qualityTier,
      strengths: model.strengths,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportsTools: model.supportsTools,
      enabled: model.enabled,
      notes: model.notes,
      pricing: {
        inputPerM: model.pricing && model.pricing.inputPerM,
        outputPerM: model.pricing && model.pricing.outputPerM,
        source: (model.pricing && model.pricing.source) || "manual",
      },
    })),
  })),
};

const probe = buildRegistry(roundTrip, registryPath);
assert("round trip keeps three models", probe.models.length === 3, String(probe.models.length));

const written = writeRegistryFile(config, roundTrip);
assert("writeRegistryFile returned the path", written === registryPath, written);
const onDisk = JSON.parse(readFileSync(registryPath, "utf8"));
check("on disk: version", onDisk.version, 2);
check("on disk: model ids", onDisk.channels[0].models.map(m => m.id), ["alpha", "gamma", "aux-audit"]);
check("on disk: no computed fields", Object.keys(onDisk.channels[0].models[0]).includes("quality"), false);

const reloaded = await loadRegistry(config);
assert("reload sees the edited registry", reloaded.models.length === 3, String(reloaded.models.length));

// A model-id edit must be visible immediately (the page's whole purpose).
roundTrip.channels[0].models[1].model = "aux-lite-56e";
writeRegistryFile(config, roundTrip);
const edited = await loadRegistry(config);
const gamma = edited.models.find(m => m.id === "gamma");
check("edited model id persisted", gamma && gamma.model, "aux-lite-56e");

// Empty registry must be rejected by the route before it truncates the file.
let rejected = false;
try {
  const empty = buildRegistry({ version: 2, channels: [{ id: "c", name: "c", provider: "relay", models: [] }] }, registryPath);
  rejected = empty.models.length === 0;
} catch {
  rejected = true;
}
assert("empty registry rejected", rejected);

/* -------------------------------------------------------------------------- */
/* route handlers (same code path the browser hits)                            */
/* -------------------------------------------------------------------------- */

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      if (body !== undefined) this.body = String(body);
    },
  };
  return res;
}

function makeReq(method, { headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = Object.assign({ host: "127.0.0.1:5808", origin: "http://127.0.0.1:5808" }, headers);
  return req;
}

const handlers = settingsHandlers({ get: () => undefined }, config);
check("routes", Object.keys(handlers).sort(), [
  "/dsh-aux-models/balance-prices",
  "/dsh-aux-models/discover",
  "/dsh-aux-models/eval",
  "/dsh-aux-models/eval/run",
  "/dsh-aux-models/eval/status",
  "/dsh-aux-models/eval/stop",
  "/dsh-aux-models/preview",
  "/dsh-aux-models/route",
  "/dsh-aux-models/route-remove",
  "/dsh-aux-models/routes",
  "/dsh-aux-models/save",
  "/dsh-aux-models/state",
  "/dsh-aux-models/test",
]);

async function call(path, method, options) {
  const res = makeRes();
  await handlers[path](makeReq(method, options), res);
  return res;
}

let res = await call("/dsh-aux-models/state", "GET");
check("state: status", res.status, 200);
check("state: content type", res.headers["Content-Type"], "application/json; charset=utf-8");
const stateBody = JSON.parse(res.body);
assert("state: one channel", stateBody.channels.length === 1);
assert("state: three models", stateBody.channels[0].models.length === 3);

res = await call("/dsh-aux-models/state", "POST");
check("state: POST rejected", res.status, 405);

res = await call("/dsh-aux-models/save", "POST", { body: { registry: roundTrip } });
check("save: valid registry accepted", res.status, 200);

res = await call("/dsh-aux-models/save", "POST", { headers: { origin: "http://evil.example" }, body: { registry: roundTrip } });
check("save: cross-origin rejected", res.status, 403);

res = await call("/dsh-aux-models/save", "POST", { body: { nope: true } });
check("save: bad body rejected", res.status, 400);

res = await call("/dsh-aux-models/save", "POST", { body: { registry: { version: 2, channels: [{ id: "c", name: "c", provider: "relay", models: [] }] } } });
check("save: model-less registry rejected", res.status, 400);

const editedForRoute = JSON.parse(JSON.stringify(roundTrip));
editedForRoute.channels[0].models[0].label = "Saved through the route";
res = await call("/dsh-aux-models/save", "POST", { body: { registry: editedForRoute } });
check("save: valid registry accepted", res.status, 200);
const savedBody = JSON.parse(res.body);
assert("save: returns written path", savedBody.path === registryPath, savedBody.path);
assert("save: returns model ids", savedBody.models.length === 3, JSON.stringify(savedBody.models));
const afterSave = await loadRegistry(config);
assert("save: label persisted", afterSave.models.find(m => m.id === "alpha").label === "Saved through the route", afterSave.models.find(m => m.id === "alpha").label);

res = await call("/dsh-aux-models/test", "POST", { body: {} });
check("test: missing modelId rejected", res.status, 400);

res = await call("/dsh-aux-models/test", "GET");
check("test: GET rejected", res.status, 405);

res = await call("/dsh-aux-models/preview", "POST", { body: {} });
check("preview: missing task rejected", res.status, 400);

res = await call("/dsh-aux-models/preview", "GET");
check("preview: GET rejected", res.status, 405);

res = await call("/dsh-aux-models/preview", "POST", {
  headers: { origin: "http://evil.example" },
  body: { task: "把这段 Python 解析 CSV 的函数改写一下" },
});
check("preview: cross-origin rejected", res.status, 403);

res = await call("/dsh-aux-models/preview", "POST", { body: { task: "把这段 Python 解析 CSV 的函数改写一下", strategy: "cheap" } });
check("preview: status", res.status, 200);
const previewBody = JSON.parse(res.body);
assert("preview: classifies code", previewBody.taskType === "code_generation", previewBody.taskType);
assert("preview: names a winner", typeof previewBody.chosen?.id === "string", JSON.stringify(previewBody.chosen));
assert("preview: ranks every enabled model", previewBody.ranking.length === 3, JSON.stringify(previewBody.ranking.map(r => r.id)));
assert("preview: prices the call", previewBody.estimate && previewBody.estimate.usd > 0, JSON.stringify(previewBody.estimate));
assert("preview: cheap strategy tilts to cost", previewBody.weights.cost === 0.75, JSON.stringify(previewBody.weights));

rmSync(dir, { recursive: true, force: true });
if (failures.length > 0) {
  console.log(`\ncheck-settings: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-settings: ok");
