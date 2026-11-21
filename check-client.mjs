/**
 * Offline smoke test for the settings page browser half.
 *
 *   node check-client.mjs
 *
 * The bundle is hand-written (no build step), so this loads it the same way the
 * Harness does — window.__ModuleLoader__.load — with a fake React that renders
 * plain element trees, then walks the tree to prove the page actually builds
 * the gateway panel and the model cards.
 */
import { readFileSync } from "node:fs";

const failures = [];
function assert(label, condition, detail = "") {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` ${detail}`}`);
  if (!condition) failures.push(label);
}

const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");

let spec = null;
const window = { __ModuleLoader__: { load: value => { spec = value; } } };
new Function("window", source)(window);

assert("bundle registered itself", !!spec, "no __ModuleLoader__.load call");
assert("bundle id", spec && spec.id, "dsh-aux-models");
assert("factory is a function", spec && typeof spec.factory === "function");

/* fake react: elements are plain objects, hooks read a scripted list */
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity);
  const merged = flat.length > 0 ? { ...(props || {}), children: flat } : props || {};
  return { type, props: merged, children: flat };
}
const scripted = [];
let hookIndex = 0;
const useState = initial => {
  const index = hookIndex++;
  const value = index < scripted.length ? scripted[index] : typeof initial === "function" ? initial() : initial;
  return [value, () => {}];
};
const React = { createElement, useState, useEffect: () => {}, useMemo: v => v() };
const requireFn = name => {
  if (name === "react") return React;
  throw new Error(`unexpected require(${name})`);
};

const moduleExports = spec.factory(requireFn);
assert("inject declares slots", JSON.stringify(moduleExports.inject), '["slots"]');
assert("apply exported", typeof moduleExports.apply === "function");

/* the slot registration the Harness would perform */
let registered = null;
moduleExports.apply({
  slots: {
    inject: (_name, factory) => factory(),
    register: (key, Component) => {
      registered = { key, Component };
      return () => {};
    },
  },
});
assert("registered settings.section", registered && registered.key.name, "settings.section");
assert("section id", registered && registered.key.id, "aux-models");
assert("section order", registered && registered.key.order, 72);
// The nav row shows `label`; the slot catalog lists it as optional, so a missing
// label renders a nameless entry — pin it.
assert("section label", registered && registered.key.label, "辅助模型");

/* the 价格设置 page reads a bridge; contextBridge-exposed dshDesktop is frozen,
   so our install must land on the plain global instead */
assert(
  "installs the price bridge on the plain global",
  window.__dshBalancePrices && typeof window.__dshBalancePrices.get === "function" &&
    typeof window.__dshBalancePrices.save === "function" && typeof window.__dshBalancePrices.reset === "function",
  JSON.stringify(Object.keys(window.__dshBalancePrices || {})),
);
delete window.__dshBalancePrices;
window.dshDesktop = Object.freeze({ protocolVersion: 1 });
moduleExports.__internals.installBalanceBridge();
assert("survives a frozen dshDesktop", !!window.__dshBalancePrices, "bridge missing");
assert(
  "frozen shell object stays untouched",
  window.dshDesktop.balancePrices === undefined,
  JSON.stringify(Object.keys(window.dshDesktop)),
);

/* render the section with data already loaded (no fetch) */
const state = {
  ok: true,
  path: "F:\\DSH\\DSH-Home\\aux-models.json",
  statsPath: "F:\\DSH\\DSH-Home\\aux-stats.json",
  defaultModel: "gamma",
  defaultSystem: "",
  weights: { quality: 0.7, cost: 0.3 },
  routing: { askBelowConfidence: 0.15, askAboveCost: 0.05, maxCostPerCall: 0.5 },
  taskTypes: ["code_generation", "general"],
  totals: { calls: 3, usd: 0.0123 },
  channels: [
    {
      id: "chan-legacy",
      name: "示例分组 A",
      provider: "relay",
      multiplier: 0.14,
      cacheHitRate: 0.8,
      stability: 5,
      enabled: true,
      models: [
        {
          id: "alpha",
          label: "Aux Large",
          model: "aux-large",
          mapsTo: "",
          qualityTier: 3,
          strengths: ["code_generation"],
          contextWindow: 1050000,
          maxOutputTokens: 128000,
          supportsTools: true,
          enabled: true,
          notes: "",
          pricing: { inputPerM: 10, outputPerM: 50, source: "openrouter" },
          effective: { inputPerM: 0.392, outputPerM: 7, known: true },
          health: { breaker: false, recentFailures: 0, penalty: 0 },
          // /state reports each learned cell as an object; the bare-number form
          // is only a legacy shape. Keeping objects here is the regression guard
          // for the 0.7.3 blank page (best.value.toFixed is not a function).
          quality: {
            code_generation: { value: 0.95, samples: 4, effectiveSamples: 3.5, decay: 1, prior: 0.95, measured: 1 },
            general: { value: 0.9, samples: 0, effectiveSamples: 0, decay: 1, prior: 0.9, measured: 0.9 },
          },
          evaluation: { pass: 6, total: 6, rate: 1, avgMs: 12589, cost: 0.0407 },
        },
      ],
    },
  ],
};
const routes = {
  ok: true,
  available: true,
  entryId: "llm-pi-ai",
  apis: ["openai-completions", "openai-responses", "anthropic-messages"],
  providers: [
    {
      id: "relay",
      displayName: "中转站 GPT",
      api: "openai-completions",
      baseURL: "https://relay.example.com/v1",
      apiKeyEnv: "RELAY_API_KEY",
      models: ["aux-large"],
      credential: { ref: "RELAY_API_KEY", configured: true, writable: true, source: "store" },
    },
  ],
};
scripted.push(state, null, false, null, {}, routes);
hookIndex = 0;
const tree = registered.Component();

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  // Expand function components the way React would, so their text is visible.
  if (typeof node.type === "function") {
    texts(node.type(node.props), out);
    return out;
  }
  for (const child of node.children || []) texts(child, out);
  return out;
}

const flat = texts(tree).join(" | ");
// input values are not text children, collect them separately
function fieldValues(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) fieldValues(child, out);
    return out;
  }
  if (node.props) {
    for (const key of ["value", "placeholder", "aria-label", "title"]) {
      if (typeof node.props[key] === "string") out.push(node.props[key]);
    }
  }
  if (typeof node.type === "function") {
    fieldValues(node.type(node.props), out);
    return out;
  }
  for (const child of node.children || []) fieldValues(child, out);
  return out;
}
const fields = fieldValues(tree).join(" | ");
assert("renders the section title", flat.includes("辅助模型"), flat.slice(0, 120));
assert("renders totals", flat.includes("累计 3 次调用"), flat.slice(0, 200));
assert("renders the gateway panel", flat.includes("网关路由"), flat.slice(0, 400));
assert("lists the provider route", flat.includes("relay") && flat.includes("https://relay.example.com/v1"), flat.slice(0, 600));
assert("shows the credential badge", flat.includes("RELAY_API_KEY 已配置"), flat.slice(0, 600));
assert("offers 新增网关", flat.includes("+ 新增网关"), flat.slice(0, 600));
assert("offers route removal", flat.includes("删除"), flat.slice(0, 600));
assert("renders the model card", flat.includes("tier 3") && flat.includes("可带工具") && fields.includes("Aux Large"), `${flat.slice(-300)} || ${fields.slice(0, 300)}`);
assert(
  "renders learned quality from object cells",
  /当前学习质量最高：[^\n]*0\.95/.test(flat),
  `${(flat.match(/当前学习质量最高：[^\n]*/g) || []).join(" | ")} || ${flat.slice(-200)}`,
);
assert(
  "renders the last evaluation",
  /最近一次评测：6\/6/.test(flat),
  `${(flat.match(/最近一次评测：[^\n]*/g) || []).join(" | ")} || ${flat.slice(-200)}`,
);
assert("renders the price", flat.includes("$0.392/M"), flat.slice(-400));
assert("renders the save button", flat.includes("保存"), flat.slice(-200));
assert("renders the route preview", flat.includes("路由预览") && flat.includes("算一下"), flat.slice(0, 800));
assert("preview explains itself", fields.includes("把一段任务贴进来"), fields.slice(0, 600));
assert("renders the eval console", flat.includes("评测") && flat.includes("开始评测"), flat.slice(0, 900));
assert("eval console has a bank picker", flat.includes("题库来源"), flat.slice(-600));
assert("eval console has a progress line", /没有正在跑的评测|上一次已完成|%/.test(flat), flat.slice(-400));

if (failures.length > 0) {
  console.log(`\ncheck-client: ${failures.length} failure(s) — ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ncheck-client: ok");
