import http from "node:http";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.argv[2] || 2698);
const HOST = "127.0.0.1";

function call(path, init = {}) {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
    const headers = { ...(init.headers || {}) };
    if (body) headers["content-length"] = String(body.length);
    const req = http.request({ host: HOST, port: PORT, path, method: init.method || "GET", headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const origin = `http://${HOST}:${PORT}`;
const out = [];
const step = (name, ok, detail) => out.push({ name, ok, detail });

// 1. the page's first call: GET
let res = await call("/dsh-aux-models/balance-prices");
step("价格页 get → 200", res.status === 200 && res.json?.ok === true, `status=${res.status}`);
const defaults = res.json?.defaults || {};
step(
  "默认值覆盖页面要的四个模型",
  ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"].every(m => defaults[m]?.peak),
  Object.keys(defaults).join(","),
);
step(
  "默认值形状正确（peak/offpeak × 三字段）",
  Number.isFinite(defaults["deepseek-v4-flash"]?.peak?.cacheMiss) &&
    Number.isFinite(defaults["deepseek-v4-flash"]?.offpeak?.output) &&
    defaults["deepseek-v4-flash"].offpeak.output === defaults["deepseek-v4-flash"].peak.output / 2,
  JSON.stringify(defaults["deepseek-v4-flash"]),
);

// 2. save like the page does
const model = "deepseek-v4-flash";
const prices = { peak: { cacheMiss: 2.5, cacheHit: 0.25, output: 9 }, offpeak: { cacheMiss: 1.25, cacheHit: 0.125, output: 4.5 } };
res = await call("/dsh-aux-models/balance-prices", {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ model, prices }),
});
step("价格页 save → 200", res.status === 200 && res.json?.prices?.peak?.output === 9, `status=${res.status} ${res.text.slice(0, 120)}`);

// 3. the page re-reads: current must win over defaults
res = await call("/dsh-aux-models/balance-prices");
const saved = res.json?.prices?.[model];
step("再读时 current 生效", saved?.peak?.cacheMiss === 2.5, JSON.stringify(saved));

// 4. it really hit the price table
const table = JSON.parse(fs.readFileSync(join(process.env.DSH_HOME || join(homedir(), ".dsh"), "price-table.json"), "utf8"));
step("落盘到 price-table.json 的 balance 段", table.balance?.[model]?.peak?.output === 9, JSON.stringify(table.balance?.[model] ?? null));

// 5. cross-origin write is refused
res = await call("/dsh-aux-models/balance-prices", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://evil.example" },
  body: JSON.stringify({ model, prices }),
});
step("跨源写被拒", res.status === 403, `status=${res.status}`);

// 6. out-of-range value is refused
res = await call("/dsh-aux-models/balance-prices", {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ model, prices: { peak: { cacheMiss: 5000, cacheHit: 0.1, output: 1 } } }),
});
step("越界价被拒", res.status === 400, `status=${res.status} ${res.text.slice(0, 120)}`);

// 7. reset restores the built-in default
res = await call("/dsh-aux-models/balance-prices", {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ model, reset: true }),
});
step("reset 清掉自定义档", res.status === 200 && res.json?.prices === null, `status=${res.status}`);
const table2 = JSON.parse(fs.readFileSync(join(process.env.DSH_HOME || join(homedir(), ".dsh"), "price-table.json"), "utf8"));
step("price-table.json 里也已删除", !table2.balance || table2.balance[model] === undefined, JSON.stringify(table2.balance ?? {}));

for (const s of out) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name}${s.detail ? " — " + s.detail : ""}`);
const failed = out.filter(s => !s.ok).length;
console.log(failed === 0 ? "\nbridge-live: ok" : `\nbridge-live: ${failed} failure(s)`);
process.exitCode = failed === 0 ? 0 : 1;
