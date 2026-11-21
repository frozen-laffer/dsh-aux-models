// Run the eval task bank against every enabled auxiliary route, directly over HTTP.
// Usage: node eval-run.mjs [--plan] [--models=a,b] [--tasks=x,y] [--budget=2.50] [--concurrency=4]
import { readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME || join(HERE, "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PLAN = args.includes("--plan");
const MODEL_FILTER = opt("models", "").split(",").filter(Boolean);
const TASK_FILTER = opt("tasks", "").split(",").filter(Boolean);
const BUDGET = Number(opt("budget", "2.50"));
const CONCURRENCY = Number(opt("concurrency", "24"));
const TIMEOUT = Number(opt("timeout", "60000"));
const REUSE = args.includes("--reuse");
const REUSE_MIN = Number(opt("reuse-min", "60"));

// ---- registry -------------------------------------------------------------
const registry = JSON.parse(readFileSync(join(HOME, "aux-models.json"), "utf8"));
const routes = [];
for (const ch of registry.channels ?? []) {
  for (const m of ch.models ?? []) {
    if (m.enabled === false) continue;
    if (MODEL_FILTER.length && !MODEL_FILTER.includes(m.id)) continue;
    const price = m.pricing ?? {};
    const hit = Number.isFinite(ch.cacheHitRate) ? ch.cacheHitRate : 0;
    const mult = Number.isFinite(ch.multiplier) ? ch.multiplier : 1;
    routes.push({
      id: m.id, provider: ch.provider, model: m.model, label: m.label ?? m.id,
      inPerM: (price.inputPerM ?? 0) * mult * ((1 - hit) + hit * 0.1),
      outPerM: (price.outputPerM ?? 0) * mult,
      supportsTools: m.supportsTools !== false,
    });
  }
}

// ---- providers from the profile patch -------------------------------------
const patch = readFileSync(join(HOME, "profiles/desktop/cordis.patch.yml"), "utf8").split(/\r?\n/);
const providers = {};
for (let i = 0; i < patch.length; i++) {
  const m = /^ {6}([a-z0-9-]+):\s*$/.exec(patch[i]);
  if (!m) continue;
  const block = [];
  for (let j = i + 1; j < patch.length && /^ {8}\S/.test(patch[j]); j++) block.push(patch[j].trim());
  const field = (k) => {
    const line = block.find((l) => l.startsWith(`${k}: `));
    return line ? line.slice(k.length + 2).trim() : undefined;
  };
  const api = field("api");
  if (!api) continue;
  providers[m[1]] = { api, baseURL: field("baseURL"), apiKeyEnv: field("apiKeyEnv") };
}

// ---- credentials ----------------------------------------------------------
const creds = {};
for (const line of readFileSync(join(HOME, ".credentials.yaml"), "utf8").split(/\r?\n/)) {
  const m = /^ {2}([A-Z0-9_]+):\s*(\S.*)$/.exec(line);
  if (m) creds[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// ---- tasks ----------------------------------------------------------------
const BANK_PATH = opt("bank", join(HERE, "aux-eval-tasks.json"));
const STATE_PATH = opt("state", "");
const bank = JSON.parse(readFileSync(BANK_PATH, "utf8"));
const tasks = (bank.tasks ?? []).filter((t) => !TASK_FILTER.length || TASK_FILTER.includes(t.id));

// ---- http -----------------------------------------------------------------
const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 4, keepAliveMsecs: 15000 });

function post(url, headers, body, timeoutMs = TIMEOUT) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const started = Date.now();
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname + u.search, method: "POST", agent,
        headers: { ...headers, "content-type": "application/json", "content-length": payload.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started }));
      });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, text: `ERR ${e.message}`, ms: Date.now() - started }));
    req.write(payload);
    req.end();
  });
}

function pickText(provider, body) {
  try {
    const j = JSON.parse(body);
    if (provider.api === "anthropic-messages") {
      return { text: (j.content ?? []).map((c) => c.text ?? "").join(""), usage: { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 } };
    }
    const msg = j.choices?.[0]?.message ?? {};
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    return { text, usage: { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 } };
  } catch {
    return { text: "", usage: { in: 0, out: 0 } };
  }
}

// ---- scoring --------------------------------------------------------------
function scoreNumeric(task, text) {
  const nums = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const tol = task.judge.tolerance ?? 0;
  const ok = task.judge.expect.every((want) => nums.some((n) => Math.abs(n - want) <= tol));
  return { ok, detail: nums.slice(0, 6).join(",") };
}

function scoreChecklist(task, text) {
  const hay = text.toLowerCase();
  const hit = (needle) => {
    const rx = /^\/(.*)\/([a-z]*)$/.exec(needle);
    if (rx) return new RegExp(rx[1], rx[2] || "i").test(text);
    return hay.includes(needle.toLowerCase());
  };
  const hits = (task.judge.must ?? []).filter(hit);
  const bad = (task.judge.mustNot ?? []).filter(hit);
  const ok = hits.length >= (task.judge.minHits ?? 1) && bad.length === 0;
  return { ok, detail: `${hits.length}/${(task.judge.must ?? []).length}${bad.length ? ` violation:${bad.length}` : ""}` };
}

function scoreAssert(task, text) {
  const fence = /```(?:python)?\s*([\s\S]*?)```/g;
  let code = "";
  for (const m of text.matchAll(fence)) if (/def\s+\w+\s*\(/.test(m[1])) code = m[1];
  if (!code) {
    // accept bare code, including uniformly indented answers: dedent from the first def
    const at = text.search(/^[ \t]*def\s+\w+\s*\(/m);
    if (at >= 0) {
      const tail = text.slice(at);
      const indent = /^([ \t]*)/.exec(tail)[1].length;
      code = indent ? tail.split(/\r?\n/).map((l) => l.slice(indent)).join("\n") : tail;
    }
  }
  if (!code) return { ok: false, detail: "no python code" };
  const dir = mkdtempSync(join(tmpdir(), "aux-eval-"));
  try {
    const harness = [
      code,
      "import json",
      "cases = " + JSON.stringify(task.judge.cases),
      "passed = 0",
      "for c in cases:",
      "    try:",
      "        got = eval(c['call'])",
      "        ok = ('raises' in c and False) or ('expect' in c and got == c['expect'])",
      "    except Exception as e:",
      "        ok = c.get('raises') == type(e).__name__",
      "    passed += 1 if ok else 0",
      "print(json.dumps({'passed': passed, 'total': len(cases)}))",
    ].join("\n");
    const file = join(dir, "probe.py");
    writeFileSync(file, harness, "utf8");
    const out = execFileSync("python", [file], { timeout: 20000, encoding: "utf8" });
    const r = JSON.parse(out.trim().split(/\r?\n/).pop());
    return { ok: r.passed === r.total, detail: `${r.passed}/${r.total}` };
  } catch (e) {
    return { ok: false, detail: "run failed: " + String(e.message).slice(0, 60) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function score(task, text) {
  const j = task.judge ?? {};
  if (j.kind === "numeric") return scoreNumeric(task, text);
  if (j.kind === "checklist") return scoreChecklist(task, text);
  if (j.kind === "assert") return scoreAssert(task, text);
  return { ok: null, detail: "rubric: unscored" };
}

// ---- run ------------------------------------------------------------------
async function runOne(route, task) {
  const p = providers[route.provider];
  if (!p) return { route, task, error: `no provider ${route.provider}` };
  const key = creds[p.apiKeyEnv];
  if (!key) return { route, task, error: `missing credential ${p.apiKeyEnv}` };
  if (task.judge?.requiresTools) return { route, task, skipped: "needs tools" };
  const body = p.api === "anthropic-messages"
    ? { model: route.model, max_tokens: task.maxTokens, messages: [{ role: "user", content: task.prompt }] }
    : { model: route.model, max_tokens: task.maxTokens, messages: [{ role: "user", content: task.prompt }] };
  const headers = p.api === "anthropic-messages"
    ? { "anthropic-version": "2023-06-01", "x-api-key": key }
    : { authorization: `Bearer ${key}` };
  const url = p.api === "anthropic-messages" ? `${p.baseURL.replace(/\/+$/, "")}/v1/messages` : `${p.baseURL.replace(/\/+$/, "")}/chat/completions`;
  let res = await post(url, headers, body);
  for (let attempt = 0; attempt < 2; attempt++) {
    const transient = res.status === 0 || [429, 500, 502, 503, 504].includes(res.status);
    if (res.status === 200 || !transient) break;
    await new Promise((r) => setTimeout(r, 1500));
    res = await post(url, headers, body);
  }
  if (res.status !== 200) return { route, task, error: `HTTP ${res.status}: ${res.text.slice(0, 160)}`, ms: res.ms };
  const { text, usage } = pickText(p, res.text);
  const verdict = score(task, text);
  const cost = (usage.in * route.inPerM + usage.out * route.outPerM) / 1e6;
  return {
    route, task, ok: verdict.ok, detail: verdict.detail, ms: res.ms, usage, cost,
    chars: text.length,
    answer: task.judge?.kind === "checklist" ? text.slice(0, 1500) : undefined,
    snippet: verdict.ok ? undefined : text.replace(/\s+/g, " ").slice(0, 220),
  };
}

// ---- judge: only the cells a checklist regex marked as failures -------------
const JUDGE_MODEL = opt("judge", "cr05");
const judgeRoute = routes.find((r) => r.id === JUDGE_MODEL);

async function judgeChecklist(cell) {
  const p = providers[judgeRoute.provider];
  const must = cell.task.judge.must ?? [];
  const prompt = [
    "你是严格的评分员。下面给出若干条判据，以及一个候选回答。",
    "逐条判断该回答是否**实质**满足该判据（同义、意译、举一反三都算满足；只是沾边、空泛承诺不算）。",
    "只输出 JSON，格式 {\"items\":[1,0,1]}，长度必须等于判据条数，1=满足，0=不满足。",
    "",
    "判据：",
    ...must.map((m, i) => `${i + 1}. ${m}`),
    "",
    "候选回答：",
    '"""',
    cell.answer,
    '"""',
  ].join("\n");
  const body = { model: judgeRoute.model, max_tokens: 60, temperature: 0, messages: [{ role: "user", content: prompt }] };
  const key = creds[p.apiKeyEnv];
  const res = await post(`${p.baseURL.replace(/\/+$/, "")}/chat/completions`, { authorization: `Bearer ${key}` }, body);
  if (res.status !== 200) return { error: `judge HTTP ${res.status}` };
  const { text, usage } = pickText(p, res.text);
  const m = /\[[01](?:\s*,\s*[01])*\]/.exec(text);
  if (!m) return { error: "judge no JSON" };
  const items = JSON.parse(m[0]);
  const covered = items.filter(Boolean).length;
  const cost = (usage.in * judgeRoute.inPerM + usage.out * judgeRoute.outPerM) / 1e6;
  return { covered, items, cost };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const pairs = [];
for (const route of routes) for (const task of tasks) pairs.push({ route, task });

// --reuse: keep answers from the newest results file if it is fresh enough
const cached = new Map();
if (REUSE) {
  const dir = "F:/DS_WorkSpace/eval-build";
  const files = readdirSync(dir).filter((f) => /^results-.*\.json$/.test(f))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (files.length && Date.now() - files[0].m < REUSE_MIN * 60000) {
    const prev = JSON.parse(readFileSync(join(dir, files[0].f), "utf8"));
    for (const r of prev.results ?? []) if (!r.error && r.ok !== undefined) cached.set(`${r.route.id}|${r.task.id}`, r);
    console.log(`reuse: ${cached.size} cells from ${files[0].f} (${Math.round((Date.now() - files[0].m) / 1000)}s old)`);
  }
}

const estimate = pairs.reduce((sum, { route, task }) => sum + ((4600 + task.prompt.length / 3) * route.inPerM + task.maxTokens * 0.45 * route.outPerM) / 1e6, 0);
console.log(JSON.stringify({ routes: routes.length, tasks: tasks.length, calls: pairs.length, estimateUsd: Number(estimate.toFixed(3)) }, null, 2));
if (PLAN) {
  for (const r of routes) console.log(`  ${r.id.padEnd(12)} ${r.provider.padEnd(12)} ${String(r.inPerM.toFixed(2)).padStart(6)}/${String(r.outPerM.toFixed(2)).padEnd(6)}`);
  process.exit(0);
}
if (estimate > BUDGET) {
  console.log(`estimate ${estimate.toFixed(2)} exceeds budget ${BUDGET}; raise --budget to proceed`);
  process.exit(1);
}

const state = {
  version: 1,
  startedAt: new Date().toISOString(),
  bank: BANK_PATH,
  total: 0,
  done: 0,
  pct: 0,
  current: null,
  finished: false,
  error: null,
  spentUsd: 0,
  results: [],
};
function writeState(patch) {
  if (!STATE_PATH) return;
  Object.assign(state, patch);
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
  } catch { /* progress is best-effort */ }
}
writeState({ total: pairs.length, startedAt: state.startedAt });

const todo = pairs.filter(({ route, task }) => !cached.has(`${route.id}|${task.id}`));
const total = todo.length;
let done = 0;
const t0 = Date.now();
const fresh = await mapLimit(todo, CONCURRENCY, async ({ route, task }) => {
  try {
    const r = await runOne(route, task);
    done++;
    const pct = Math.round((done / Math.max(1, total)) * 100);
    const eta = done > 1 ? Math.round(((Date.now() - t0) / done) * (total - done) / 1000) : 0;
    process.stderr.write(`${r.error ? "!" : "."} ${done}/${total} ${pct}% eta ${eta}s ${route.id}/${task.id}${r.error ? ` ${r.error}` : ""}\n`);
    writeState({
      done,
      pct,
      spentUsd: Number(state.results.reduce((sum, cell) => sum + (cell.cost ?? 0), 0).toFixed(4)),
      current: { model: route.id, task: task.id },
    });
    state.results.push({ model: route.id, task: task.id, ok: r.ok, ms: r.ms, cost: r.cost, error: r.error });
    if (process.env.DSH_PROGRESS_DIR && (done % 10 === 0 || done === total)) {
      try {
        appendFileSync(join(process.env.DSH_PROGRESS_DIR, "aux-eval.jsonl"),
          JSON.stringify({ v: 1, task: "aux-eval", state: "running", pct, msg: `${done}/${total} · eta ${eta}s` }) + "\n");
      } catch { /* panel is optional */ }
    }
    return r;
  } catch (e) {
    return { route, task, error: String(e.message).slice(0, 120) };
  }
});

const freshByKey = new Map(fresh.map((r) => [`${r.route.id}|${r.task.id}`, r]));
const results = pairs
  .map(({ route, task }) => freshByKey.get(`${route.id}|${task.id}`) ?? cached.get(`${route.id}|${task.id}`))
  .filter(Boolean);

const spent = results.reduce((s, r) => s + (r.cost ?? 0), 0);

// second pass: a cheap judge adjudicates the cells the regex marked as failures
let judgeSpent = 0;
const toJudge = results.filter((r) => !r.error && !r.skipped && r.ok === false && r.task.judge?.kind === "checklist" && r.answer);
if (judgeRoute && toJudge.length) {
  console.log(`judge: ${toJudge.length} cells via ${judgeRoute.id}`);
  const verdicts = await mapLimit(toJudge, 6, async (cell) => ({ cell, verdict: await judgeChecklist(cell) }));
  for (const { cell, verdict } of verdicts) {
    if (verdict.error) { cell.judgeError = verdict.error; continue; }
    judgeSpent += verdict.cost;
    const need = cell.task.judge.minHits ?? 1;
    cell.judged = true;
    cell.judgeCovered = `${verdict.covered}/${(cell.task.judge.must ?? []).length}`;
    cell.detail = `${cell.detail} → judge ${cell.judgeCovered}`;
    cell.ok = verdict.covered >= need;
  }
  console.log(`judge: spent ~$${judgeSpent.toFixed(4)}, ${toJudge.filter((c) => c.judged && c.ok).length} upgraded to pass`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = opt("out", join(HOME, "aux-eval-results"));
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `results-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({ stamp, spent, judgeSpent, results }, null, 1), "utf8");

// ---- publish aux-eval.json -------------------------------------------------
const typeOf = new Map(tasks.map((t) => [t.id, t.type]));
const published = {};
for (const cell of results) {
  const id = cell.route.id;
  const m = (published[id] ??= { provider: cell.route.provider, model: cell.route.model, byType: {}, pass: 0, total: 0, ms: 0, cost: 0, tasks: {} });
  if (cell.error) { m.tasks[cell.task.id] = { ok: null, error: String(cell.error).slice(0, 80) }; continue; }
  if (cell.skipped) { m.tasks[cell.task.id] = { ok: null, skipped: cell.skipped }; continue; }
  if (cell.ok === null) { m.tasks[cell.task.id] = { ok: null, note: "unscored" }; continue; }
  const type = typeOf.get(cell.task.id) ?? "general";
  const bucket = (m.byType[type] ??= { pass: 0, total: 0 });
  bucket.total++;
  m.total++;
  m.ms += cell.ms ?? 0;
  m.cost += cell.cost ?? 0;
  if (cell.ok) { bucket.pass++; m.pass++; }
  m.tasks[cell.task.id] = { ok: cell.ok, ms: cell.ms, detail: cell.detail, judged: cell.judged === true || undefined };
}
for (const m of Object.values(published)) {
  m.avgMs = m.total ? Math.round(m.ms / m.total) : null;
  for (const b of Object.values(m.byType)) b.rate = Number((b.pass / Math.max(1, b.total)).toFixed(3));
  m.rate = Number((m.pass / Math.max(1, m.total)).toFixed(3));
}
const evalPath = join(HOME, "aux-eval.json");
// Merge, do not replace: a --models filter must not wipe the other models.
let previous = { models: {} };
try { previous = JSON.parse(readFileSync(evalPath, "utf8")); } catch { /* first run */ }
const merged = Object.assign({}, previous.models, published);
writeFileSync(evalPath, JSON.stringify({
  version: 1,
  source: outPath.split(/[\\/]/).pop(),
  ranAt: stamp,
  spentUsd: Number((spent + judgeSpent).toFixed(4)),
  tasks: tasks.map((t) => ({ id: t.id, type: t.type, judge: t.judge?.kind })),
  models: merged,
}, null, 1) + "\n", "utf8");
writeState({ finished: true, pct: 100, spentUsd: Number((spent + judgeSpent).toFixed(4)), evalPath, outPath });

const byModel = {};
for (const r of results) {
  const b = (byModel[r.route.id] ??= { ok: 0, total: 0, ms: 0, cost: 0, errors: 0, cells: {} });
  if (r.error) { b.errors++; b.cells[r.task.id] = "ERR"; continue; }
  if (r.skipped) { b.cells[r.task.id] = "skip"; continue; }
  b.total++;
  if (r.ok) b.ok++;
  b.ms += r.ms ?? 0;
  b.cost += r.cost ?? 0;
  b.cells[r.task.id] = r.ok === null ? "?" : r.ok ? "ok" : "x";
}

console.log(`\nspent ~$${spent.toFixed(4)} + judge ~$${judgeSpent.toFixed(4)} = $${(spent + judgeSpent).toFixed(4)} → ${outPath}\n`);
const head = ["model", ...tasks.map((t) => t.id.replace(/^t-/, ""))].map((h) => h.padEnd(12)).join("");
console.log(head);
for (const [id, b] of Object.entries(byModel).sort((x, y) => (y[1].ok / Math.max(1, y[1].total)) - (x[1].ok / Math.max(1, x[1].total)))) {
  const cells = tasks.map((t) => String(b.cells[t.id] ?? "-").padEnd(12)).join("");
  console.log(`${id.padEnd(12)}${cells} ${b.ok}/${b.total} ${Math.round(b.ms / Math.max(1, b.total))}ms $${b.cost.toFixed(4)}`);
}
