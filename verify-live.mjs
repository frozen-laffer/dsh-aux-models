/**
 * verify-live.mjs — the one command to run *after* restarting the desktop client.
 *
 * Everything else in this repo runs offline against stubs; this script talks to
 * the live harness, so it answers the only question that matters once the app is
 * back up: is the plugin's host half actually mounted, with a usable registry?
 *
 *   node verify-live.mjs                      # http://127.0.0.1:5808
 *   node verify-live.mjs http://127.0.0.1:4302
 *
 * Read-only by design: it never saves the registry, never creates or deletes a
 * route, and never spends money on a model call. Exit code 0 = all green.
 *
 * The browser half cannot be checked from here (the GUI serves its boot payload
 * behind session auth), so the last line reminds you what to look at by eye.
 */

const origin = (process.argv[2] || "http://127.0.0.1:3070").replace(/\/+$/, "");
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

// node:http instead of fetch on purpose: this machine exports HTTP_PROXY to a
// dead 127.0.0.1:7890 with NODE_USE_ENV_PROXY=1, and undici then fails even for
// 127.0.0.1 with a bare "fetch failed".
async function call(path, init = {}) {
  const url = new URL(origin + path);
  const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http");
  const headers = { ...(init.headers || {}) };
  const body = init.body;
  if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
  return await new Promise((resolve, reject) => {
    const req = mod.request(
      { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: init.method || "GET", headers },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error("timed out after 15000ms")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postJson(body, headers) {
  return { method: "POST", headers: { "content-type": "application/json", ...(headers || {}) }, body: JSON.stringify(body) };
}

/* -------------------------------------------------------------------------- */

let state = null;
try {
  const response = await call("/dsh-aux-models/state");
  state = response.body;
  record("host half is mounted (/state)", response.status === 200,
    response.status === 404
      ? "404 — the plugin row is not loaded (restart the client, or check the log for a parse/BOM error)"
      : `HTTP ${response.status}`);
  if (response.status === 200 && state) {
    const channels = Array.isArray(state.channels) ? state.channels : [];
    const models = channels.flatMap(channel => (Array.isArray(channel.models) ? channel.models : []));
    record("registry has channels", channels.length > 0, channels.map(channel => channel.id).join(", "));
    record("registry has models", models.length > 0, `${models.length}: ${models.map(model => model.id).join(", ")}`);
    const priced = models.find(model => model.effective && Number.isFinite(model.effective.inputPerM));
    record("registry exposes effective prices", Boolean(priced),
      priced ? `${priced.id} → $${priced.effective.inputPerM.toFixed(3)}/M in, $${priced.effective.outputPerM.toFixed(3)}/M out` : "no model carries an effective price");
    record("registry exposes seven task types", Array.isArray(state.taskTypes) && state.taskTypes.length === 7,
      Array.isArray(state.taskTypes) ? state.taskTypes.length + " types" : "missing");
    record("statistics path is reported", typeof state.statsPath === "string", state.statsPath);
  }
} catch (error) {
  record("host half is mounted (/state)", false, `cannot reach ${origin} — ${error.message}`);
}

try {
  const response = await call("/dsh-aux-models/routes");
  const body = response.body;
  record("gateway routes view answers", response.status === 200, `HTTP ${response.status}`);
  record("configEditor is reachable", body?.available === true, body?.available ? `${body.providers.length} provider route(s)` : `unavailable: ${body?.reason}`);
  if (body?.apis) record("gateway view lists the three APIs", body.apis.length === 3, body.apis.join(", "));
} catch (error) {
  record("gateway routes view answers", false, error.message);
}

try {
  const response = await call("/dsh-aux-models/preview", postJson({ task: "写一个 Python 函数解析 CSV" }));
  const body = response.body;
  record("routing preview answers", response.status === 200 && body?.ok === true, response.status === 200 ? "" : `HTTP ${response.status}`);
  if (body?.ok) {
    record("preview classifies code", body.taskType === "code_generation", body.taskType);
    record("preview ranks candidates", Array.isArray(body.ranking) && body.ranking.length > 0, `${body.ranking?.length ?? 0} candidate(s)`);
    record("preview names a winner", Boolean(body.chosen && body.chosen.id),
      body.chosen ? `${body.chosen.id} (est. $${Number(body.estimate?.usd ?? 0).toFixed(4)})` : "no candidate fits the budget");
  }
} catch (error) {
  record("routing preview answers", false, error.message);
}

try {
  /* a cross-origin write must be refused before anything is written */
  const response = await call("/dsh-aux-models/save", postJson({ registry: {} }, { origin: "https://evil.example" }));
  record("cross-origin write is refused", response.status === 403, `HTTP ${response.status}`);
} catch (error) {
  record("cross-origin write is refused", false, error.message);
}

try {
  const response = await call("/dsh-aux-models/save", { method: "GET" });
  record("write routes reject GET", response.status === 405, `HTTP ${response.status}`);
} catch (error) {
  record("write routes reject GET", false, error.message);
}

try {
  /* an unknown model id must fail loudly instead of silently falling back */
  const response = await call("/dsh-aux-models/test", postJson({ modelId: "does-not-exist" }));
  const body = response.body;
  record("unknown model is rejected by /test", response.status === 400 || body?.ok === false, `HTTP ${response.status}${body?.error ? ` — ${body.error}` : ""}`);
} catch (error) {
  record("unknown model is rejected by /test", false, error.message);
}

/* -------------------------------------------------------------------------- */

const failed = results.filter(item => !item.ok);
console.log("");
if (failed.length === 0) {
  console.log(`verify-live: ok — ${results.length} checks against ${origin}`);
  console.log("by eye: 设置 → 辅助模型 里有「辅助模型」导航项，网关面板能列出现有 provider。");
} else {
  console.log(`verify-live: ${failed.length}/${results.length} failed — ${failed.map(item => item.name).join(", ")}`);
  process.exit(1);
}
