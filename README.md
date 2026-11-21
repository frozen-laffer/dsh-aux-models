# dsh-aux-models

常驻辅助模型：把第三方 agent API（已注册为 LLM provider 路由）变成一个**任何会话都能用**的辅助模型，
主模型可把自包含的子任务派给它，拿回纯文本结果；派给谁、花多少钱，由插件里的路由器决定。

v2 起，字段命名对齐 [litellm 的 Adaptive Router](https://docs.litellm.ai/docs/adaptive_router.md)，
配置形状对齐 [Portkey 的 targets](https://github.com/Portkey-AI/gateway)：将来这套注册表要搬去真网关，不用改名。

## 安装

前提：DSH 桌面端（或 `dsh web`）能正常启动，插件库目录存在（下称 `<插件库>`）。

1. 把本仓库放进 `<插件库>/04-工具与能力/dsh-aux-models`；
2. profile 的 `package.json` 加依赖：`"dsh-aux-models": "link:<插件库>/04-工具与能力/dsh-aux-models"`；
3. `cordis.patch.yml` 里加一行插入（**不能只写 `- id:`，否则日志只会报 `patch: entry "aux-models" not found`**）：

   ```yaml
   - insert:
       - id: aux-models
         name: 'dsh-aux-models'
   ```

4. 重启客户端（宿主半页改动只在重启后进内存；只改设置页时刷新页面即可）；
5. 打开 设置 → 辅助模型：先加「网关路由」（写进 `llm-pi-ai` 的 provider），再加模型、调倍率与价格。

凭据只走 DSH 的 credentials（`$DSH_HOME/.credentials.yaml` 的 `refs:` 段，或 Web 的 Models 页写入），
**不要写进任何插件文件**；`apiKeyEnv` 填的是环境变量名，不是密钥本身。

## 为什么不用内置 subagent

DSH 的 subagent 授权表（`subagent-model-selection-settings.allowedModels`）在**会话创建那一刻**就写进
Session 并被后续子会话继承，之后再改配置也不影响老会话 —— 所以"新增一个 provider，老会话里立即可用"
做不到。本插件直接调用 `ctx.llm.stream()`，绕开这层授权，因此是常驻的。

## 三个工具

| 工具 | 作用 |
| --- | --- |
| `aux_models` | 列出可用辅助模型：tier、擅长、有效单价、上下文、是否支持工具、学到的质量分 |
| `aux_route` | **空跑**：只算不调。返回任务分类、排名、预估成本，以及"是否值得先问一句" |
| `aux_delegate` | 真正委派。省略 `model` 时由路由器自动选 |

辅助模型**看不到**会话、读不到文件、也不能执行工具：需要粘贴的代码/日志必须放进 `task`。
失败时工具报错，主模型应当自己继续做（描述里已写明，不阻塞主流程）。

## 路由：7 类任务 × 学到的质量 × 价格

分类器把任务归入 litellm 那 7 类（`code_generation` / `code_understanding` / `technical_design` /
`analytical_reasoning` / `writing` / `factual_lookup` / `general`），规则中英双写。

每个模型的分数：

```
quality  = 冷启动先验(tier: 1→0.55, 2→0.78, 3→0.95) 与实测平均值按样本数加权
cost     = 预估成本在候选里的相对便宜程度（0..1）
score    = weights.quality × quality + weights.cost × cost − 健康度惩罚
```

- **weights 就是"省钱 ↔ 质量"滑杆**：`{quality:0.7, cost:0.3}`（默认偏质量）、`0.3/0.7`（省钱优先）。
- **冷启动**：每个 (模型 × 任务类型) 有 8 次样本的虚拟权重，约 10 次真实调用后实测值占主导。
- **证据会过期**：样本按 14 天半衰期衰减（`DECAY_HALF_LIFE_MS`），衰减后的有效样本数最多算 200 条
  （`MAX_EFFECTIVE_SAMPLES`，对应 litellm 的每格上限）—— 上个月的连胜不会永远压着今天更稳的模型。
- **熔断**：10 分钟窗口内失败 ≥3 次，该模型得分乘 0.35 并被标记 `⚠ 熔断中`。
- **问一句**：前两名分差 < `askBelowConfidence`（默认 0.15），或预估成本 > `askAboveCost`（默认 $0.05）时，
  `aux_route` 会标 `ask: true` —— 这正是你选的"不确定时问一句"。
- **瞬时失败自动换路**：`aux_delegate` 在自动选路（没写 `model`）时，遇到隧道/502/超时这类可重试错误，
  会自动换到排名里的下一个候选，返回里带 `fellBackFrom` 与 `note`；显式指定 `model` 时不换，
  两路都挂才抛错。要关掉这个行为：注册表 `settings.fallback: false`（或 config `fallback: false`）。

单次覆盖：`strategy: "cheap" | "best"` 临时改权重，`min_tier: 1|2|3` 强制档位（对应 litellm 的
`x-litellm-min-quality-tier`）。

## 成本模型

有效单价 = 官方价 × 分组倍率 × 缓存折算：

```
inputFactor = (1 − cacheHitRate) + cacheHitRate × 0.1    # 命中缓存的输入按 10% 计
inputPerM   = 官方输入价 × multiplier × inputFactor
outputPerM  = 官方输出价 × multiplier
```

工具循环的预算是**累计**的：每轮把 usage 里的 token 折算成美元累加，超过 `maxCostPerCall`
（默认 $0.5）就提前收尾并说明原因。

实测参考（`X001-GPT` 组，0.14x，缓存 80%）：20k 输入 + 2k 输出 ≈ **$0.022 ≈ ¥0.16**，
6 轮工具循环约 ¥0.8–1.2。统计与成本每轮都会落盘。

## 注册表：`$DSH_HOME/aux-models.json`（v2：分组）

每次调用现读，改完即生效，不用重启。v1 的扁平 `models` 数组会自动迁移成单分组。

```jsonc
{
  "version": 2,
  "defaultModel": "luna",
  "weights": { "quality": 0.7, "cost": 0.3 },
  "routing": {
    "askBelowConfidence": 0.15,
    "askAboveCost": 0.05,
    "maxCostPerCall": 0.5,
    "maxRounds": 6,
    "breakerFailures": 3,
    "cooldownMinutes": 10
  },
  "channels": [
    {
      "id": "x001-gpt",
      "name": "X001-GPT 不降智分组（0.14x）",
      "provider": "dieqi",          // 分组的 provider 路由名
      "multiplier": 0.14,           // 倍率：官方价 × 它
      "cacheHitRate": 0.8,          // 缓存命中率，折算输入成本
      "stability": 5,               // 1-10，低稳定性会被轻微降权
      "models": [
        {
          "id": "astra",
          "label": "GPT-6 Astra",
          "model": "gpt-6-astra",
          "qualityTier": 3,         // 1 budget / 2 mid / 3 frontier
          "strengths": ["code_generation", "technical_design"],
          "contextWindow": 1050000,
          "maxOutputTokens": 128000,
          "supportsTools": true,
          "pricing": { "inputPerM": 10, "outputPerM": 50, "source": "openrouter" }
        }
      ]
    }
  ]
}
```

- `mapsTo`：网关内该 id 实际映射到别的模型（例如 luna → gpt-6-astra），只用于展示与解释。
- `pricing` 填**官方价**（美元/百万 token）；倍率与缓存由分组的 `multiplier` / `cacheHitRate` 施加。
  价格未知时，路由用"相对贵"的保守代理，不会当成免费。
- 统计文件 `$DSH_HOME/aux-stats.json`：每个 (模型 × 任务类型) 的 `n / qualitySum / failN / latencySumMs / tokensIn / tokensOut`，
  以及每个模型最近 20 条失败记录（熔断依据）。删掉它等于清零学习结果。

## 工具循环：`aux_delegate(tools: true)`

辅助模型拿到**只读**工具（默认 `read` / `grep` / `glob`），自己翻几轮代码再回答，不需要主模型把大段文件贴进 prompt。

- 白名单在插件配置里改（见下），**永远不会把 `write` / `edit` / `pwsh` 交出去**。
- 每次工具调用仍走 `ctx.tools.execute` 的完整管线：本会话的沙箱规则、guard、审批照常生效。
- 轮数上限默认取注册表 `routing.maxRounds`（`max_rounds` 可单次覆盖）。
- 这条路径**不经过 subagent 的会话级授权表**，所以旧会话也能用 —— 这是它相对 `subagent` 路线的唯一独占价值。

插件配置（`cordis.patch.yml` 里这一行的 `config`）：

```yaml
- insert:
    - id: aux-models
      name: 'dsh-aux-models'
      config:
        tools:
          allow: [read, grep, glob]   # 只读白名单，加 write 前先想清楚
          maxRounds: 6
```

`registryPath` / `statsPath`（默认 `$DSH_HOME/aux-models.json` / `aux-stats.json`）、
`maxInputChars`（默认 60000）、`timeoutMs`（默认 180000，覆盖整个循环）、`temperature`、
`autoAsk`（true 时路由不自信就报错让你确认，而不是默默选）、`debug` 是插件级配置。

## 设置页（v0.7.1）

「设置 → 辅助模型」是插件的浏览器半页（`client.js`，手写 ModuleLoader bundle，无需构建）：

- 顶栏：质量/成本权重滑杆（直接改 `weights`）、默认模型、单次预算 `maxCostPerCall`、询问阈值 `askBelowConfidence`。
- 分组卡：分组 id、provider 路由、倍率、缓存命中率、稳定性；每个模型一张卡，可改显示名、模型 id、档位、
  官方单价、上下文、「擅长」标签、启用/可带工具、删除；`+ 添加模型` 追加新条目；`试一次` 用真实网关跑一句话，
  显示耗时/tokens/估算成本。
- 网关路由（`+ 新增网关`）：像 Models 页那样**新建/编辑 `llm-pi-ai` 的 provider 路由** —— 填路由 id、显示名、
  协议（openai-completions / openai-responses / anthropic-messages）、baseURL、密钥变量名、密钥值、模型列表；
  「探测模型」会真的打 `GET {baseURL}/models`（anthropic 走 `/v1/models?limit=1000`）回填模型列表。
  保存时密钥经 `credentials.set()` 落进受管凭据库，路由经 `configEditor.edit()` 写回 profile 的 `llm-pi-ai` 行
  （走 Loader 的 schema 校验与原子回写；写坏了会自动回滚）。
- 删网关路由：每条路由右侧「删除」是两步确认（点一次变「确认删除」）；如果还有启用中的辅助模型引用这条路由，
  宿主返回 409 并点名模型 id，页面把原因显示出来 —— 不会留下指向空路由的注册表条目。
- 路由预览：贴一段任务进来点「算一下」，宿主用**真路由器**空跑一遍（不调模型），返回判定类型与置信度、命中词、
  每个候选的得分/质量/成本优势/健康罚分/有效价、选中的模型与预估价，以及「会先问你一句」的提示与被排除的原因。
  想知道"这句话会派给谁、花多少钱"时用它，比派一次再后悔便宜。
- 保存注册表：整份注册表 POST 到宿主，宿主先 `buildRegistry` 校验再原子落盘，**即时生效，不需要重启**；
  新增/删除网关路由走 Loader 重载，也不需要重启。

宿主八条同源路由（`index.js` 的 `settingsHandlers()`）：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/dsh-aux-models/state` | GET | 注册表 + 有效单价 + 学到的质量 + 健康度 + 累计花费 |
| `/dsh-aux-models/save` | POST | `{registry}`，校验后写 `aux-models.json`；空模型表直接 400 |
| `/dsh-aux-models/test` | POST | `{modelId, task?}`，一次真实调用（默认 60s 超时） |
| `/dsh-aux-models/preview` | POST | `{task, tools?, strategy?, min_tier?}` 空跑路由：分类、排名、预估价、是否该问一句、被排除的原因 |
| `/dsh-aux-models/routes` | GET | `llm-pi-ai` 里现有的 provider 路由 + 密钥是否已配置 |
| `/dsh-aux-models/route` | POST | `{provider, displayName, api, baseURL, apiKeyEnv, apiKey?, models}` → 写配置 + 存密钥 |
| `/dsh-aux-models/route-remove` | POST | `{provider}` 删掉一条路由；**仍有启用中的辅助模型引用它时返回 409**，并列出是哪些 |
| `/dsh-aux-models/discover` | POST | 打网关的 `/models` 探测可用模型（没给 key 就用凭据库里已存的） |

浏览器半页通过 `ctx.slots.register({ name: "settings.section", id: "aux-models", order: 72 })` 挂载，
`package.json` 里用 `dsh.client` 声明（`platform: "web"`）。**改了 `client.js` 或 `package.json` 的 `dsh.client` 后刷新页面即可；
改了 `index.js` 仍要重启客户端。**

## 重启后一条命令自检

`index.js` 的改动只有重启客户端才进内存，所以重启后先跑这个（只读，不花钱、不写注册表）：

```powershell
cd dsh-aux-models
node verify-live.mjs                      # 默认 http://127.0.0.1:5808
node verify-live.mjs http://127.0.0.1:4302 # GUI 换了端口就带上
```

16 项：宿主 `/state` 是否挂上、注册表有没有分组/模型/有效单价/7 类任务、`/routes` 能否看见 configEditor、
`/preview` 的分类与排名、跨源写是否 403、写路由是否拒 GET、`/test` 是否拒未知模型。
`/state` 报 404 就是插件行没加载（重启没生效，或日志里有 parse 错误）。
浏览器半页没法从命令行查（GUI 的 boot payload 有会话鉴权），最后一行会提醒你眼睛看哪里。
## 自查（不装机）

```powershell
cd dsh-aux-models
node check-route.mjs     # 分类器 + 权重滑杆 + 学习覆盖先验 + 熔断 + 预算过滤 + 价格折算
node check-loop.mjs      # 工具循环的消息形状（assistant tool-call / tool 结果回填）
node check-section.mjs   # system prompt 段落渲染
node check-settings.mjs  # 设置页宿主编排：状态视图 + 保存往返 + 三条路由的 200/400/403/405
node check-gateway.mjs   # 网关路由：视图/校验/upsert（写 provider + 存密钥）/探测模型
node check-client.mjs    # 浏览器半页：ModuleLoader 注册 + 真渲染出网关面板与模型卡
node check-roundtrip.mjs # 真注册表 → 状态视图 → 浏览器 strip → 保存 → 重读，字段不丢不炸
node check-live.mjs      # 真启一遍 apply()：假 Cordis ctx + 真 http 服务 + fetch 打七条路由 + 一次 aux_delegate
```

`check-live.mjs` 是重启前的最后一关：它用 Cordis 形状的 ctx 调 `apply()`，检查工具注册、prompt 段落、
`ctx.effect` 生成的注册器，然后用**真的** `node:http` 服务把七条路由暴露出来，用 `fetch` 走一遍
状态/保存/跨源拒绝/建路由/删路由（含 409）/试一次，最后调 `aux_delegate` 验证 provider/model/计费与统计落盘。
它替代不了真机（`llm.stream` 是桩），但能挡住「重启后才发现 apply() 里写错一个字段」这类事故。

0.6.1 修了两个只有真跑才会露的 bug：单次委派把 `usage` 当不存在 → 每次都记 $0（现在从 `usage` 折算 token），
以及「把这段 Python 解析 CSV 的函数改写一下」被 `改写` 判成 writing（现在代码标记优先于写作动词）。

## 关键约束（踩过的坑）

- **provider 路由必须先存在**：插件不做协议适配，只复用 `@deepseek-ai/dsh-llm-pi-ai` 已注册的路由；
  缺路由可以在设置页用「+ 新增网关」建（内部就是 `configEditor.edit()` 写 `llm-pi-ai` 的 provider）。
- **密钥走受管凭据库**（`$DSH_HOME/.credentials.yaml` 或设置里的 Models 页），不要写 `.env`：
  桌面端不是由产品 CLI 启动的，`.env` 那一层不生效。
- **本插件零依赖**（只用 node 内置模块）：它从 profile 外的目录 link 进来，不能 import 裸包名。
- **改 `index.js` 必须重启客户端**；改注册表不用（段落与工具都是现读）。
- **PS 5.1 写 JSON 会加 BOM**，会让插件行被 `JSON.parse` 报 `Unexpected token '锘?'` 而整行禁用；
  用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`。
- **`settings.section` 的 `label` 不能省**：插槽目录里 `label` 是 optional，但不给就是导航里的空白条目
  （页面能进去，只是没人知道它是什么）。注册时写 `{ id, order, label: "辅助模型" }`。
- **没有 `webServer` 的组合（纯 CLI）里 `ctx.inject(["webServer"], …)` 永不回调**：`apply()` 必须照常完成，
  工具与 prompt 段落不受影响（`check-live.mjs` 的 headless 场景守着这条）。

## 安装位置

- 源码/开发副本：`dsh-aux-models/`（本仓库）
- 插件库副本：`<插件库>/04-工具与能力/dsh-aux-models/`
- profile：`$DSH_HOME/profiles/<profile-name>/`
  - profile 的 `package.json` → `"dsh-aux-models": "link:<插件库>/04-工具与能力/dsh-aux-models"`
  - `node_modules\dsh-aux-models` → 指向插件库的 junction
  - `cordis.patch.yml` → `- insert: [{ id: aux-models, name: 'dsh-aux-models' }]`

> 注意：新插件必须用 `insert:` 块。裸 `- id: xxx` 只用于**覆盖**已存在的行，
> 对不存在的 id 只会得到 `patch: entry "xxx" not found` 警告并且不加载。

### 0.7.4 — 空白页（真机第一次打开设置页时）

/state 里的学习质量是对象（`{value, samples, decay, …}`），而离线 fixture 用的是裸数字，于是 `best.value.toFixed` 在真机上抛 TypeError，整页白屏。现在 `client.js` 用 `qualityValue()` 兼容两种形状，`check-client.mjs` 的 fixture 也改成对象形 —— 这条断言就是防回归的。
## 0.7.7 — 输出上限（实测：推理型路由很贵）

同一道题（日志归并表）两组实测：

| 路由 | 输入 tok | 输出 tok | 墙钟 | 花费 |
|---|---:|---:|---:|---:|
| `astra`（06 组，推理型） | 6440 | 4794 | 163s | $0.0355 |
| `sol61`（01 组，精简型） | 1148 | 561 | ~7s | $0.0004 |

质量基本并列（astra 多两条建议，sol61 更贴题）。差异几乎全在**输出 token**：
推理型路由会把"思考"也算进 completion，而输出单价是输入单价的几十倍。

所以 `aux_delegate` 现在默认 `max_tokens: 1600`（不传就卡这个值，需要长文显式调大），
返回值多一个 `truncated: true`（`finish_reason === "length"` 时为真），策略段也加了一句
"写委派指令时顺手带一句长度要求"。
## 0.7.9 — 推理型路由会吃光 max_tokens

新增两个渠道（`dieqi-ds` / `dieqi-grok`）后实测发现的坑：

`deepseek-v4.1-flash`（三方直连）与 `grok-4.7` 都会先写 `reasoning_content`，**思考量也算进 max_tokens**。
同一道日志题：`ds-flash` 花了 5,528 个 reasoning token 才开始写 700 字的答案；给 1,600 的上限时
`content` 是空的，插件只会报 "returned no text"。

现在的处理：

1. 空回答 + `finish: max-tokens` 时**跳到 8,000 上限重试一次**（不是翻倍 —— 翻倍只是再浪费 40 秒）；
2. 重试前先按 `estimateCost` 算这 8k 要多少钱，超过单次预算就直接报错，叫调用方调大 `max_tokens` 或换非推理路由；
3. 仍为空才抛错，并在错误里点名"这条路由把预算全花在推理上"。

另外记下 `grok` 渠道的价格反解（它返回 `usage.cost_in_usd_ticks`，1 tick = 1e-10 USD）：
`grok-4.7` = 入 20k ticks/token（命中缓存按 25% 计费）、出 60k ticks/token → 折官方价 $5/$15，
`grok-4.7-build-fast` 恰为两倍（$10/$30）。

## 0.8.3 — 「价格设置」页的桥接（contextBridge 是冻结的）

`dsh-balance` 的价格设置页要 `window.dshDesktop.balancePrices`。本构建的桌面壳用
`contextBridge.exposeInMainWorld("dshDesktop", {...})` 暴露这个对象，它**是冻结的**，
window 上的属性也不可写——任何插件都挂不上去，所以页面一直报「价格设置桥接不可用」。

最终做法分两半：

1. 本插件的客户端半页在启动时装一个普通全局槽位 `window.__dshBalancePrices`
   （`get/save/reset` 三个方法，后端是 `/dsh-aux-models/balance-prices`，
   落盘到 `price-table.json` 的 `balance` 段，和实测单价同一份真源）。
2. `dsh-balance` 的 `lib/client.js` 里 `priceBridge()` 加了一行回退：
   `(window.dshDesktop && window.dshDesktop.balancePrices) || window.__dshBalancePrices`。
   改之前请先备份原文件。

**注意**：第 2 步是改第三方插件的本地副本（`<插件库>/01-官方基础插件/@deepseek-ai/dsh-balance`，
junction 进 profile）。插件更新会覆盖这行补丁，届时重跑 `node check-client.mjs` 若失败、
或页面又开始报「桥接不可用」，就把那行回退加回去。

默认值来自 `DEEPSEEK_DEFAULTS`（DeepSeek 四个模型的官方人民币价，空闲价半价），
`price-table.json` 里有实测条目的模型会被实测价覆盖并标 `measured`。

## 0.9.0 — 评测结果接入路由

`$DSH_HOME/aux-eval.json` 存最近一轮能力评测（每个模型 × 任务类型的通过率、均耗时、花费），由 `eval-build/to-eval.mjs` 从 `eval-run.mjs` 的结果文件生成。

接入方式：`qualityEstimate()` 在「档位先验」与「日常统计」之间插一层评测分，权重 `EVAL_MASS = 12`（约等于 12 个真实样本）：

```
quality = (8*prior + 12*evalRate + n*measured) / (8 + 12 + n)
```

- 只在该模型 × 该任务类型有评测记录时才加权；没记录就退回原来的两段式，新通道不跑评测也能用。
- 评测分按文件 mtime 缓存，改文件即生效，不用重启；文件损坏时静默忽略（与 stats 同样的容错）。
- `aux_models` 的行尾显示 `评测 6/6`；设置页模型卡显示「最近一次评测：6/6 · 14s · $0.0012」。

一条命令重跑评测（约 $0.6、220 秒）：

```
node eval-build/eval-run.mjs --plan      # 先看估算
node eval-build/eval-run.mjs --reuse     # 跑（复用 60 分钟内的结果）
node eval-build/to-eval.mjs              # 写进 aux-eval.json（立即生效）
```

## 0.11.0 — 批量委派 `aux_delegate_batch`

一次调用并发派 1–8 个互不相干的任务：每个任务独立选模型（也可 `model` 固定），一个失败不影响其它，返回一张结果表。

```
aux_delegate_batch(tasks=[
  "审 F:\a.js 的空指针风险",
  { task: "把这段日志归并成表", model: "codex-review" },
  { task: "读 package.json 报版本号", tools: true },
], max_cost: 0.05)
```

- `max_cost` 是**整批**上限，开跑前估算，超了直接拒跑，一个请求都不发；
- 每行的输出：`✓ 模型（provider/model）· 秒 · 花费 · 轮数`，下面跟 320 字摘要；失败行给错误原文；
- 与 `aux_delegate` 的分工：单件活、要重试/降级链，用 `aux_delegate`；多件互不相干的活，用 batch 换吞吐。
