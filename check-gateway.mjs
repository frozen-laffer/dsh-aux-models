/**
 * Offline check for the gateway-route half of the settings page.
 *
 *   node check-gateway.mjs
 *
 * No network, no DSH runtime: a fake configEditor row and a fake credentials
 * service stand in for the real ones, so the assertions cover exactly the code
 * that writes llm-pi-ai providers and stores api keys.
 */
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_APIS,
  buildRegistry,
  discoverGatewayModels,
  gatewayRoutesView,
  removeGatewayRoute,
  settingsHandlers,
  upsertGatewayRoute,
  validateRouteBody,
  writeRegistryFile,
} from "./index.js";

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

/* -------------------------------------------------------------------------- */
/* fakes                                                                      */
/* -------------------------------------------------------------------------- */

function makeEditor(initialProviders) {
  const row = {
    options: {
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: { providers: structuredClone(initialProviders) },
    },
  };
  const edits = [];
  return {
    row,
    edits,
    entries() {
      return [row];
    },
    configuration() {
      return [{ entry: row, inherited: {}, override: structuredClone(row.options.config) }];
    },
    async edit(entry, change) {
      edits.push("edit");
      entry.options.config = change(entry.options.config, {});
    },
  };
}

function makeCredentials(store = {}) {
  const writes = [];
  return {
    writes,
    async describe(ref) {
      return { configured: typeof store[ref] === "string" && store[ref].length > 0, writable: true, source: "test-store" };
    },
    async resolve(ref) {
      return store[ref] ? { value: store[ref], source: "test-store" } : undefined;
    },
    async set(ref, value) {
      writes.push({ ref, value });
      store[ref] = value;
    },
  };
}

const editor = makeEditor({
  relay: {
    displayName: "中转站 GPT",
    api: "openai-completions",
    baseURL: "https://relay.example.com/v1",
    apiKeyEnv: "RELAY_API_KEY",
    models: [{ id: "aux-large" }],
  },
});
const credentials = makeCredentials({ RELAY_API_KEY: "sk-test" });
const ctx = {
  get(name) {
    if (name === "configEditor") return editor;
    if (name === "credentials") return credentials;
    return undefined;
  },
};

/* -------------------------------------------------------------------------- */
/* view                                                                       */
/* -------------------------------------------------------------------------- */

const view = await gatewayRoutesView(ctx);
check("view available", view.available, true);
check("view entryId", view.entryId, "llm-pi-ai");
check("view apis", view.apis, GATEWAY_APIS);
check("view lists one route", view.providers.map(p => p.id), ["relay"]);
check("route models", view.providers[0].models, ["aux-large"]);
check("credential configured", view.providers[0].credential.configured, true);

const noCtx = await gatewayRoutesView({ get: () => undefined });
check("no configEditor → unavailable", noCtx.available, false);
assert("no configEditor → reason", typeof noCtx.reason === "string" && noCtx.reason.length > 0, JSON.stringify(noCtx.reason));

/* -------------------------------------------------------------------------- */
/* validation                                                                 */
/* -------------------------------------------------------------------------- */

const good = {
  provider: "relay-img",
  displayName: "中转站 图片",
  api: "openai-completions",
  baseURL: "https://img.relay.example.com/v1/",
  apiKeyEnv: "RELAY_IMG_KEY",
  models: [{ id: "img-model-a" }],
};
check("valid body has no problems", validateRouteBody(good).problems, []);
check("baseURL trailing slash trimmed", validateRouteBody(good).value.baseURL, "https://img.relay.example.com/v1");
check("model defaults filled", validateRouteBody(good).value.models[0].contextWindow, 262144);

check("bad provider rejected", validateRouteBody({ ...good, provider: "Bad Id" }).problems.length > 0, true);
check("bad api rejected", validateRouteBody({ ...good, api: "openai-chat" }).problems.length > 0, true);
check("bad baseURL rejected", validateRouteBody({ ...good, baseURL: "img.relay.example.com" }).problems.length > 0, true);
check("bad apiKeyEnv rejected", validateRouteBody({ ...good, apiKeyEnv: "relay img key" }).problems.length > 0, true);
check("no models rejected", validateRouteBody({ ...good, models: [] }).problems.length > 0, true);

/* -------------------------------------------------------------------------- */
/* upsert                                                                     */
/* -------------------------------------------------------------------------- */

const created = await upsertGatewayRoute(ctx, { ...good, apiKey: "sk-img-test" });
check("upsert status", created.status, 200);
check("upsert provider", created.body.provider, "relay-img");
check("upsert models", created.body.models, ["img-model-a"]);
check("key stored in credentials", credentials.writes.map(w => w.ref), ["RELAY_IMG_KEY"]);
check("editor.edit called once", editor.edits.length, 1);
check("provider persisted", editor.row.options.config.providers["relay-img"].baseURL, "https://img.relay.example.com/v1");
check("existing provider kept", editor.row.options.config.providers["relay"].apiKeyEnv, "RELAY_API_KEY");
check("persisted models are objects with input", editor.row.options.config.providers["relay-img"].models[0].input, ["text"]);

const withoutKey = await upsertGatewayRoute(ctx, { ...good, provider: "relay-img2", apiKeyEnv: "NO_SUCH_KEY" });
check("upsert without key works", withoutKey.status, 200);
check("no extra credential write", credentials.writes.length, 1);

const bad = await upsertGatewayRoute(ctx, { ...good, provider: "9bad" });
check("upsert rejects bad provider", bad.status, 400);
assert("reject message mentions id grammar", String(bad.body.error).includes("路由 id"), String(bad.body.error));

const noEditor = await upsertGatewayRoute({ get: () => undefined }, good);
check("upsert without configEditor", noEditor.status, 503);

/* -------------------------------------------------------------------------- */
/* discover                                                                   */
/* -------------------------------------------------------------------------- */

const noKey = await discoverGatewayModels(ctx, { baseURL: "https://relay.example.com/v1", api: "openai-completions", apiKeyEnv: "MISSING_KEY" });
check("discover without key", noKey.status, 400);
assert("discover says which env var", String(noKey.body.error).includes("MISSING_KEY"), String(noKey.body.error));

const resolvedKey = await discoverGatewayModels(ctx, { baseURL: "not-a-url", api: "openai-completions", apiKeyEnv: "RELAY_API_KEY" });
check("discover bad url", resolvedKey.status, 400);

const blank = await discoverGatewayModels(ctx, {});
check("discover empty body", blank.status, 400);

/* -------------------------------------------------------------------------- */
/* routes                                                                     */
/* -------------------------------------------------------------------------- */

function makeRes() {
  return {
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
}
function makeReq(method, { headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = Object.assign({ host: "127.0.0.1:5808", origin: "http://127.0.0.1:5808" }, headers);
  return req;
}

const handlers = settingsHandlers(ctx, { registryPath: "unused.json" });
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

let res = await call("/dsh-aux-models/routes", "GET");
check("routes: status", res.status, 200);
check("routes: one provider", JSON.parse(res.body).providers.map(p => p.id), ["relay", "relay-img", "relay-img2"]);

res = await call("/dsh-aux-models/routes", "POST");
check("routes: POST rejected", res.status, 405);

res = await call("/dsh-aux-models/route", "POST", { headers: { origin: "http://evil.example" }, body: good });
check("route: cross-origin rejected", res.status, 403);

res = await call("/dsh-aux-models/route", "GET");
check("route: GET rejected", res.status, 405);

res = await call("/dsh-aux-models/route", "POST", { body: { ...good, provider: "x1", models: [] } });
check("route: empty models rejected", res.status, 400);

res = await call("/dsh-aux-models/route", "POST", { body: { ...good, provider: "fresh", displayName: "Fresh", apiKey: "" } });
check("route: accepted", res.status, 200);
check("route: response models", JSON.parse(res.body).models, ["img-model-a"]);

res = await call("/dsh-aux-models/discover", "GET");
check("discover: GET rejected", res.status, 405);

res = await call("/dsh-aux-models/discover", "POST", { body: { baseURL: "", api: "openai-completions" } });
check("discover: empty baseURL rejected", res.status, 400);

res = await call("/dsh-aux-models/route-remove", "POST", { body: { provider: "nope" } });
check("remove: unknown provider", res.status, 404);

res = await call("/dsh-aux-models/route-remove", "POST", { headers: { origin: "http://evil.example" }, body: { provider: "relay-img" } });
check("remove: cross-origin rejected", res.status, 403);

res = await call("/dsh-aux-models/route-remove", "GET", { body: { provider: "relay-img" } });
check("remove: GET rejected", res.status, 405);

res = await call("/dsh-aux-models/route-remove", "POST", { body: { provider: "Bad Id" } });
check("remove: bad id rejected", res.status, 400);

/* an auxiliary model that still points at the route blocks the delete */
const workDir = mkdtempSync(join(tmpdir(), "aux-gateway-"));
const registryPath = join(workDir, "aux-models.json");
writeRegistryFile(
  { registryPath },
  buildRegistry({
    version: 2,
    channels: [
      {
        id: "chan-legacy",
        provider: "relay-img2",
        multiplier: 1,
        cacheHitRate: 0,
        stability: 8,
        enabled: true,
        models: [{ id: "gamma", model: "aux-lite-56", qualityTier: 3, strengths: ["general"] }],
      },
    ],
  }),
);
const wired = settingsHandlers(ctx, { registryPath });
const previous = handlers["/dsh-aux-models/route-remove"];
handlers["/dsh-aux-models/route-remove"] = wired["/dsh-aux-models/route-remove"];

res = await call("/dsh-aux-models/route-remove", "POST", { body: { provider: "relay-img2" } });
check("remove: route in use rejected", res.status, 409);
assert("remove: says which models", String(JSON.parse(res.body).error).includes("gamma"), res.body);

res = await call("/dsh-aux-models/route-remove", "POST", { body: { provider: "relay-img" } });
check("remove: unused route goes", res.status, 200);
check("remove: reports remaining", JSON.parse(res.body).providers, ["relay", "relay-img2", "fresh"]);
check("remove: dropped from config", editor.row.options.config.providers["relay-img"], undefined);
check("remove: credential note", typeof JSON.parse(res.body).note, "string");

res = await call("/dsh-aux-models/route-remove", "POST", { body: { provider: "relay-img" } });
check("remove: second attempt is 404", res.status, 404);

handlers["/dsh-aux-models/route-remove"] = previous;
rmSync(workDir, { recursive: true, force: true });

/* direct call: no configEditor → 503 */
const noEditorRemove = await removeGatewayRoute({ get: () => undefined }, { provider: "relay" }, { registryPath: "unused.json" });
check("remove: without configEditor", noEditorRemove.status, 503);

/* -------------------------------------------------------------------------- */

if (failures.length > 0) {
  console.log(`\ncheck-gateway: ${failures.length} failure(s) — ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ncheck-gateway: ok");
