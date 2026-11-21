/**
 * dsh-aux-models — resident auxiliary models for DeepSeek Harness.
 *
 * v2 adds three things on top of the v1 single-shot/tool-loop delegation:
 *
 *   1. a *channel* layer (group → multiplier → model mapping), so a gateway
 *      group such as "0.14x, all ids map to gpt-6-astra" is described once;
 *   2. a *learned router* — 7 task types (litellm naming), a per
 *      (task type × model) `quality_mean` that improves with every call, and
 *      `weights.quality` / `weights.cost` as the single cost/quality lever;
 *   3. a *cost model* with a per-call budget guard, so a tool loop cannot
 *      quietly spend ten times what the first round suggested.
 *
 * Field names follow litellm's adaptive router on purpose: quality_tier,
 * strengths, quality_mean, weights.quality / weights.cost. Registry shape
 * follows the Portkey gateway's targets-array idea. If this ever graduates into
 * a real gateway, the config translates without renames.
 *
 * Deliberately dependency-free (node builtins only): the plugin is linked from
 * a directory outside the profile, so no bare specifier may be imported.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "aux-models";

export const inject = ["tools", "llm", "systemPrompt"];

const TASK_TYPES = [
  "code_generation",
  "code_understanding",
  "technical_design",
  "analytical_reasoning",
  "writing",
  "factual_lookup",
  "general",
];

/** Cold-start prior per declared quality tier (1 = budget, 2 = mid, 3 = frontier). */
const TIER_PRIOR = { 1: 0.55, 2: 0.78, 3: 0.95 };

/** Observation mass that outweighs the declared tier (litellm uses ~10 requests). */
const PRIOR_MASS = 8;

/** A cell's evidence halves every two weeks; a stale win should not win forever. */
const DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** litellm caps a cell at 200 samples; same idea, applied to decayed samples. */
const MAX_EFFECTIVE_SAMPLES = 200;

/** Cached input tokens are assumed to bill at 10% of the normal input rate. */
const CACHE_DISCOUNT = 0.1;

const DEFAULT_WEIGHTS = { quality: 0.7, cost: 0.3 };

const DEFAULT_ROUTING = {
  /** Ask the operator when the top two candidates are this close. */
  askBelowConfidence: 0.15,
  /** USD; a call estimated above this should be confirmed first. */
  askAboveCost: 0.05,
  /** USD; hard ceiling enforced inside the tool loop. */
  maxCostPerCall: 0.5,
  maxRounds: 6,
  breakerFailures: 3,
  cooldownMinutes: 10,
};

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_INPUT_CHARS = 60000;
// Reasoning-flavoured routes bill every output token (gpt-6-astra: $7.00/M out,
// ~4.8k tokens for a one-page answer). A default cap keeps a casual task from
// costing 10x what it should; callers can raise it per call.
const DEFAULT_MAX_TOKENS = 1600;
const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_ALLOWED_TOOLS = ["read", "grep", "glob"];
const MAX_TOOL_RESULT_CHARS = 20000;

const DEFAULT_CHANNELS = [
  {
    id: "x001-gpt",
    name: "X001-GPT 不降智分组 (0.14x)",
    provider: "dieqi",
    multiplier: 0.14,
    cacheHitRate: 0.8,
    stability: 5,
    models: [
      {
        id: "astra",
        label: "GPT-6 Astra",
        model: "gpt-6-astra",
        qualityTier: 3,
        strengths: ["code_generation", "code_understanding", "technical_design", "analytical_reasoning"],
        contextWindow: 1050000,
        maxOutputTokens: 128000,
        supportsTools: true,
        pricing: { inputPerM: 10, outputPerM: 50, source: "openrouter" },
      },
      {
        id: "luna",
        label: "GPT-5.6 Luna",
        model: "gpt-5.6-luna",
        mapsTo: "gpt-6-astra",
        qualityTier: 3,
        strengths: ["factual_lookup", "writing"],
        contextWindow: 1050000,
        maxOutputTokens: 128000,
        supportsTools: true,
        pricing: { inputPerM: 10, outputPerM: 50, source: "openrouter" },
        notes: "网关内映射到 gpt-6-astra，按 astra 计费",
      },
      {
        id: "codex-review",
        label: "Codex Auto Review",
        model: "codex-auto-review",
        mapsTo: "gpt-6-astra",
        qualityTier: 2,
        strengths: ["code_understanding"],
        contextWindow: 1050000,
        maxOutputTokens: 128000,
        supportsTools: false,
        pricing: { inputPerM: 10, outputPerM: 50, source: "gateway-group" },
        notes: "自动审批用；同组按 astra 计费",
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.length > 0) : [];
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
}

function registryPath(config) {
  if (config && typeof config.registryPath === "string" && config.registryPath.length > 0) {
    return config.registryPath;
  }
  return join(dshHome(), "aux-models.json");
}

function statsPath(config) {
  if (config && typeof config.statsPath === "string" && config.statsPath.length > 0) {
    return config.statsPath;
  }
  return join(dshHome(), "aux-stats.json");
}

/** The measured per-model price table (_price_sync.mjs keeps it in sync). */
function priceTablePath(config) {
  if (config && typeof config.priceTablePath === "string" && config.priceTablePath.length > 0) {
    return config.priceTablePath;
  }
  return join(dshHome(), "price-table.json");
}

/**
 * Official DeepSeek CNY rates as a starting point for the four models the
 * balance dock tracks (peak price, off-peak is half). The page lets the user
 * edit these; a measured entry in price-table.json wins over this map.
 */
const DEEPSEEK_DEFAULTS = {
  "deepseek-v4-flash": { cacheMiss: 2, cacheHit: 0.2, output: 8 },
  "deepseek-v4.1-flash": { cacheMiss: 2, cacheHit: 0.2, output: 8 },
  "deepseek-v4-pro": { cacheMiss: 4, cacheHit: 0.4, output: 16 },
  "deepseek-chat": { cacheMiss: 2, cacheHit: 0.2, output: 8 },
  "deepseek-reasoner": { cacheMiss: 4, cacheHit: 0.4, output: 16 },
};

/**
 * Default peak/offpeak prices for the balance dock, derived from the same
 * measured table so the 价格设置 page opens with real numbers instead of zeros.
 */
function balanceDefaults(table) {
  const defaults = {};
  for (const [model, peak] of Object.entries(DEEPSEEK_DEFAULTS)) {
    defaults[model] = { peak: { ...peak }, offpeak: { cacheMiss: peak.cacheMiss / 2, cacheHit: peak.cacheHit / 2, output: peak.output / 2 } };
  }
  for (const [key, price] of Object.entries(table?.prices ?? {})) {
    const model = key.slice(key.indexOf(":") + 1);
    if (defaults[model]?.measured) continue;
    const tier = {
      cacheMiss: price.input,
      cacheHit: price.cacheRead ?? price.input / 10,
      output: price.output,
    };
    // A measured entry overrides the built-in guess but keeps the off-peak split.
    defaults[model] = { peak: tier, offpeak: { cacheMiss: tier.cacheMiss / 2, cacheHit: tier.cacheHit / 2, output: tier.output / 2 }, measured: true };
  }
  return defaults;
}

/** Rough token estimate: CJK characters are ~1.3 tokens, latin ~1 token per 4 chars. */
function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0) > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.3 + other / 4);
}

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0 };
  const input = finiteOr(usage.inputTokens, finiteOr(usage.promptTokens, finiteOr(usage.input_tokens, 0)));
  const output = finiteOr(usage.outputTokens, finiteOr(usage.completionTokens, finiteOr(usage.output_tokens, 0)));
  return { input, output };
}

// ---- eval console ---------------------------------------------------------
const evalIndex = (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { ok: false, error: "use GET" }, { Allow: "GET, HEAD" });
  try {
    sendJson(res, 200, evalSummary());
  } catch (error) {
    sendJson(res, 500, { ok: false, error: describeFailure(error) });
  }
};

const evalStatus = (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { ok: false, error: "use GET" }, { Allow: "GET, HEAD" });
  sendJson(res, 200, {
    ok: true,
    running: Boolean(evalChild.child),
    startedAt: evalChild.startedAt || null,
    exitCode: evalChild.exitCode,
    state: readEvalState(),
    tail: evalChild.tail.slice(-14),
  });
};

const evalStart = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "use POST" }, { Allow: "POST" });
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: "untrusted origin" });
  if (evalChild.child) return sendJson(res, 409, { ok: false, error: "an eval run is already in progress" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: describeFailure(error) });
  }
  const banks = evalBanks();
  const configured = readEvalConfig().bank;
  const wanted = typeof body?.bank === "string" && body.bank.length > 0 ? body.bank : configured;
  // Resolve strictly: an unknown bank must fail instead of silently running a
  // different one (the console shows the picked bank, so a fallback would
  // produce results the user never asked for).
  const picked = wanted ? banks.find((b) => b.path === wanted || b.id === wanted) : undefined;
  if (wanted && !picked) return sendJson(res, 400, { ok: false, error: `unknown task bank: ${wanted}` });
  const bank = picked ?? banks.find((b) => b.usable);
  if (!bank) return sendJson(res, 400, { ok: false, error: "no task bank available" });
  if (!bank.usable) return sendJson(res, 400, { ok: false, error: `bank ${bank.path} has no runnable tasks` });
  const budget = Number.isFinite(body?.budgetUsd) ? clamp(body.budgetUsd, 0.01, 50) : clamp(Number(readEvalConfig().budgetUsd) || 1, 0.01, 50);
  const concurrency = Number.isFinite(body?.concurrency) ? clamp(Math.trunc(body.concurrency), 1, 32) : clamp(Number(readEvalConfig().concurrency) || 8, 1, 32);
  const models = Array.isArray(body?.models) && body.models.length > 0 ? body.models.map(String) : [];
  const argv = [evalRunnerPath(), `--bank=${bank.path}`, `--state=${evalStatePath()}`, `--budget=${budget}`, `--concurrency=${concurrency}`];
  if (models.length > 0) argv.push(`--models=${models.join(",")}`);
  try {
    writeFileSync(evalStatePath(), JSON.stringify({ version: 1, startedAt: new Date().toISOString(), total: 0, done: 0, pct: 0, finished: false, error: null, results: [] }), "utf8");
  } catch {
    // The runner rewrites it within a second anyway.
  }
  writeEvalConfig({ ...readEvalConfig(), bank: bank.path, budgetUsd: budget, concurrency });
  let child;
  try {
    child = spawn(process.execPath, argv, {
      cwd: dirname(evalRunnerPath()),
      env: { ...process.env, DSH_HOME: dshHome() },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: describeFailure(error) });
  }
  evalChild.child = child;
  evalChild.startedAt = Date.now();
  evalChild.tail = [];
  evalChild.exitCode = null;
  const push = (data) => {
    const lines = String(data).split(/\r?\n/).filter((line) => line.trim().length > 0);
    evalChild.tail.push(...lines);
    if (evalChild.tail.length > 60) evalChild.tail = evalChild.tail.slice(-60);
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("error", (error) => push(`spawn error: ${describeFailure(error)}`));
  child.on("exit", (code) => {
    evalChild.child = null;
    evalChild.exitCode = code;
    push(`runner exited with code ${code}`);
  });
  sendJson(res, 200, { ok: true, bank: bank.id, path: bank.path, budgetUsd: budget, concurrency, models, tasks: bank.tasks });
};

const evalStop = (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "use POST" }, { Allow: "POST" });
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: "untrusted origin" });
  if (!evalChild.child) return sendJson(res, 409, { ok: false, error: "no eval run is in progress" });
  try {
    evalChild.child.kill();
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: describeFailure(error) });
  }
  sendJson(res, 200, { ok: true, stopped: true });
};


/* -------------------------------------------------------------------------- */
/* registry: v2 channels, with v1 migration                                   */
/* -------------------------------------------------------------------------- */

function normalizeModel(raw, channel) {
  if (raw === null || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const provider = typeof raw.provider === "string" && raw.provider.trim().length > 0
    ? raw.provider.trim()
    : typeof channel.provider === "string" ? channel.provider : "";
  if (id.length === 0 || model.length === 0 || provider.length === 0) return null;
  const pricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {};
  return {
    id,
    label: typeof raw.label === "string" && raw.label.length > 0 ? raw.label : id,
    provider,
    model,
    mapsTo: typeof raw.mapsTo === "string" ? raw.mapsTo : undefined,
    qualityTier: clamp(Math.trunc(finiteOr(raw.qualityTier, finiteOr(raw.tier, 2))), 1, 3),
    strengths: stringList(raw.strengths).filter(type => TASK_TYPES.includes(type)),
    tags: stringList(raw.tags),
    contextWindow: Number.isFinite(raw.contextWindow) ? raw.contextWindow : undefined,
    maxOutputTokens: Number.isFinite(raw.maxOutputTokens) ? raw.maxOutputTokens : undefined,
    supportsTools: raw.supportsTools !== false,
    pricing: {
      inputPerM: finiteOr(pricing.inputPerM, undefined),
      outputPerM: finiteOr(pricing.outputPerM, undefined),
      source: typeof pricing.source === "string" ? pricing.source : undefined,
    },
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    enabled: raw.enabled !== false,
    channel: channel.id,
    multiplier: channel.multiplier,
    cacheHitRate: channel.cacheHitRate,
    stability: channel.stability,
  };
}

function normalizeChannel(raw, index) {
  if (raw === null || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : `channel-${index + 1}`;
  const channel = {
    id,
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id,
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    multiplier: Number.isFinite(raw.multiplier) && raw.multiplier > 0 ? raw.multiplier : 1,
    cacheHitRate: clamp(finiteOr(raw.cacheHitRate, 0), 0, 0.99),
    stability: clamp(finiteOr(raw.stability, 7), 1, 10),
    enabled: raw.enabled !== false,
    models: [],
  };
  channel.models = (Array.isArray(raw.models) ? raw.models : []).map(item => normalizeModel(item, channel)).filter(Boolean);
  return channel;
}

/** v1 → v2: a flat `models` array is grouped by provider into one channel each. */
function migrateV1(parsed, path) {
  const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
  const byProvider = new Map();
  for (const item of rawModels) {
    const provider = item && typeof item.provider === "string" ? item.provider : "default";
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(item);
  }
  const channels = [];
  for (const [provider, models] of byProvider) {
    channels.push(normalizeChannel({ id: `legacy-${provider}`, name: `legacy (${provider})`, provider, models }, channels.length));
  }
  return { channels: channels.filter(Boolean), migrated: true, path };
}

function buildRegistry(parsed, path) {
  let channels = [];
  let migrated = false;
  if (parsed && Array.isArray(parsed.channels)) {
    channels = parsed.channels.map(normalizeChannel).filter(Boolean);
  } else if (parsed && Array.isArray(parsed.models)) {
    const legacy = migrateV1(parsed, path);
    channels = legacy.channels;
    migrated = legacy.migrated;
  }
  const models = [];
  for (const channel of channels) {
    if (channel.enabled === false) continue;
    for (const model of channel.models) models.push(model);
  }
  const weights = {
    quality: clamp(finiteOr(parsed?.weights?.quality, DEFAULT_WEIGHTS.quality), 0, 1),
    cost: clamp(finiteOr(parsed?.weights?.cost, DEFAULT_WEIGHTS.cost), 0, 1),
  };
  const routing = { ...DEFAULT_ROUTING };
  if (parsed && parsed.routing && typeof parsed.routing === "object") {
    for (const key of Object.keys(DEFAULT_ROUTING)) {
      if (Number.isFinite(parsed.routing[key])) routing[key] = parsed.routing[key];
    }
  }
  return {
    path,
    missing: parsed === null,
    version: 2,
    migrated,
    weights,
    routing,
    channels,
    models,
    defaultModel: typeof parsed?.defaultModel === "string" && parsed.defaultModel.length > 0
      ? parsed.defaultModel
      : models[0]?.id ?? "",
    defaultSystem: typeof parsed?.defaultSystem === "string" ? parsed.defaultSystem : undefined,
  };
}

function fallbackRegistry(config) {
  const path = registryPath(config);
  const source = config && Array.isArray(config.channels)
    ? { channels: config.channels }
    : config && Array.isArray(config.models)
      ? { models: config.models }
      : { channels: DEFAULT_CHANNELS };
  const registry = buildRegistry(source, path);
  registry.missing = true;
  if (config && typeof config.defaultModel === "string") registry.defaultModel = config.defaultModel;
  return registry;
}

async function loadRegistry(config) {
  const path = registryPath(config);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return fallbackRegistry(config);
    throw new Error(`aux-models: cannot read registry ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return buildRegistry(JSON.parse(text), path);
  } catch (error) {
    throw new Error(`aux-models: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* Synchronous read for prompt assembly: the section text provider must be sync. */
const registryCache = { path: null, mtimeMs: -1, registry: null };

function readRegistrySync(config) {
  const path = registryPath(config);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (registryCache.registry !== null && registryCache.path === path && registryCache.mtimeMs === mtimeMs) {
    return registryCache.registry;
  }
  let registry;
  if (mtimeMs < 0) {
    registry = fallbackRegistry(config);
  } else {
    try {
      registry = buildRegistry(JSON.parse(readFileSync(path, "utf8")), path);
    } catch {
      registry = fallbackRegistry(config);
    }
  }
  registryCache.path = path;
  registryCache.mtimeMs = mtimeMs;
  registryCache.registry = registry;
  return registry;
}

/* -------------------------------------------------------------------------- */
/* pricing and statistics                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Effective per-million prices: the decline multiplier applies to the official
 * price, and cache hits (only a fraction of input tokens) are billed cheaper.
 */
function effectivePricing(entry) {
  const multiplier = Number.isFinite(entry.multiplier) && entry.multiplier > 0 ? entry.multiplier : 1;
  const hitRate = clamp(finiteOr(entry.cacheHitRate, 0), 0, 0.99);
  const inputFactor = (1 - hitRate) + hitRate * CACHE_DISCOUNT;
  const inputPerM = Number.isFinite(entry.pricing?.inputPerM) ? entry.pricing.inputPerM * multiplier * inputFactor : undefined;
  const outputPerM = Number.isFinite(entry.pricing?.outputPerM) ? entry.pricing.outputPerM * multiplier : undefined;
  return {
    inputPerM,
    outputPerM,
    multiplier,
    cacheHitRate: hitRate,
    known: Number.isFinite(inputPerM) && Number.isFinite(outputPerM),
  };
}

function estimateCost(entry, inputTokens, outputTokens) {
  const price = effectivePricing(entry);
  if (!price.known) return undefined;
  return (inputTokens / 1e6) * price.inputPerM + (outputTokens / 1e6) * price.outputPerM;
}

const statsCache = { path: null, mtimeMs: -1, stats: null };

function readStatsSync(config) {
  const path = statsPath(config);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (statsCache.stats !== null && statsCache.path === path && statsCache.mtimeMs === mtimeMs) {
    return statsCache.stats;
  }
  let stats = { version: 2, cells: {}, failures: {} };
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") {
        stats = {
          version: 2,
          cells: parsed.cells && typeof parsed.cells === "object" ? parsed.cells : {},
          failures: parsed.failures && typeof parsed.failures === "object" ? parsed.failures : {},
        };
      }
    } catch {
      // A corrupt stats file must never break delegation: start fresh.
    }
  }
  statsCache.path = path;
  statsCache.mtimeMs = mtimeMs;
  statsCache.stats = stats;
  return stats;
}

function cellKey(modelId, taskType) {
  return `${modelId}|${taskType}`;
}

/*
 * Weekly eval scores (`$DSH_HOME/aux-eval.json`, written by eval-build/to-eval.mjs)
 * are a *static* signal: they say how a route did on a fixed battery, not how it
 * did on your real work. They get their own weight between the tier prior and the
 * live stats so a fresh install still routes sensibly before any delegation exists.
 */
const EVAL_MASS = 12;
const evalCache = { path: null, mtimeMs: -1, eval: null };

function evalPath(config) {
  return config?.evalPath ?? join(dshHome(), "aux-eval.json");
}

function readEvalSync(config) {
  const path = evalPath(config);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (evalCache.eval !== null && evalCache.path === path && evalCache.mtimeMs === mtimeMs) return evalCache.eval;
  let data = { version: 1, models: {} };
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object") data = parsed;
    } catch {
      // A corrupt eval file must never break delegation.
    }
  }
  evalCache.path = path;
  evalCache.mtimeMs = mtimeMs;
  evalCache.eval = data;
  return data;
}

function evalCell(evaluations, modelId, taskType) {
  const model = evaluations.models?.[modelId];
  if (!model) return undefined;
  const bucket = model.byType?.[taskType];
  if (bucket && Number.isFinite(bucket.total) && bucket.total > 0) {
    return { rate: clamp(bucket.pass / bucket.total, 0, 1), pass: bucket.pass, total: bucket.total };
  }
  if (model.total > 0) return { rate: clamp(model.pass / model.total, 0, 1), pass: model.pass, total: model.total, overall: true };
  return undefined;
}

function readCell(stats, modelId, taskType) {
  const cell = stats.cells?.[cellKey(modelId, taskType)];
  if (!cell || typeof cell !== "object") return { n: 0, qualitySum: 0, failN: 0, latencySumMs: 0, tokensIn: 0, tokensOut: 0, lastAt: undefined };
  return {
    n: finiteOr(cell.n, 0),
    qualitySum: finiteOr(cell.qualitySum, 0),
    failN: finiteOr(cell.failN, 0),
    latencySumMs: finiteOr(cell.latencySumMs, 0),
    tokensIn: finiteOr(cell.tokensIn, 0),
    tokensOut: finiteOr(cell.tokensOut, 0),
    lastAt: Number.isFinite(cell.lastAt) ? cell.lastAt : undefined,
  };
}

/**
 * Blended quality estimate: declared tier first, measured mean once data exists.
 *
 * Two corrections over litellm's adaptive router, which keeps every sample
 * forever: the cell's evidence decays with a half-life (a model that was good
 * last month should not outrank one that is good today), and the effective
 * sample count is capped so a long hot streak cannot lock a cell in.
 */
function qualityEstimate(entry, stats, taskType, evaluations) {
  const prior = TIER_PRIOR[entry.qualityTier] ?? TIER_PRIOR[2];
  const cell = readCell(stats, entry.id, taskType);
  const ageMs = Number.isFinite(cell.lastAt) ? Math.max(0, Date.now() - cell.lastAt) : 0;
  const decay = Math.pow(0.5, ageMs / DECAY_HALF_LIFE_MS);
  const effective = Math.min(MAX_EFFECTIVE_SAMPLES, cell.n * decay);
  const measured = cell.n > 0 ? cell.qualitySum / cell.n : prior;
  const evalScore = evaluations ? evalCell(evaluations, entry.id, taskType) : undefined;
  const evalMass = evalScore ? EVAL_MASS : 0;
  const blended = (PRIOR_MASS * prior + evalMass * (evalScore?.rate ?? 0) + effective * measured)
    / (PRIOR_MASS + evalMass + effective);
  return {
    value: clamp(blended, 0, 1),
    samples: cell.n,
    effectiveSamples: Number(effective.toFixed(2)),
    decay: Number(decay.toFixed(3)),
    prior,
    measured,
    evalRate: evalScore?.rate,
    evalPass: evalScore?.pass,
    evalTotal: evalScore?.total,
    evalOverall: evalScore?.overall === true ? true : undefined,
  };
}

function recentFailures(stats, modelId, cooldownMinutes) {
  const list = Array.isArray(stats.failures?.[modelId]) ? stats.failures[modelId] : [];
  const since = Date.now() - cooldownMinutes * 60000;
  return list.filter(item => item && Number.isFinite(item.at) && item.at >= since);
}

function recordOutcome(config, entry, taskType, options) {
  const stats = readStatsSync(config);
  const key = cellKey(entry.id, taskType);
  const cell = readCell(stats, entry.id, taskType);
  cell.n += 1;
  cell.qualitySum += options.quality ?? (options.ok ? 1 : 0);
  cell.failN += options.ok ? 0 : 1;
  cell.latencySumMs += options.latencyMs ?? 0;
  cell.tokensIn += options.tokensIn ?? 0;
  cell.tokensOut += options.tokensOut ?? 0;
  stats.cells[key] = { ...cell, lastAt: Date.now() };

  if (!options.ok) {
    const list = Array.isArray(stats.failures[entry.id]) ? stats.failures[entry.id] : [];
    list.push({ at: Date.now(), message: String(options.message ?? "").slice(0, 300) });
    stats.failures[entry.id] = list.slice(-20);
  } else if (Array.isArray(stats.failures[entry.id])) {
    // A success inside the window clears the breaker's evidence.
    stats.failures[entry.id] = [];
  }

  const path = statsPath(config);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf8");
    renameSync(tmp, path);
    statsCache.path = path;
    statsCache.mtimeMs = statSync(path).mtimeMs;
    statsCache.stats = stats;
  } catch {
    // Statistics are advisory; never fail a delegation because bookkeeping did.
  }
}

/* -------------------------------------------------------------------------- */
/* task classification (litellm's 7 types, with Chinese rules)                 */
/* -------------------------------------------------------------------------- */

const TASK_RULES = [
  {
    type: "code_generation",
    patterns: [
      [/写.{0,12}(函数|脚本|模块|类|程序|代码|组件|解析|爬虫)/i, 3],
      [/(实现|编写|生成).{0,6}(函数|脚本|模块|类|代码|程序)/i, 3],
      [/(重构|refactor|修(复|改)\s*(bug|缺陷|问题))/i, 3],
      [/\b(write|implement|generate|create)\b.{0,20}\b(function|script|module|class|program|code)\b/i, 3],
      [/\b(add|fix|refactor)\b.{0,20}\b(feature|bug|test|function)\b/i, 2],
      [/(\bTODO\b|单元测试|unit test|pytest|jest)/i, 1],
    ],
  },
  {
    type: "code_understanding",
    patterns: [
      [/(解释|说明|讲(讲|解)|看懂|理解).{0,8}(代码|函数|实现|逻辑|这段)/i, 3],
      [/(这段|下面|如下).{0,4}代码/i, 3],
      [/(审查|review|检查).{0,8}(代码|diff|补丁|改动|PR)/i, 3],
      [/\b(explain|what does|how does)\b.{0,30}\b(code|function|this|it)\b/i, 3],
      [/(为什么|为何|why).{0,10}(报错|失败|崩溃|error|crash)/i, 2],
      [/(调用链|调用关系|入口|依赖关系)/i, 2],
    ],
  },
  {
    type: "technical_design",
    patterns: [
      [/(设计|架构|方案|选型|怎么做|如何实现|技术路线)/i, 3],
      [/\b(design|architect|architecture|trade-?off|approach|strategy)\b/i, 3],
      [/(接口设计|数据模型|表结构|schema design)/i, 2],
      [/(扩展性|可维护性|解耦|重构方案)/i, 2],
    ],
  },
  {
    type: "analytical_reasoning",
    patterns: [
      [/(分析|剖析|拆解|复盘)/i, 3],
      [/(推理|推断|论证|归因|根因)/i, 3],
      [/(对比|比较|评估|权衡|利弊|优缺点)/i, 2],
      [/(概率|统计|计算|推导|证明)/i, 2],
      [/\b(analy[sz]e|reason|infer|evaluate|compare|why)\b/i, 2],
    ],
  },
  {
    type: "writing",
    patterns: [
      [/(写(一)?(篇|段|封)|起草|润色|改写|翻译|总结|摘要|文案)/i, 3],
      [/(邮件|公告|说明文档|周报|README)/i, 2],
      [/\b(draft|rewrite|polish|translate|summari[sz]e|email|announcement)\b/i, 3],
    ],
  },
  {
    type: "factual_lookup",
    patterns: [
      [/(是什么|有多少|多少|哪(个|些)|查询|查一下|列(出|一下))/i, 3],
      [/\b(what is|what's|how many|which|list|look ?up)\b/i, 3],
      [/^(什么是|请问)/i, 2],
    ],
  },
];

/**
 * Classify a task into one of seven types. Confidence is the share of the
 * winning type among all matched evidence — a task that reads equally like
 * code_understanding and analytical_reasoning is exactly when we want to ask.
 */
function classifyTask(text) {
  const scores = Object.fromEntries(TASK_TYPES.map(type => [type, 0]));
  const hits = [];
  for (const rule of TASK_RULES) {
    for (const [pattern, weight] of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        scores[rule.type] += weight;
        hits.push({ type: rule.type, matched: match[0] });
      }
    }
  }
  // Code markers outrank the generic writing verbs: "把这段 Python 解析 CSV 的
  // 函数改写一下" is a code task even though 改写 also matches the writing rule.
  if (/(代码块|这段代码|函数|脚本|模块|变量|正则|编译|堆栈|报错|异常|单测|依赖|import\s|def\s|class\s|SELECT\s|npm\s|pip\s|git\s|\b(function|variable|compile|stack ?trace|exception|unit test|code)\b)/i.test(text)) {
    scores.code_generation += 3;
    scores.code_understanding += 1;
  }
  if (/(python|javascript|typescript|node\.?js|sql|csv|json|yaml|shell|bash|powershell|golang|rust|java|c\+\+)/i.test(text)) {
    scores.code_generation += 1;
  }
  // Log triage and tabular summaries: "把日志里的错误按频率整理成表" is work on an
  // existing artifact, not prose writing — without this it falls through to general.
  if (/(日志|\blogs?\b|堆栈|traceback|崩溃报告|按频率|整理成(一张)?表|汇总成表|统计一下|列出所有)/i.test(text)) {
    scores.code_understanding += 2;
    scores.analytical_reasoning += 1;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const [type, score] = ranked[0];
  if (total === 0) {
    return { type: "general", confidence: 0, hits: [], scores };
  }
  const second = ranked[1]?.[1] ?? 0;
  const share = score / total;
  const margin = (score - second) / total;
  return { type: score > 0 ? type : "general", confidence: clamp(share * 0.6 + margin * 0.4, 0, 1), hits: hits.slice(0, 6), scores };
}

/* -------------------------------------------------------------------------- */
/* routing                                                                    */
/* -------------------------------------------------------------------------- */

function healthOf(entry, stats, routing) {
  const recent = recentFailures(stats, entry.id, routing.cooldownMinutes);
  const breaker = recent.length >= routing.breakerFailures;
  const stability = clamp(finiteOr(entry.stability, 7), 1, 10);
  return {
    recentFailures: recent.length,
    breaker,
    lastMessage: recent.length > 0 ? recent[recent.length - 1].message : undefined,
    /** 5/10 stability means: prefer a steadier route when quality is close. */
    penalty: breaker ? 0.35 : clamp((10 - stability) / 40, 0, 0.3) - Math.min(recent.length, 3) * 0.05,
  };
}

/**
 * Two-stage routing, the litellm shape:
 *   stage 1 — hard filters (enabled, tool support, context, budget, quality floor)
 *   stage 2 — score = weights.quality * quality + weights.cost * cheapness
 * The winner is returned with its alternatives so the caller can ask a human
 * when the top two are statistically indistinguishable.
 */
function routeTask(registry, stats, task, options = {}) {
  const routing = registry.routing;
  const evaluations = options.evaluations ?? readEvalSync(options.config);
  const classification = classifyTask(task);
  const taskType = options.taskType && TASK_TYPES.includes(options.taskType) ? options.taskType : classification.type;
  const inputTokens = estimateTokens(task) + finiteOr(options.contextTokens, 0);
  const needsTools = options.tools === true;
  const minTier = Number.isFinite(options.minTier) ? clamp(Math.trunc(options.minTier), 1, 3) : 1;
  const rounds = needsTools ? clamp(finiteOr(options.rounds, routing.maxRounds), 1, 20) : 1;
  const budget = Number.isFinite(options.maxCost) ? options.maxCost : routing.maxCostPerCall;
  const strategy = typeof options.strategy === "string" ? options.strategy : "auto";

  const rejected = [];
  const candidates = [];
  for (const entry of registry.models) {
    if (!entry.enabled) continue;
    if (needsTools && entry.supportsTools === false) {
      rejected.push({ entry, reason: "supportsTools: false" });
      continue;
    }
    if (entry.qualityTier < minTier) {
      rejected.push({ entry, reason: `tier ${entry.qualityTier} < required ${minTier}` });
      continue;
    }
    if (Number.isFinite(options.inputTokens) && Number.isFinite(entry.contextWindow) && options.inputTokens > entry.contextWindow) {
      rejected.push({ entry, reason: `needs ${options.inputTokens} tokens, window ${entry.contextWindow}` });
      continue;
    }
    const quality = qualityEstimate(entry, stats, taskType, evaluations);
    // A tool loop grows roughly quadratically: round r re-sends the transcript.
    const estOut = clamp(Math.round(inputTokens * 0.35), 256, entry.maxOutputTokens ?? 4096);
    const estInput = needsTools ? Math.round(inputTokens * (1 + (rounds - 1) * 0.8)) : inputTokens;
    const estOutput = needsTools ? estOut * rounds : estOut;
    const cost = estimateCost(entry, estInput, estOutput);
    const health = healthOf(entry, stats, routing);
    if (strategy !== "best" && Number.isFinite(cost) && cost > budget) {
      rejected.push({ entry, reason: `estimated $${cost.toFixed(4)} > budget $${budget.toFixed(4)}` });
      continue;
    }
    candidates.push({
      entry,
      quality,
      health,
      cost,
      estInput,
      estOutput,
      score: 0,
    });
  }

  if (candidates.length === 0) {
    const detail = rejected.map(item => `${item.entry.id}: ${item.reason}`).join("; ");
    throw new Error(`aux-models: no auxiliary model fits this task (${detail || "registry empty"})`);
  }

  const costs = candidates.map(item => entryCostForRanking(item));
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index];
    const span = maxCost - minCost;
    const cheapness = span > 1e-9 ? 1 - (costs[index] - minCost) / span : 0.5;
    const weights = strategy === "cheap" ? { quality: 0.25, cost: 0.75 }
      : strategy === "best" ? { quality: 0.9, cost: 0.1 }
        : registry.weights;
    const raw = weights.quality * item.quality.value + weights.cost * cheapness;
    item.score = clamp(raw - item.health.penalty, 0, 1);
    item.cheapness = cheapness;
  }

  candidates.sort((a, b) => b.score - a.score || (a.cost ?? 0) - (b.cost ?? 0));
  const top = candidates[0];
  const second = candidates[1];
  const confidence = second ? clamp(top.score - second.score, 0, 1) : 1;
  const ask = confidence < routing.askBelowConfidence
    || (Number.isFinite(top.cost) && top.cost > routing.askAboveCost && strategy === "auto");

  return {
    chosen: top.entry,
    taskType,
    classification,
    weights: strategy === "cheap" ? { quality: 0.25, cost: 0.75 } : strategy === "best" ? { quality: 0.9, cost: 0.1 } : registry.weights,
    confidence,
    ask,
    askReason: ask
      ? (confidence < routing.askBelowConfidence
        ? `top two candidates differ by only ${confidence.toFixed(2)}`
        : `estimated cost $${(top.cost ?? 0).toFixed(4)} exceeds the ask threshold $${routing.askAboveCost}`)
      : undefined,
    ranking: candidates,
    rejected,
    estimate: { inputTokens, estInput: top.estInput, estOutput: top.estOutput, cost: top.cost, budget },
  };
}

/** Cost used only for ranking: unknown prices rank as the median, never as free. */
function entryCostForRanking(item) {
  if (Number.isFinite(item.cost)) return item.cost;
  const known = item.quality.value;
  return 0.02 * (1 - known) + 0.001;
}

/* -------------------------------------------------------------------------- */
/* descriptions                                                               */
/* -------------------------------------------------------------------------- */

function priceLabel(entry) {
  const price = effectivePricing(entry);
  if (!price.known) return "价格未知";
  return `$${price.inputPerM.toFixed(2)}/M 入 · $${price.outputPerM.toFixed(2)}/M 出`;
}

function describe(entry, stats, routing, evaluations) {
  const quality = qualityEstimate(entry, stats ?? { cells: {}, failures: {} }, "general", evaluations);
  const health = healthOf(entry, stats ?? { cells: {}, failures: {} }, routing ?? DEFAULT_ROUTING);
  const bits = [`${entry.id} — ${entry.label}`, `route ${entry.provider}/${entry.model}`];
  if (entry.mapsTo) bits.push(`映射 ${entry.mapsTo}`);
  bits.push(`tier ${entry.qualityTier}`);
  if (entry.strengths.length > 0) bits.push(`擅长 ${entry.strengths.join("/")}`);
  bits.push(priceLabel(entry));
  if (Number.isFinite(entry.contextWindow)) bits.push(`ctx ${entry.contextWindow}`);
  bits.push(entry.supportsTools ? "可带工具" : "仅单次问答");
  bits.push(`质量 ${quality.value.toFixed(2)} (${quality.samples} 样本)`);
  if (Number.isFinite(quality.evalTotal) && quality.evalTotal > 0) {
    bits.push(`评测 ${quality.evalPass}/${quality.evalTotal}${quality.evalOverall ? " (整体)" : ""}`);
  }
  if (health.breaker) bits.push(`⚠ 熔断中 (${health.recentFailures} 次失败)`);
  if (entry.notes) bits.push(entry.notes);
  return bits.join(" · ");
}

/**
 * A short behavioural rule that lives next to PLAN_POLICY (order 550) instead
 * of among the tool docs. The roster at 2790 explains *what* is available; this
 * one exists because the model otherwise quietly does the work itself "to save
 * trouble" and never opens the roster. Rules only bind when they list concrete
 * triggers and a hard "do not" side, so keep both halves.
 */
function buildPolicy(config) {
  let registry;
  try {
    registry = readRegistrySync(config);
  } catch {
    return "";
  }
  const enabled = registry.models.filter(entry => entry.enabled);
  if (enabled.length === 0) return "";
  const cheapest = enabled.reduce((best, entry) => {
    const price = effectivePricing(entry).outputPerM;
    return price < best ? price : best;
  }, Number.POSITIVE_INFINITY);
  const priceNote = Number.isFinite(cheapest) && cheapest > 0
    ? `最便宜的一条输出价 $${cheapest.toFixed(2)}/M token。`
    : "";
  return [
    "## 委派策略：动手前先扫一遍，命中就派",
    `本 Harness 挂了 ${enabled.length} 个常驻辅助模型（第三方 agent API，独立计费，token 不进本会话上下文）。${priceNote}`,
    "**开场的第一个动作是判断这活该不该留在本会话，而不是直接开干。** 逐条对照下表，命中任一行就先派出去：",
    "| 触发条件 | 做法 |",
    "|---|---|",
    "| 要读 ≥2 个文件，或任一文件 >150 行 | `aux_delegate(task=…, tools=true)`，让它自己 read/grep/glob |",
    "| 要产出 ≥40 行代码、或 ≥300 字成文 | 派出去，你只审结果 |",
    "| 手上有 >2000 字材料要摘要/翻译/校对/提要点 | 整段粘进 request，别粘进本会话 |",
    "| 有能跟主线并行的旁支任务 | 先派出去，然后立刻继续自己那条线，不要等它 |",
    "**禁止先自己读一遍再决定派**：读过就已经占了上下文，派的意义就没了。",
    "只有这几种留给自己：要用本会话已有的状态、要连续多轮跟用户对焦、要写文件或跑命令（走 `subagent`，仅新会话可用）、一两句话就能答完的。",
    "写法：`aux_delegate(task=\"…\", tools=true, model=\"ds-flash\")`；指令里带长度上限（「≤300 字」「只要表不要解释」），`max_tokens` 默认卡 1600，要长文再显式调大。",
    "拿不准派给谁、想先看价钱：`aux_route(task=…)` 只估不发。派出去失败就自己做，别连试三次。",
    "**有几件互不相干的活时用 `aux_delegate_batch(tasks=[…])` 一次并发派出去**，别一件一件等：每个任务独立选模型，一个失败不影响其它，返回一张结果表。",
  ].join("\n");
}

function buildGuidance(config) {
  const registry = readRegistrySync(config);
  const stats = readStatsSync(config);
  const enabled = registry.models.filter(entry => entry.enabled);
  if (enabled.length === 0) return "";
  const lines = [
    "## 常驻辅助模型目录（派出去之前看这里）",
    `注册表 ${registry.path} · 权重 质量 ${registry.weights.quality} / 成本 ${registry.weights.cost}。`,
    "可用路由（每条都是独立计费的外部 agent，不占本会话上下文）：",
  ];
  for (const entry of enabled) {
    const bits = [`- ${entry.id} (${entry.provider}/${entry.model})`];
    if (entry.label && entry.label !== entry.id) bits.push(entry.label);
    bits.push(`tier ${entry.qualityTier}`);
    if (entry.strengths.length > 0) bits.push(`擅长 ${entry.strengths.join("/")}`);
    bits.push(priceLabel(entry));
    bits.push(entry.supportsTools ? "可带工具" : "仅单次问答");
    lines.push(bits.join(" · "));
  }
  lines.push(
    "",
    "调用方式（省略 model 时由路由器按任务类型 + 历史质量 + 价格自动选）：",
    "- 一段话能讲清的：`aux_delegate(task=\"…\")`。",
    "- 要它自己翻仓库文件的：`aux_delegate(task=\"…\", tools=true)`，只读 read/grep/glob，省得你贴大段文件。",
    `预算：单次预估超过 $${registry.routing.askAboveCost} 时 ` + "`aux_route`" + ` 会提示先确认；工具循环内 $${registry.routing.maxCostPerCall} 硬上限。`,
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* streaming                                                                  */
/* -------------------------------------------------------------------------- */

async function streamRound(ctx, entry, messages, options, signal) {
  const parts = [];
  const calls = new Map();
  let usage;
  let finishReason;

  const request = {
    provider: entry.provider,
    model: entry.model,
    messages,
    sessionId: options.sessionId,
    signal,
  };
  if (typeof options.system === "string" && options.system.length > 0) request.system = options.system;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : entry.maxOutputTokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) request.maxTokens = maxTokens;
  if (Number.isFinite(options.temperature)) request.temperature = options.temperature;
  if (Array.isArray(options.tools) && options.tools.length > 0) request.tools = options.tools;

  for await (const chunk of ctx.llm.stream(request)) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      parts.push(chunk.text);
      continue;
    }
    if (chunk.type === "tool-call-delta") {
      const key = Number.isFinite(chunk.index) ? chunk.index : calls.size;
      const call = calls.get(key) ?? { id: "", name: "", arguments: "" };
      if (typeof chunk.id === "string" && chunk.id.length > 0) call.id = chunk.id;
      if (typeof chunk.name === "string" && chunk.name.length > 0) call.name = chunk.name;
      if (typeof chunk.argumentsDelta === "string") call.arguments += chunk.argumentsDelta;
      calls.set(key, call);
      continue;
    }
    if (chunk.type === "usage") {
      usage = chunk.usage ?? usage;
      continue;
    }
    if (chunk.type === "finish") {
      finishReason = chunk.reason;
      if (chunk.reason && chunk.reason.kind === "error") {
        throw new Error(`aux-models: ${entry.provider}/${entry.model} failed: ${describeFailure(chunk.reason.failure)}`);
      }
      if (chunk.reason && chunk.reason.kind === "aborted") {
        throw new Error(`aux-models: ${entry.provider}/${entry.model} aborted before answering`);
      }
    }
  }

  const toolCalls = [...calls.values()]
    .filter(call => call.name.length > 0)
    .map((call, index) => ({
      id: call.id.length > 0 ? call.id : `aux_call_${index}`,
      name: call.name,
      arguments: call.arguments,
    }));

  return { text: parts.join(""), toolCalls, usage, finishReason };
}

async function streamOnce(ctx, entry, prompt, options, signal) {
  const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  const { text, usage, finishReason } = await streamRound(ctx, entry, messages, options, signal);
  if (text.trim().length === 0) {
    // Reasoning-style routes spend the whole budget thinking before they write a
    // single character; surfacing that as a hard failure just tells the caller
    // "no text" and hides the fact that a bigger budget would have worked.
    if (finishReason?.kind === "max-tokens") return { text: "", usage, finishReason };
    throw new Error(`aux-models: ${entry.provider}/${entry.model} returned no text${finishReason ? ` (finish: ${JSON.stringify(finishReason)})` : ""}`);
  }
  return { text, usage, finishReason };
}

const MAX_TOKEN_CEILING = 8000;

/** One more try with a doubled budget when the answer was cut off before it began. */
async function streamOnceWithHeadroom(ctx, entry, prompt, options, signal) {
  const first = await streamOnce(ctx, entry, prompt, options, signal);
  if (first.text.trim().length > 0) return first;
  const requested = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS;
  // Doubling is the wrong shape here: measured reasoning routes can burn 5-6k
  // tokens thinking, so a 1600 -> 3200 retry just loses another 40s before the
  // same failure. Jump to the ceiling once, but only when the per-call budget
  // can absorb it.
  const bumped = Math.min(MAX_TOKEN_CEILING, Math.max(requested * 2, 8000));
  if (bumped <= requested) {
    throw new Error(`aux-models: ${entry.provider}/${entry.model} returned no text (finish: ${JSON.stringify(first.finishReason)})`);
  }
  const projected = estimateCost(entry, Math.ceil(prompt.length / 3) + 200, bumped);
  if (Number.isFinite(options.budget) && projected > options.budget) {
    throw new Error(
      `aux-models: ${entry.provider}/${entry.model} spent its whole max_tokens ${requested} on reasoning and finishing would cost ~$${projected.toFixed(4)} (over the $${options.budget.toFixed(4)} per-call budget); pass a larger max_tokens, raise max_cost, or route to a non-reasoning model`,
    );
  }
  const second = await streamOnce(ctx, entry, prompt, { ...options, maxTokens: bumped }, signal);
  if (second.text.trim().length === 0) {
    throw new Error(`aux-models: ${entry.provider}/${entry.model} returned no text even with max_tokens ${bumped} (finish: ${JSON.stringify(second.finishReason)}); this route spends its budget on reasoning, try a non-reasoning route`);
  }
  return second;
}

/* -------------------------------------------------------------------------- */
/* tools                                                                      */
/* -------------------------------------------------------------------------- */

function allowedTools(settings) {
  const configured = settings && typeof settings === "object" ? settings.tools : undefined;
  const list = configured && Array.isArray(configured.allow) ? configured.allow : undefined;
  return (list ?? DEFAULT_ALLOWED_TOOLS).filter(item => typeof item === "string" && item.length > 0);
}

function maxRounds(settings, override, routing) {
  const configured = settings && typeof settings === "object" ? settings.tools : undefined;
  const candidate = Number.isFinite(override)
    ? override
    : configured && Number.isFinite(configured.maxRounds) ? configured.maxRounds
      : routing?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  return clamp(Math.trunc(candidate), 1, 20);
}

function toolSchemas(ctx, agent, allow) {
  let schemas;
  try {
    schemas = ctx.tools.schemas(agent);
  } catch {
    schemas = [];
  }
  const wanted = new Set(allow);
  return (Array.isArray(schemas) ? schemas : []).filter(schema => schema && wanted.has(schema.name));
}

function flattenBlocks(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

async function runToolCall(ctx, call, schema, exec, signal) {
  let args;
  try {
    args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
  } catch {
    return { text: `aux_delegate: could not parse tool arguments for ${call.name}: ${call.arguments.slice(0, 200)}`, isError: true };
  }
  const outcome = await ctx.tools.execute({
    callId: call.id,
    name: call.name,
    schema,
    arguments: args,
    agent: exec?.agent,
    parent: exec?.token,
    rootCallId: exec?.rootCallId,
    signal,
  });
  const isError = outcome?.isError === true;
  let text = flattenBlocks(outcome?.content);
  if (text.length === 0) {
    if (isError) {
      text = describeFailure(outcome?.error);
    } else {
      try {
        text = JSON.stringify(outcome?.value ?? null);
      } catch {
        text = "(unrepresentable tool result)";
      }
    }
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[... truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters by aux_delegate ...]`;
  }
  return { text, isError };
}

/**
 * The tool loop, now budget-aware: every round adds its usage to a running
 * cost, and the loop stops early once the per-call ceiling is crossed.
 */
async function delegateWithTools(ctx, entry, prompt, options, signal, exec) {
  const allow = allowedTools(options.settings);
  const schemas = toolSchemas(ctx, exec?.agent, allow);
  if (schemas.length === 0) {
    throw new Error(`aux-models: no read-only tool from [${allow.join(", ")}] is visible here; run without tools:true`);
  }
  const byName = new Map(schemas.map(schema => [schema.name, schema]));
  const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  const rounds = maxRounds(options.settings, options.maxRounds, options.routing);
  const used = [];
  const budget = options.budget;
  let spent = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastText = "";

  for (let round = 1; round <= rounds; round++) {
    const { text, toolCalls, usage } = await streamRound(ctx, entry, messages, { ...options, tools: schemas }, signal);
    const tokens = usageTokens(usage);
    tokensIn += tokens.input;
    tokensOut += tokens.output;
    const roundCost = estimateCost(entry, tokens.input, tokens.output);
    if (Number.isFinite(roundCost)) spent += roundCost;

    if (toolCalls.length === 0) {
      return {
        text: text.trim().length > 0 ? text : lastText,
        rounds: round,
        toolCalls: used.length,
        used,
        spent: Number.isFinite(roundCost) ? spent : undefined,
        tokensIn,
        tokensOut,
      };
    }
    if (text.length > 0) lastText = text;

    const assistantContent = [];
    if (text.length > 0) assistantContent.push({ type: "text", text });
    for (const call of toolCalls) {
      assistantContent.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
    }
    messages.push({ role: "assistant", content: assistantContent, source: { provider: entry.provider, model: entry.model } });

    for (const call of toolCalls) {
      used.push(call.name);
      const schema = byName.get(call.name);
      const result = schema
        ? await runToolCall(ctx, call, schema, exec, signal)
        : { text: `aux_delegate: tool "${call.name}" is not in the allowed set [${allow.join(", ")}]`, isError: true };
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: [{ type: "text", text: result.text.length > 0 ? result.text : "(no output)" }],
        isError: result.isError,
      });
    }

    if (Number.isFinite(budget) && Number.isFinite(spent) && spent > budget) {
      return {
        text: `${lastText}\n\n[aux_delegate stopped after ${round} rounds: spent ~$${spent.toFixed(4)} exceeds the $${budget.toFixed(2)} per-call budget]`.trim(),
        rounds: round,
        toolCalls: used.length,
        used,
        spent,
        tokensIn,
        tokensOut,
        budgetStop: true,
      };
    }
  }

  return {
    text: `${lastText}\n\n[aux_delegate stopped after ${rounds} tool rounds without a final answer]`.trim(),
    rounds,
    toolCalls: used.length,
    used,
    spent: Number.isFinite(spent) ? spent : undefined,
    tokensIn,
    tokensOut,
    exhausted: true,
  };
}

function describeFailure(failure) {
  if (failure === undefined || failure === null) return "unknown failure";
  if (typeof failure === "string") return failure;
  const kind = typeof failure.kind === "string" ? failure.kind : "error";
  const message = typeof failure.message === "string" ? failure.message
    : typeof failure.error === "string" ? failure.error
      : typeof failure.detail === "string" ? failure.detail
        : JSON.stringify(failure);
  return `${kind}: ${message}`;
}

/**
 * Upstream relays fail in a few recognisable ways (dead tunnel, DNS flap, 502,
 * rate limit). Those are worth one retry on another route; a 401 or an empty
 * answer is not — retrying those only burns money.
 */
const TRANSIENT_FAILURE = /(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed out|timeout|\b50[234]\b|tunnel|upstream|overloaded|rate limit|配额|超时)/i;

function isTransientFailure(error) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return TRANSIENT_FAILURE.test(text);
}

function shortFailure(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function nextCandidate(decision, entry) {
  const ranking = Array.isArray(decision?.ranking) ? decision.ranking : [];
  const other = ranking.find(item => item.entry && item.entry.id !== entry.id);
  return other ? other.entry : undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = [controller.signal];
  if (signal) signals.push(signal);
  const combined = typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"
    ? AbortSignal.any(signals)
    : controller.signal;
  return {
    signal: combined,
    dispose() {
      clearTimeout(timer);
    },
  };
}

function pickModel(registry, requestedId) {
  const enabled = registry.models.filter(entry => entry.enabled);
  const wantId = typeof requestedId === "string" && requestedId.trim().length > 0 ? requestedId.trim() : registry.defaultModel;
  const exact = enabled.find(entry => entry.id === wantId);
  if (exact) return exact;
  const byPair = enabled.find(entry => `${entry.provider}/${entry.model}` === wantId || entry.model === wantId);
  if (byPair) return byPair;
  const known = enabled.map(entry => entry.id).join(", ") || "(none)";
  throw new Error(`aux-models: no enabled auxiliary model "${wantId}" in ${registry.path}; known ids: ${known}`);
}

/* -------------------------------------------------------------------------- */
/* settings page: host half (routes consumed by client.js)                     */
/* -------------------------------------------------------------------------- */

// ---------------------------------------------------------------- batch: several subtasks at once
//
// One delegation is a round trip; a batch is throughput. Every task starts at the
// same time, nothing waits for the previous answer, and a dead task never sinks the
// others — the caller gets a per-task result table and decides what to redo.

const BATCH_MAX_TASKS = 8;

/** Currency label, kept in one place so the sign survives every edit. */
function MONEY(value) {
  return "$" + Number(value).toFixed(4);
}

function batchItems(args) {
  const raw = Array.isArray(args?.tasks) ? args.tasks : [];
  const items = [];
  for (const raw0 of raw.slice(0, BATCH_MAX_TASKS)) {
    if (typeof raw0 === "string") {
      if (raw0.trim().length > 0) items.push({ task: raw0.trim() });
      continue;
    }
    if (raw0 && typeof raw0.task === "string" && raw0.task.trim().length > 0) {
      items.push({
        task: raw0.task.trim(),
        model: typeof raw0.model === "string" && raw0.model.trim().length > 0 ? raw0.model.trim() : undefined,
        tools: raw0.tools === true ? true : raw0.tools === false ? false : undefined,
        maxTokens: Number.isFinite(raw0.max_tokens) ? raw0.max_tokens : undefined,
      });
    }
  }
  return items;
}

function batchExcerpt(text, limit = 320) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function runBatch(ctx, settings, args, exec) {
  const items = batchItems(args);
  if (items.length === 0) {
    throw new Error("aux-models: aux_delegate_batch requires `tasks` — 1 to 8 items, each a string or { task, model?, tools?, max_tokens? }");
  }

  const registry = await loadRegistry(settings);
  const stats = readStatsSync(settings);
  const evaluations = readEvalSync(settings);
  const routing = registry.routing;
  const sharedTools = args?.tools === true;
  const sharedMaxTokens = Number.isFinite(args?.max_tokens) ? args.max_tokens : DEFAULT_MAX_TOKENS;
  const system = typeof args?.system === "string" && args.system.length > 0 ? args.system : registry.defaultSystem;
  const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
  const budget = Number.isFinite(args?.max_cost) ? args.max_cost : routing.maxCostPerCall * items.length;

  const plans = items.map((item) => {
    const useTools = item.tools === true || (sharedTools && item.tools !== false);
    const decision = routeTask(registry, stats, item.task, {
      tools: useTools,
      evaluations,
      minTier: Number.isFinite(args?.min_tier) ? args.min_tier : undefined,
      strategy: args?.strategy,
      maxCost: budget,
      config: settings,
    });
    const entry = item.model !== undefined ? pickModel(registry, item.model) : decision.chosen;
    if (!entry) {
      throw new Error(`aux-models: no auxiliary model fits "${batchExcerpt(item.task, 60)}"; raise max_cost or relax tools/min_tier`);
    }
    const maxTokens = item.maxTokens ?? sharedMaxTokens;
    const estimate = estimateCost(entry, estimateTokens(item.task) + 200, maxTokens);
    return { item, decision, entry, useTools, maxTokens, estimate: Number.isFinite(estimate) ? estimate : 0 };
  });

  const estimatedTotal = plans.reduce((sum, plan) => sum + plan.estimate, 0);
  if (estimatedTotal > budget) {
    throw new Error(
      `aux-models: this batch would cost about ${MONEY(estimatedTotal)} (${plans.length} tasks: ${plans
        .map(plan => `${plan.entry.id} ${plan.estimate.toFixed(4)}`)
        .join(", ")}), over the ${MONEY(budget)} budget; pass a larger max_cost or split the batch`,
    );
  }

  const startedAt = Date.now();
  let spent = 0;

  const runOne = async (plan) => {
    const timer = withTimeout(exec?.signal, timeoutMs);
    const beganAt = Date.now();
    try {
      const options = {
        sessionId: exec?.sessionId,
        system,
        maxTokens: plan.maxTokens,
        temperature: Number.isFinite(settings.temperature) ? settings.temperature : undefined,
        settings,
        routing,
        budget: plan.estimate * 2 + 0.01,
      };
      const result = plan.useTools
        ? await delegateWithTools(ctx, plan.entry, plan.item.task, options, timer.signal, exec)
        : { ...(await streamOnceWithHeadroom(ctx, plan.entry, plan.item.task, options, timer.signal)), rounds: 1, toolCalls: 0, used: [] };
      const usage = usageTokens(result.usage);
      const tokens = {
        in: Number.isFinite(result.tokensIn) ? result.tokensIn : usage.input,
        out: Number.isFinite(result.tokensOut) ? result.tokensOut : usage.output,
      };
      const cost = Number.isFinite(result.spent) ? result.spent : estimateCost(plan.entry, tokens.in, tokens.out);
      if (Number.isFinite(cost)) spent += cost;
      recordOutcome(settings, plan.entry, plan.decision.taskType, {
        ok: true,
        quality: 1,
        latencyMs: Date.now() - beganAt,
        tokensIn: tokens.in,
        tokensOut: tokens.out,
      });
      return {
        ok: true,
        id: plan.entry.id,
        model: `${plan.entry.provider}/${plan.entry.model}`,
        taskType: plan.decision.taskType,
        text: String(result.text ?? ""),
        elapsedMs: Date.now() - beganAt,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        costUsd: Number.isFinite(cost) ? Number(cost.toFixed(6)) : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordOutcome(settings, plan.entry, plan.decision.taskType, {
        ok: false,
        message,
        latencyMs: Date.now() - beganAt,
      });
      return {
        ok: false,
        id: plan.entry.id,
        model: `${plan.entry.provider}/${plan.entry.model}`,
        taskType: plan.decision.taskType,
        error: message,
        elapsedMs: Date.now() - beganAt,
      };
    } finally {
      timer.dispose();
    }
  };

  const results = await Promise.all(plans.map(runOne));
  const elapsedMs = Date.now() - startedAt;
  const done = results.filter(result => result.ok).length;

  const lines = [
    `批量：${results.length} 个任务并发 · 完成 ${done}/${results.length} · 墙钟 ${(elapsedMs / 1000).toFixed(1)}s · 花费 ≈${MONEY(spent)}`,
    "",
    ...results.map((result, index) => {
      const head = result.ok
        ? `${index + 1}. ✓ ${result.id}（${result.model}）· ${(result.elapsedMs / 1000).toFixed(1)}s · ${result.costUsd !== undefined ? MONEY(result.costUsd) : "价格未知"} · ${result.rounds} 轮${result.toolCalls ? ` / ${result.toolCalls} 次工具` : ""}`
        : `${index + 1}. ✗ ${result.id}（${result.model}）· ${(result.elapsedMs / 1000).toFixed(1)}s · ${batchExcerpt(result.error, 160)}`;
      if (!result.ok) return head;
      return `${head}\n   ${batchExcerpt(result.text)}`;
    }),
  ];

  return {
    report: lines.join("\n"),
    results,
    done,
    total: results.length,
    spentUsd: Number(spent.toFixed(6)),
    elapsedMs,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Reject cross-site writes: the settings page is same-origin by construction. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function writeRegistryFile(config, registryObject) {
  const path = registryPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registryObject, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  registryCache.path = null;
  registryCache.mtimeMs = -1;
  registryCache.registry = null;
  return path;
}

/** Everything the settings page renders, in one round trip. */
async function registryStateView(config) {
  const registry = await loadRegistry(config);
  const stats = readStatsSync(config);
  const evaluations = readEvalSync(config);
  const channels = registry.channels.map(channel => ({
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    multiplier: channel.multiplier,
    cacheHitRate: channel.cacheHitRate,
    stability: channel.stability,
    enabled: channel.enabled,
    models: channel.models.map(entry => {
      const price = effectivePricing(entry);
      const quality = {};
      for (const type of TASK_TYPES) {
        quality[type] = qualityEstimate(entry, stats, type, evaluations);
      }
      return {
        id: entry.id,
        label: entry.label,
        model: entry.model,
        mapsTo: entry.mapsTo,
        qualityTier: entry.qualityTier,
        strengths: entry.strengths,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        supportsTools: entry.supportsTools,
        enabled: entry.enabled,
        notes: entry.notes,
        pricing: entry.pricing,
        effective: { inputPerM: price.inputPerM, outputPerM: price.outputPerM, known: price.known },
        health: healthOf(entry, stats, registry.routing),
        quality,
        evaluation: evaluations.models?.[entry.id]
          ? {
              pass: evaluations.models[entry.id].pass,
              total: evaluations.models[entry.id].total,
              rate: evaluations.models[entry.id].rate,
              avgMs: evaluations.models[entry.id].avgMs,
              cost: evaluations.models[entry.id].cost,
            }
          : undefined,
      };
    }),
  }));
  let spent = 0;
  let calls = 0;
  for (const [key, cell] of Object.entries(stats.cells ?? {})) {
    if (!cell || typeof cell !== "object") continue;
    calls += Number.isFinite(cell.n) ? cell.n : 0;
    const modelId = String(key).split("|")[0];
    const entry = registry.models.find(model => model.id === modelId);
    if (!entry) continue;
    const price = effectivePricing(entry);
    if (!price.known) continue;
    spent += ((cell.tokensIn ?? 0) / 1e6) * price.inputPerM + ((cell.tokensOut ?? 0) / 1e6) * price.outputPerM;
  }
  return {
    ok: true,
    path: registry.path,
    statsPath: statsPath(config),
    missing: registry.missing,
    migrated: registry.migrated,
    defaultModel: registry.defaultModel,
    defaultSystem: registry.defaultSystem,
    weights: registry.weights,
    routing: registry.routing,
    taskTypes: TASK_TYPES,
    channels,
    totals: { calls, usd: Number(spent.toFixed(4)) },
  };
}

/* -------------------------------------------------------------------------- */
/* gateway routes: llm-pi-ai provider rows, written through configEditor       */
/* -------------------------------------------------------------------------- */

const GATEWAY_APIS = ["openai-completions", "openai-responses", "anthropic-messages"];

/** Locate the llm-pi-ai profile row that owns the provider dictionary. */
function piAiRow(ctx) {
  const editor = ctx.get("configEditor");
  if (!editor) return { editor: null, entry: null, reason: "configEditor 服务未加载" };
  let rows;
  try {
    rows = editor.entries();
  } catch (error) {
    return { editor: null, entry: null, reason: describeFailure(error) };
  }
  const entry =
    rows.find(row => String(row?.options?.name ?? "") === "@deepseek-ai/dsh-llm-pi-ai") ??
    rows.find(row => String(row?.options?.id ?? "") === "llm-pi-ai") ??
    null;
  return { editor, entry, reason: entry ? null : "这个 profile 里没有 llm-pi-ai 行，无法新增网关路由" };
}

function modelIdOf(model) {
  if (typeof model === "string") return model;
  return typeof model?.id === "string" ? model.id : "";
}

/** Configured/absent state of one apiKeyEnv, for the page's badge. */
async function credentialState(ctx, ref) {
  if (!ref) return { ref: "", configured: false, writable: false };
  const credentials = ctx.get("credentials");
  if (!credentials) return { ref, configured: false, writable: false, source: "credentials 服务未加载" };
  try {
    const info = await credentials.describe(ref);
    return { ref, configured: !!info?.configured, writable: !!info?.writable, source: info?.source };
  } catch (error) {
    return { ref, configured: false, writable: false, source: describeFailure(error) };
  }
}

/** The gateway half of the settings page: which routes exist, and their health. */
async function gatewayRoutesView(ctx) {
  const { editor, entry, reason } = piAiRow(ctx);
  if (!editor) return { ok: true, available: false, reason, apis: GATEWAY_APIS, providers: [] };
  if (!entry) return { ok: true, available: true, entryId: null, reason, apis: GATEWAY_APIS, providers: [] };
  const config = entry.options?.config ?? {};
  const providers = [];
  for (const [id, profile] of Object.entries(config.providers ?? {})) {
    providers.push({
      id,
      displayName: typeof profile?.displayName === "string" ? profile.displayName : id,
      api: typeof profile?.api === "string" ? profile.api : "",
      baseURL: typeof profile?.baseURL === "string" ? profile.baseURL : "",
      apiKeyEnv: typeof profile?.apiKeyEnv === "string" ? profile.apiKeyEnv : "",
      models: Array.isArray(profile?.models) ? profile.models.map(modelIdOf).filter(Boolean) : [],
      credential: await credentialState(ctx, profile?.apiKeyEnv),
    });
  }
  return { ok: true, available: true, entryId: String(entry.options?.id ?? ""), apis: GATEWAY_APIS, providers };
}

function validateRouteBody(body) {
  const problems = [];
  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(provider)) {
    problems.push("路由 id 必须是小写字母开头的连字符标识（如 dieqi-img）");
  }
  const api = GATEWAY_APIS.includes(body?.api) ? body.api : "";
  if (!api) problems.push(`协议必须是 ${GATEWAY_APIS.join(" / ")} 之一`);
  const baseURL = typeof body?.baseURL === "string" ? body.baseURL.trim().replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^\s]+$/.test(baseURL)) problems.push("baseURL 必须以 http(s):// 开头");
  const apiKeyEnv = typeof body?.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(apiKeyEnv)) problems.push("密钥变量名必须是环境变量形式（如 DIEQI_IMG_KEY）");
  const models = [];
  for (const raw of Array.isArray(body?.models) ? body.models : []) {
    const id = modelIdOf(raw).trim();
    if (!id) continue;
    models.push({
      id,
      name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : id,
      contextWindow: clamp(finiteOr(raw?.contextWindow, 262144), 1024, 4000000),
      maxTokens: clamp(finiteOr(raw?.maxTokens, 32768), 256, 262144),
      input: ["text"],
    });
  }
  if (models.length === 0) problems.push("至少给一个模型 id");
  return {
    problems,
    value: {
      provider,
      displayName: typeof body?.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : provider,
      api,
      baseURL,
      apiKeyEnv,
      models,
      apiKey: typeof body?.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : "",
    },
  };
}

/**
 * Create or replace one llm-pi-ai provider route: optionally store the key in
 * the credentials service, then persist the provider through configEditor so
 * the Loader validates and reloads it like any hand-written row.
 */
async function upsertGatewayRoute(ctx, body) {
  const { problems, value } = validateRouteBody(body);
  if (problems.length > 0) return { status: 400, body: { ok: false, error: problems.join("；") } };
  const { editor, entry, reason } = piAiRow(ctx);
  if (!editor || !entry) return { status: 503, body: { ok: false, error: reason ?? "llm-pi-ai 行不可编辑" } };

  if (value.apiKey) {
    const credentials = ctx.get("credentials");
    if (!credentials) return { status: 503, body: { ok: false, error: "credentials 服务未加载，无法保存密钥" } };
    try {
      await credentials.set(value.apiKeyEnv, value.apiKey);
    } catch (error) {
      return { status: 500, body: { ok: false, error: `保存密钥失败：${describeFailure(error)}` } };
    }
  }

  const profile = {
    displayName: value.displayName,
    api: value.api,
    baseURL: value.baseURL,
    apiKeyEnv: value.apiKeyEnv,
    models: value.models,
  };
  try {
    await editor.edit(entry, current => {
      const providers =
        current && typeof current === "object" && current.providers && typeof current.providers === "object"
          ? current.providers
          : {};
      return { ...current, providers: { ...providers, [value.provider]: profile } };
    });
  } catch (error) {
    return { status: 500, body: { ok: false, error: `写入 llm-pi-ai 失败：${describeFailure(error)}` } };
  }
  const after = piAiRow(ctx);
  return {
    status: 200,
    body: {
      ok: true,
      provider: value.provider,
      models: value.models.map(model => model.id),
      entryId: after.entry ? String(after.entry.options?.id ?? "") : null,
      credential: await credentialState(ctx, value.apiKeyEnv),
    },
  };
}

/**
 * Drop one llm-pi-ai provider route. Refuses while an enabled auxiliary model
 * still points at it — otherwise the registry silently loses its route and the
 * next delegation fails with "unknown provider".
 */
async function removeGatewayRoute(ctx, body, config) {
  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(provider)) {
    return { status: 400, body: { ok: false, error: "路由 id 必须是小写字母开头的连字符标识" } };
  }
  const { editor, entry, reason } = piAiRow(ctx);
  if (!editor || !entry) return { status: 503, body: { ok: false, error: reason ?? "llm-pi-ai 行不可编辑" } };
  const here = entry.options?.config ?? {};
  const providers = here.providers && typeof here.providers === "object" ? here.providers : {};
  if (!(provider in providers)) {
    return { status: 404, body: { ok: false, error: `没有名为 ${provider} 的路由` } };
  }

  const apiKeyEnv = typeof providers[provider]?.apiKeyEnv === "string" ? providers[provider].apiKeyEnv : "";
  let inUse = [];
  try {
    const registry = await loadRegistry(config);
    inUse = registry.models.filter(entry => entry.provider === provider && entry.enabled).map(entry => entry.id);
  } catch {
    /* an unreadable registry must not block removing a route */
  }
  if (inUse.length > 0) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `辅助模型还在用 ${provider}：${inUse.join(", ")}；先在「辅助模型」里删掉这些条目，再删路由`,
        models: inUse,
      },
    };
  }

  try {
    await editor.edit(entry, current => {
      const next = { ...((current && current.providers) || {}) };
      delete next[provider];
      return { ...current, providers: next };
    });
  } catch (error) {
    return { status: 500, body: { ok: false, error: `写入 llm-pi-ai 失败：${describeFailure(error)}` } };
  }

  const after = piAiRow(ctx);
  const remaining = Object.keys((after.entry?.options?.config?.providers) ?? {});
  const stillReferenced = Object.values(after.entry?.options?.config?.providers ?? {}).some(
    profile => typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv === apiKeyEnv,
  );
  return {
    status: 200,
    body: {
      ok: true,
      provider,
      providers: remaining,
      credentialKept: !!apiKeyEnv && stillReferenced,
      note: apiKeyEnv
        ? stillReferenced
          ? `${apiKeyEnv} 仍被其他路由引用，密钥保留`
          : `${apiKeyEnv} 已不被任何路由引用；密钥仍留在凭据库里（需要时在 Models 页删除）`
        : undefined,
    },
  };
}

/** Minimal redirect-following GET; fetch is unusable behind this machine's dead proxy. */function fetchText(url, headers, redirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`不是合法 URL：${url}`));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const request = lib.request(parsed, { method: "GET", headers, timeout: 20000 }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && typeof response.headers.location === "string" && redirects > 0) {
        response.resume();
        resolve(fetchText(new URL(response.headers.location, parsed).toString(), headers, redirects - 1));
        return;
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("请求超时（20s）")));
    request.on("error", reject);
    request.end();
  });
}

/** Ask the gateway which models it serves, so the form can fill itself. */
async function discoverGatewayModels(ctx, body) {
  const baseURL = String(body?.baseURL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(baseURL)) {
    return { status: 400, body: { ok: false, error: "baseURL 必须以 http(s):// 开头" } };
  }
  const api = GATEWAY_APIS.includes(body?.api) ? body.api : "openai-completions";
  const apiKeyEnv = typeof body?.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
  let key = typeof body?.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : "";
  if (!key && apiKeyEnv) {
    const credentials = ctx.get("credentials");
    if (credentials) {
      try {
        const resolved = await credentials.resolve(apiKeyEnv);
        if (resolved && typeof resolved.value === "string") key = resolved.value;
      } catch {
        /* fall through to the missing-key message */
      }
    }
  }
  if (!key) {
    return {
      status: 400,
      body: { ok: false, error: `没有可用密钥：先填「密钥值」，或确认凭据库里有 ${apiKeyEnv || "(未填变量名)"}` },
    };
  }
  const url =
    api === "anthropic-messages"
      ? /\/v1$/.test(baseURL)
        ? `${baseURL}/models?limit=1000`
        : `${baseURL}/v1/models?limit=1000`
      : `${baseURL}/models`;
  const headers =
    api === "anthropic-messages"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01", accept: "application/json" }
      : { authorization: `Bearer ${key}`, accept: "application/json" };
  try {
    const response = await fetchText(url, headers);
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return { status: 200, body: { ok: false, url, status: response.status, error: "响应不是 JSON（可能打到了网页）" } };
    }
    const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
    const models = list.map(item => String(item?.id ?? item?.name ?? "").replace(/^models\//, "")).filter(Boolean);
    const ok = response.status < 400 && models.length > 0;
    return {
      status: 200,
      body: {
        ok,
        url,
        status: response.status,
        models,
        error: ok ? undefined : response.status >= 400 ? `${response.status}: ${response.text.slice(0, 300)}` : "网关没有返回模型列表",
      },
    };
  } catch (error) {
    return { status: 200, body: { ok: false, url, error: describeFailure(error) } };
  }
}

/** Route handlers behind the Settings page. Exported for offline tests. */

/*
 * Eval console: the settings page can re-run the task bank and watch it happen.
 * The runner is a child process (eval-runner.mjs) because a full matrix is
 * minutes long and must not block the host; progress travels through a state
 * file so a page reload still shows the live position.
 */
const evalChild = { child: null, startedAt: 0, tail: [], exitCode: null };

function evalRunnerPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "eval-runner.mjs");
}

function evalStatePath() {
  return join(dshHome(), "aux-eval-state.json");
}

function evalConfigPath() {
  return join(dshHome(), "aux-eval-config.json");
}

function readEvalConfig() {
  try {
    const parsed = JSON.parse(readFileSync(evalConfigPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeEvalConfig(next) {
  const path = evalConfigPath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readEvalState() {
  try {
    return JSON.parse(readFileSync(evalStatePath(), "utf8"));
  } catch {
    return null;
  }
}

/** Every task bank this machine can see, whether it is runnable or not. */
function evalBanks() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    { id: "bundled", label: "内置题库（随插件）", path: join(here, "aux-eval-tasks.json") },
    { id: "draft", label: "开发草稿（含新题）", path: "F:/DS_WorkSpace/eval-build/aux-eval-tasks.draft.json" },
    { id: "mined", label: "会话挖题候选（需人工改写）", path: "F:/DS_WorkSpace/eval-build/aux-eval-candidates.json" },
  ];
  const custom = readEvalConfig().bank;
  if (typeof custom === "string" && custom.length > 0 && !candidates.some((b) => b.path === custom)) {
    candidates.push({ id: "custom", label: `自定义：${custom}`, path: custom });
  }
  return candidates.map((bank) => {
    let tasks = 0;
    let usable = false;
    let mtimeMs = -1;
    let types = [];
    try {
      mtimeMs = statSync(bank.path).mtimeMs;
      const parsed = JSON.parse(readFileSync(bank.path, "utf8"));
      if (Array.isArray(parsed.tasks)) {
        tasks = parsed.tasks.length;
        usable = tasks > 0;
        types = [...new Set(parsed.tasks.map((t) => t.type).filter(Boolean))];
      } else if (Array.isArray(parsed.candidates)) {
        tasks = parsed.candidates.length;
      }
    } catch {
      // A missing bank is listed as such, not hidden: the user may fix the path.
    }
    return { ...bank, tasks, usable, types, mtimeMs };
  });
}

function evalLastRun() {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome(), "aux-eval.json"), "utf8"));
    const models = Object.entries(parsed.models ?? {}).map(([id, m]) => ({
      id,
      pass: m.pass,
      total: m.total,
      rate: m.rate,
      avgMs: m.avgMs,
      cost: m.cost,
      errors: Object.values(m.tasks ?? {}).filter((c) => c && c.error).length,
    }));
    return {
      ranAt: parsed.ranAt ?? null,
      source: parsed.source ?? null,
      spentUsd: parsed.spentUsd ?? null,
      tasks: (parsed.tasks ?? []).length,
      models: models.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || (a.cost ?? 0) - (b.cost ?? 0)),
    };
  } catch {
    return null;
  }
}

function evalSummary() {
  return {
    ok: true,
    config: readEvalConfig(),
    banks: evalBanks(),
    running: Boolean(evalChild.child),
    state: readEvalState(),
    last: evalLastRun(),
  };
}

function settingsHandlers(ctx, config) {
  const state = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    try {
      sendJson(res, 200, await registryStateView(config));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const save = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    if (!body || typeof body.registry !== "object" || body.registry === null) {
      sendJson(res, 400, { ok: false, error: "body must be { registry: {...} }" });
      return;
    }
    // Validate before touching the file: a bad write disables every auxiliary
    // route until someone edits the JSON by hand.
    let probe;
    try {
      probe = buildRegistry(body.registry, registryPath(config));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (probe.models.length === 0) {
      sendJson(res, 400, { ok: false, error: "registry would have no model" });
      return;
    }
    try {
      const path = writeRegistryFile(config, body.registry);
      sendJson(res, 200, { ok: true, path, models: probe.models.map(entry => entry.id) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const test = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    const modelId = typeof body?.modelId === "string" ? body.modelId : "";
    if (modelId.length === 0) {
      sendJson(res, 400, { ok: false, error: "body must be { modelId, task? }" });
      return;
    }
    const task = typeof body?.task === "string" && body.task.length > 0
      ? body.task
      : "In one sentence: name yourself and the kind of task you are best at.";
    const startedAt = Date.now();
    try {
      const registry = await loadRegistry(config);
      const entry = pickModel(registry, modelId);
      const timer = withTimeout(undefined, clamp(finiteOr(config.testTimeoutMs, 60000), 5000, 180000));
      try {
        const result = await streamOnce(ctx, entry, task, { maxTokens: 400 }, timer.signal);
        const price = effectivePricing(entry);
        const tokens = usageTokens(result.usage);
        const cost = price.known ? (tokens.input / 1e6) * price.inputPerM + (tokens.output / 1e6) * price.outputPerM : undefined;
        sendJson(res, 200, {
          ok: true,
          model: `${entry.provider}/${entry.model}`,
          text: result.text,
          elapsedMs: Date.now() - startedAt,
          tokens,
          costUsd: Number.isFinite(cost) ? Number(cost.toFixed(6)) : undefined,
        });
      } finally {
        timer.dispose();
      }
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt });
    }
  };

  const gatewayRoutes = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    try {
      sendJson(res, 200, await gatewayRoutesView(ctx));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: describeFailure(error) });
    }
  };

  const gatewaySave = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
      return;
    }
    try {
      const result = await upsertGatewayRoute(ctx, body);
      sendJson(res, result.status, result.body);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: describeFailure(error) });
    }
  };

  const gatewayDiscover = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    try {
      const result = await discoverGatewayModels(ctx, body ?? {});
      sendJson(res, result.status, result.body);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: describeFailure(error) });
    }
  };

  const gatewayRemove = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    try {
      const result = await removeGatewayRoute(ctx, body ?? {}, config);
      sendJson(res, result.status, result.body);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: describeFailure(error) });
    }
  };

  // Dry-run the router from the settings page: the same decision aux_route
  // makes, so the user can see the classification, the ranking and the price
  // before delegating anything for real.
  const preview = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    const task = typeof body?.task === "string" ? body.task.trim() : "";
    if (task.length === 0) {
      sendJson(res, 400, { ok: false, error: "body must be { task, tools?, strategy?, min_tier? }" });
      return;
    }
    try {
      const registry = await loadRegistry(config);
      const stats = readStatsSync(config);
      const decision = routeTask(registry, stats, task, {
        tools: body?.tools === true,
        evaluations: readEvalSync(config),
        minTier: Number.isFinite(body?.min_tier) ? body.min_tier : undefined,
        strategy: typeof body?.strategy === "string" ? body.strategy : undefined,
      });
      sendJson(res, 200, {
        ok: true,
        task,
        taskType: decision.taskType,
        classifierConfidence: Number(decision.classification.confidence.toFixed(3)),
        hits: decision.classification.hits,
        weights: decision.weights,
        confidence: Number(decision.confidence.toFixed(3)),
        chosen: decision.chosen ? { id: decision.chosen.id, model: decision.chosen.model, label: decision.chosen.label } : null,
        ask: decision.ask,
        askReason: decision.askReason,
        estimate: decision.estimate
          ? {
            inputTokens: decision.estimate.inputTokens,
            estInput: decision.estimate.estInput,
            estOutput: decision.estimate.estOutput,
            usd: Number((decision.estimate.cost ?? 0).toFixed(6)),
          }
          : null,
        ranking: decision.ranking.map(item => ({
          id: item.entry.id,
          score: Number(item.score.toFixed(3)),
          quality: Number(item.quality.value.toFixed(3)),
          cheapness: Number(item.cheapness.toFixed(3)),
          penalty: Number(item.health.penalty.toFixed(3)),
          tier: item.entry.qualityTier,
          price: effectivePricing(item.entry),
        })),
        rejected: decision.rejected.map(item => ({ id: item.entry.id, reason: item.reason })),
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // 「价格设置」页（dsh-balance 的定价段）原本要求桌面壳通过
  // window.dshDesktop.balancePrices 提供读写桥，而本构建里根本没有这个桥，
  // 页面只会显示「价格设置桥接不可用」。这里在宿主侧补一个同契约的后端，
  // 由 /dsh-aux-models/balance-prices 暴露，浏览器半页再据此填 window 桥。
  // 数据存进 price-table.json 的 balance 段（与总价表同一个真源文件）。
  const BALANCE_FIELDS = ["cacheMiss", "cacheHit", "output"];
  const balanceGet = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    try {
      const table = JSON.parse(readFileSync(priceTablePath(config), "utf8"));
      sendJson(res, 200, {
        ok: true,
        prices: table.balance && typeof table.balance === "object" ? table.balance : {},
        defaults: balanceDefaults(table),
        path: priceTablePath(config),
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const balanceSave = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    const body = await readJsonBody(req);
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    if (model.length === 0) {
      sendJson(res, 400, { ok: false, error: "body must be { model, prices? , reset? }" });
      return;
    }
    try {
      const table = JSON.parse(readFileSync(priceTablePath(config), "utf8"));
      table.balance = table.balance && typeof table.balance === "object" ? table.balance : {};
      if (body?.reset === true) {
        delete table.balance[model];
      } else {
        const parsed = {};
        for (const tier of ["peak", "offpeak"]) {
          const src = body?.prices?.[tier];
          if (!src || typeof src !== "object") continue;
          const values = {};
          for (const field of BALANCE_FIELDS) {
            const value = Number(src[field]);
            if (!Number.isFinite(value) || value < 0 || value > 1000) {
              sendJson(res, 400, { ok: false, error: `price ${tier}.${field} must be 0~1000` });
              return;
            }
            values[field] = value;
          }
          parsed[tier] = values;
        }
        if (Object.keys(parsed).length === 0) {
          sendJson(res, 400, { ok: false, error: "prices must carry peak and/or offpeak" });
          return;
        }
        table.balance[model] = { ...(table.balance[model] ?? {}), ...parsed };
      }
      const tmp = `${priceTablePath(config)}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8");
      renameSync(tmp, priceTablePath(config));
      sendJson(res, 200, { ok: true, model, prices: table.balance[model] ?? null });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    "/dsh-aux-models/state": state,
    "/dsh-aux-models/balance-prices": (req, res) => (req.method === "POST" ? balanceSave(req, res) : balanceGet(req, res)),
    "/dsh-aux-models/save": save,
    "/dsh-aux-models/test": test,
    "/dsh-aux-models/preview": preview,
    "/dsh-aux-models/routes": gatewayRoutes,
    "/dsh-aux-models/route": gatewaySave,
    "/dsh-aux-models/route-remove": gatewayRemove,
    "/dsh-aux-models/discover": gatewayDiscover,
    "/dsh-aux-models/eval": evalIndex,
    "/dsh-aux-models/eval/run": evalStart,
    "/dsh-aux-models/eval/status": evalStatus,
    "/dsh-aux-models/eval/stop": evalStop,
  };
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                     */
/* -------------------------------------------------------------------------- */

export async function apply(ctx, config) {
  const settings = config && typeof config === "object" ? config : {};

  ctx.effect(() => ctx.systemPrompt.section({
    // Order 550 sits right after PLAN_POLICY: this is a behavioural rule, not a
    // tool doc, and the model reads policies before it reads tool manuals.
    name: "aux-models:policy",
    order: 550,
    text: () => {
      try {
        return buildPolicy(settings);
      } catch {
        return "";
      }
    },
  }));

  ctx.effect(() => ctx.systemPrompt.section({
    name: "aux-models:routing",
    order: 2790,
    text: () => {
      try {
        return buildGuidance(settings);
      } catch {
        return "";
      }
    },
  }));

  ctx.tools.register({
    name: "aux_models",
    description: [
      "List the resident auxiliary models (third-party agent APIs) that this Harness can delegate a self-contained subtask to.",
      "Call this before delegating when you do not already know which auxiliary model is available, or when you need a model's strengths/price/context window to decide whether a task fits.",
      "Parameters: none. Returns one line per enabled model: id, label, provider/model route, quality tier, strengths (task types), effective price, context window, tool support, and the learned quality estimate with its sample count.",
    ].join("\n"),
    parameters: { type: "object", properties: {}, required: [] },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute() {
      const registry = await loadRegistry(settings);
      const stats = readStatsSync(settings);
      const enabled = registry.models.filter(entry => entry.enabled);
      if (enabled.length === 0) {
        return `No auxiliary model is enabled. Edit ${registry.path} and add channel → models entries.`;
      }
      const lines = enabled.map(entry => `- ${describe(entry, stats, registry.routing, readEvalSync(config))}${entry.id === registry.defaultModel ? " · default" : ""}`);
      const header = [
        registry.missing ? `Registry ${registry.path} does not exist yet; showing built-in defaults.` : `Registry ${registry.path}.`,
        `weights: quality ${registry.weights.quality} / cost ${registry.weights.cost}`,
        `routing: ask < ${registry.routing.askBelowConfidence}, ask > $${registry.routing.askAboveCost}, budget $${registry.routing.maxCostPerCall}, breaker ${registry.routing.breakerFailures}/${registry.routing.cooldownMinutes}min`,
      ].join(" · ");
      return [header, ...lines].join("\n");
    },
  });

  ctx.tools.register({
    name: "aux_route",
    description: [
      "Explain where a subtask WOULD be routed, without calling any model: this is the dry run.",
      "Returns the classified task type, the ranked candidates with their learned quality, effective price and estimated cost, the chosen model, and whether the choice is close enough to be worth asking a human.",
      "Use it when the user asks 'which auxiliary model would you use / how much would this cost', or before an expensive delegation.",
      "Parameters: task (required), tools (optional boolean — route for a read-only tool loop), min_tier (1-3 — force at least this quality tier), strategy (auto|cheap|best), max_cost (optional USD ceiling).",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The subtask text, as you would pass it to aux_delegate." },
        tools: { type: "boolean", description: "Route for a tool loop (only models with tool calling are considered)." },
        min_tier: { type: "number", description: "Minimum quality tier: 1 budget, 2 mid, 3 frontier." },
        strategy: { type: "string", enum: ["auto", "cheap", "best"], description: "auto balances quality and cost by the registry weights; cheap and best tilt the balance." },
        max_cost: { type: "number", description: "Optional USD ceiling for the estimate." },
        task_type: { type: "string", enum: TASK_TYPES, description: "Force a task type instead of the built-in classifier." },
      },
      required: ["task"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          taskType: { type: "string" },
          classifierConfidence: { type: "number" },
          chosen: { type: "string" },
          confidence: { type: "number" },
          ask: { type: "boolean" },
          estimateCostUsd: { type: "number" },
          report: { type: "string" },
        },
        required: ["taskType", "chosen", "report"],
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
    },
    async execute(args) {
      const task = typeof args?.task === "string" ? args.task : "";
      if (task.trim().length === 0) throw new Error("aux-models: aux_route requires a non-empty `task`");
      const registry = await loadRegistry(settings);
      const stats = readStatsSync(settings);
      const decision = routeTask(registry, stats, task, {
        tools: args?.tools === true,
        evaluations: readEvalSync(settings),
        minTier: Number.isFinite(args?.min_tier) ? args.min_tier : undefined,
        strategy: args?.strategy,
        maxCost: Number.isFinite(args?.max_cost) ? args.max_cost : undefined,
        taskType: args?.task_type,
      });
      const lines = [
        `任务类型 ${decision.taskType}（分类置信度 ${decision.classification.confidence.toFixed(2)}）`,
        `选中 ${decision.chosen.id} · 路由置信度 ${decision.confidence.toFixed(2)}${decision.ask ? ` · 建议先问一句：${decision.askReason}` : ""}`,
        `预估 ${decision.estimate.estInput} 入 + ${decision.estimate.estOutput} 出 tokens ≈ ${Number.isFinite(decision.estimate.cost) ? `$${decision.estimate.cost.toFixed(4)}` : "价格未知"}`,
        "",
        "排名：",
        ...decision.ranking.map((item, index) => {
          const quality = `质量 ${item.quality.value.toFixed(2)}（先验 ${item.quality.prior.toFixed(2)} / ${item.quality.samples} 样本）`;
          const cost = Number.isFinite(item.cost) ? `≈$${item.cost.toFixed(4)}` : "价格未知";
          const breaker = item.health.breaker ? ` · ⚠熔断中` : "";
          return `${index + 1}. ${item.entry.id} — 得分 ${item.score.toFixed(3)} · ${quality} · ${cost}${breaker}`;
        }),
      ];
      if (decision.rejected.length > 0) {
        lines.push("", "被排除：", ...decision.rejected.map(item => `- ${item.entry.id}: ${item.reason}`));
      }
      return {
        taskType: decision.taskType,
        classifierConfidence: decision.classification.confidence,
        chosen: decision.chosen.id,
        confidence: decision.confidence,
        ask: decision.ask,
        estimateCostUsd: decision.estimate.cost,
        report: lines.join("\n"),
      };
    },
  });

  ctx.tools.register({
    name: "aux_delegate",
    description: [
      "FIRST STEP for work that carries large material: hand ONE subtask to a resident auxiliary model (a third-party agent API registered as an LLM provider route) instead of doing it here. Reach for it when the job means reading ≥2 files or any file >150 lines, producing ≥40 lines of code or ≥300 words, digesting >2000 characters of text, or a side task that can run in parallel — and do NOT read the material yourself first, that defeats the point.",
      "Why first and not last: the auxiliary route bills separately and its tokens never enter this conversation's context, so delegating keeps the main model's context budget — and the attention that comes with a shorter context — for the parts that actually need this session. Same reason it can run while you keep working.",
      "Good candidates: generating or rewriting code, regex, SQL or a script; explaining an error or a diff; summarising, translating, restructuring or proofreading text; a one-off calculation, comparison or draft. The auxiliary model sees only what you put in `task` — it cannot read files, run commands, or see this conversation, so paste the needed excerpts.",
      "Omit `model` to let the router pick: it classifies the task into one of 7 types, blends the model's declared quality tier with its measured success rate for that type, and weighs that against the effective price. Pass `model` when you already know.",
      "Set `tools: true` when the helper should inspect the repository itself: it then gets the read-only allowlist (read / grep / glob by default) and may call them a few times before answering, which saves you pasting large files. Writes, shell commands and approvals are never handed over.",
      "A per-call budget applies inside the tool loop; when it is exceeded the call stops early and says so. Do not delegate work that needs writes, shell access, this session's state, or several dependent steps. If this tool fails, continue yourself — do not retry three times.",
      "Parameters: task (required), model (optional id from aux_models), strategy (auto|cheap|best), min_tier (1-3), max_cost (optional USD ceiling), system, max_tokens, tools, max_rounds.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete instruction for the auxiliary model, including any context it needs pasted in." },
        model: { type: "string", description: "Auxiliary model id from aux_models (or a `provider/model` pair). Omit to let the router choose." },
        strategy: { type: "string", enum: ["auto", "cheap", "best"], description: "auto balances quality and cost; cheap prefers the cheaper route; best prefers the highest quality tier." },
        min_tier: { type: "number", description: "Minimum quality tier when the router chooses (1 budget, 2 mid, 3 frontier)." },
        max_cost: { type: "number", description: "Optional USD ceiling for this call (overrides the registry default)." },
        system: { type: "string", description: "Optional system prompt for the auxiliary model." },
        max_tokens: { type: "number", description: "Optional cap on the auxiliary model's answer length." },
        tools: { type: "boolean", description: "Let the helper read files itself through the read-only allowlist instead of receiving pasted excerpts." },
        max_rounds: { type: "number", description: "Optional cap on tool rounds when tools is true." },
      },
      required: ["task"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          model: { type: "string" },
          text: { type: "string" },
          elapsedMs: { type: "number" },
          rounds: { type: "number" },
          toolCalls: { type: "number" },
          used: { type: "array", items: { type: "string" } },
          taskType: { type: "string" },
          routedBy: { type: "string" },
          costUsd: { type: "number" },
        },
        required: ["model", "text"],
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const task = typeof args?.task === "string" ? args.task : "";
      if (task.trim().length === 0) throw new Error("aux-models: aux_delegate requires a non-empty `task`");
      const limit = Number.isFinite(settings.maxInputChars) && settings.maxInputChars > 0 ? settings.maxInputChars : DEFAULT_MAX_INPUT_CHARS;
      const prompt = task.length > limit
        ? `${task.slice(0, limit)}\n\n[... truncated ${task.length - limit} characters by aux_delegate ...]`
        : task;

      const registry = await loadRegistry(settings);
      const stats = readStatsSync(settings);
      const useTools = args?.tools === true;
      const explicitModel = typeof args?.model === "string" && args.model.trim().length > 0 ? args.model : undefined;

      let decision;
      let entry;
      let routedBy;
      if (explicitModel) {
        entry = pickModel(registry, explicitModel);
        routedBy = "explicit";
        decision = { taskType: classifyTask(task).type, classification: classifyTask(task), estimate: {} };
      } else {
        decision = routeTask(registry, stats, prompt, {
          tools: useTools,
          evaluations: readEvalSync(settings),
          minTier: Number.isFinite(args?.min_tier) ? args.min_tier : undefined,
          strategy: args?.strategy,
          maxCost: Number.isFinite(args?.max_cost) ? args.max_cost : undefined,
        });
        entry = decision.chosen;
        routedBy = `router:${decision.taskType}`;
        if (decision.ask && settings.autoAsk === true) {
          const alternatives = decision.ranking.slice(0, 3).map((item, index) => `${index + 1}. ${item.entry.id}`).join("，");
          throw new Error(`aux-models: routing is close (${decision.askReason}); confirm which helper to use (${alternatives}) or pass model explicitly`);
        }
      }

      if (useTools && entry.supportsTools === false) {
        throw new Error(`aux-models: ${entry.id} is marked "supportsTools": false in the registry; call again without tools:true`);
      }

      const routing = registry.routing;
      const system = typeof args?.system === "string" && args.system.length > 0 ? args.system : registry.defaultSystem;
      const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
      const budget = Number.isFinite(args?.max_cost) ? args.max_cost : routing.maxCostPerCall;
      const timer = withTimeout(exec?.signal, timeoutMs);
      const startedAt = Date.now();
      try {
        const options = {
          sessionId: exec?.sessionId,
          system,
          maxTokens: Number.isFinite(args?.max_tokens) ? args.max_tokens : DEFAULT_MAX_TOKENS,
          temperature: Number.isFinite(settings.temperature) ? settings.temperature : undefined,
          settings,
          routing,
          budget,
          maxRounds: Number.isFinite(args?.max_rounds) ? args.max_rounds : undefined,
        };
        const attemptWith = async candidate => {
          const result = useTools
            ? await delegateWithTools(ctx, candidate, prompt, options, timer.signal, exec)
            : { ...(await streamOnceWithHeadroom(ctx, candidate, prompt, options, timer.signal)), rounds: 1, toolCalls: 0, used: [] };
          const elapsedMs = Date.now() - startedAt;
          // streamOnce() reports `usage`; delegateWithTools() reports tokensIn/tokensOut.
          // Without this fallback every single-shot delegation was costed at $0.
          const usage = usageTokens(result.usage);
          const tokens = {
            in: Number.isFinite(result.tokensIn) ? result.tokensIn : usage.input,
            out: Number.isFinite(result.tokensOut) ? result.tokensOut : usage.output,
          };
          const cost = result.spent ?? estimateCost(candidate, tokens.in, tokens.out);
          recordOutcome(settings, candidate, decision.taskType, {
            ok: true,
            quality: 1,
            latencyMs: elapsedMs,
            tokensIn: tokens.in,
            tokensOut: tokens.out,
          });
          return {
            model: `${candidate.provider}/${candidate.model}`,
            text: result.text,
            elapsedMs,
            rounds: result.rounds,
            toolCalls: result.toolCalls,
            used: result.used,
            taskType: decision.taskType,
            routedBy,
            costUsd: Number.isFinite(cost) ? Number(cost.toFixed(6)) : undefined,
            truncated: result.finishReason === "length",
          };
        };

        try {
          return await attemptWith(entry);
        } catch (error) {
          recordOutcome(settings, entry, decision.taskType, {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            latencyMs: Date.now() - startedAt,
          });
          // Upstreams die quietly: one transient failure should not turn into a
          // failed turn when the router already knows a second candidate.
          const transient = isTransientFailure(error);
          // A pinned model has no fallback chain, but a single 502 from the local
          // egress proxy should not end the turn. Retry the same route once.
          if (explicitModel !== undefined && transient) {
            await sleep(1200);
            try {
              const retried = await attemptWith(entry);
              retried.note = `aux-models: ${entry.id} failed once (${shortFailure(error)}); the retry succeeded`;
              return retried;
            } catch (again) {
              recordOutcome(settings, entry, decision.taskType, {
                ok: false,
                message: again instanceof Error ? again.message : String(again),
                latencyMs: Date.now() - startedAt,
              });
              throw new Error(`aux-models: ${entry.id} failed twice — first: ${shortFailure(error)}; retry: ${shortFailure(again)}`);
            }
          }
          const retry = explicitModel === undefined && settings.fallback !== false && transient
            ? nextCandidate(decision, entry)
            : undefined;
          if (!retry) throw error;
          try {
            const result = await attemptWith(retry);
            result.fellBackFrom = entry.id;
            result.note = `aux-models: ${entry.id} failed (${shortFailure(error)}); fell back to ${retry.id}`;
            return result;
          } catch (secondError) {
            recordOutcome(settings, retry, decision.taskType, {
              ok: false,
              message: secondError instanceof Error ? secondError.message : String(secondError),
              latencyMs: Date.now() - startedAt,
            });
            throw new Error(`aux-models: both ${entry.id} and ${retry.id} failed — ${entry.id}: ${shortFailure(error)}; ${retry.id}: ${shortFailure(secondError)}`);
          }
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw new Error(`aux-models: ${entry.provider}/${entry.model} timed out after ${timeoutMs}ms; continue this task yourself`);
        }
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        timer.dispose();
      }
    },
  });

  // Several independent subtasks at the same time: this is the throughput tool.
  // aux_delegate waits for one answer; aux_delegate_batch starts them all.
  ctx.tools.register({
    name: "aux_delegate_batch",
    description: [
      "Delegate 1 to 8 INDEPENDENT subtasks in parallel and collect the results in one call. Use it whenever you have several self-contained pieces of work that do not depend on each other (review N files, summarise N documents, run N checks) — one aux_delegate per piece would cost one round trip each.",
      "Each task is routed on its own (or pinned with `model`), so a cheap task can go to a cheap model and a hard one to a strong model. A failing task is reported per line and never sinks the others.",
      "Parameters: tasks (required, 1-8 items: a string, or { task, model?, tools?, max_tokens? }), plus shared tools (boolean, give every task the read-only loop), system, max_tokens, max_cost (total USD ceiling for the batch, checked before anything is sent), strategy, min_tier.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "1-8 subtasks: a plain string, or an object { task, model?, tools?, max_tokens? }.",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "The subtask text, with all material inlined." },
              model: { type: "string", description: "Optional aux model id to pin this task." },
              tools: { type: "boolean", description: "Give this task the read-only tool loop." },
              max_tokens: { type: "number", description: "Output cap for this task." },
            },
            required: ["task"],
          },
        },
        tools: { type: "boolean", description: "Give every task the read-only tool loop (read/grep/glob)." },
        system: { type: "string", description: "Optional system prompt shared by every task." },
        max_tokens: { type: "number", description: "Default output cap per task (1600 unless set)." },
        max_cost: { type: "number", description: "Total USD ceiling for the whole batch; the call refuses to start above it." },
        strategy: { type: "string", enum: ["auto", "cheap", "best"], description: "Routing strategy for tasks without a pinned model." },
        min_tier: { type: "number", description: "Minimum quality tier (1-3) for routed tasks." },
      },
      required: ["tasks"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          report: { type: "string" },
          done: { type: "number" },
          total: { type: "number" },
          spentUsd: { type: "number" },
          elapsedMs: { type: "number" },
        },
        required: ["report", "done", "total"],
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
    },
    async execute(args, exec) {
      return runBatch(ctx, settings, args, exec);
    },
  });

  // Settings page: the host half of client.js. State, save and a one-shot test
  // call. All three are same-origin only; the page never sees a credential.
  ctx.inject(["webServer"], (webCtx) => {
    for (const [routePath, handler] of Object.entries(settingsHandlers(ctx, settings))) {
      ctx.effect(() => webCtx.webServer.register({ path: routePath, handler }));
    }
  });
  if (settings.debug === true) {
    ctx.tools.register({
      name: "aux_prompt_peek",
      description: "Diagnostic (enabled by aux-models config.debug): return the assembled aux-models prompt section verbatim.",
      parameters: { type: "object", properties: {}, required: [] },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      async execute() {
        const assembly = await ctx.systemPrompt.assemble();
        const mine = assembly.sections.find(section => section.name === "aux-models:routing");
        if (mine) return mine.text;
        return `(section missing; assembled sections: ${assembly.sections.map(section => section.name).join(", ")})`;
      },
    });
  }
}

export { loadRegistry, pickModel, routeTask, classifyTask, estimateCost, effectivePricing, buildGuidance, TASK_TYPES, qualityEstimate, isTransientFailure, registryStateView, writeRegistryFile, buildRegistry, settingsHandlers, gatewayRoutesView, upsertGatewayRoute, removeGatewayRoute, discoverGatewayModels, validateRouteBody, GATEWAY_APIS, runBatch };
