/**
 * dsh-aux-models — browser half: 「辅助模型」设置页。
 *
 * Hand-written ModuleLoader bundle, no build step. The page is a thin form over
 * the registry JSON that the host half owns:
 *
 *   GET  /dsh-aux-models/state   → channels + models + learned quality + spend
 *   POST /dsh-aux-models/save    → { registry } (host validates, then writes)
 *   POST /dsh-aux-models/test    → { modelId }   (one live call, ~1-60s)
 *
 * Everything the page shows is derived server-side, so the form cannot drift
 * from what the router actually sees.
 */
window.__ModuleLoader__.load({
  id: "dsh-aux-models",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    var TASK_LABELS = {
      code_generation: "写代码",
      code_understanding: "读代码",
      technical_design: "方案设计",
      analytical_reasoning: "推理分析",
      writing: "写作",
      factual_lookup: "查事实",
      general: "通用",
    };

    var TIER_LABELS = { 1: "1 · 省钱档", 2: "2 · 中档", 3: "3 · 前沿档" };

    // Every colour comes from the live theme tokens, so the page follows the
    // active skin and light/dark mode. The hex fallbacks only apply when a token
    // is missing; they are never the intended appearance.
    var COLORS = {
      text: "var(--dsw-alias-label-primary, #1f2328)",
      muted: "var(--dsw-alias-label-secondary, #6b7280)",
      border: "var(--dsw-alias-border-l1, #e5e7eb)",
      borderStrong: "var(--dsw-alias-border-l2, #d1d5db)",
      bg: "var(--dsw-alias-bg-layer-1, #fafafa)",
      card: "var(--dsw-alias-bg-layer-2, #ffffff)",
      overlay: "var(--dsw-alias-bg-overlay, #ffffff)",
      accent: "var(--dsw-alias-brand-primary, #2563eb)",
      danger: "var(--dsw-alias-state-error-primary, #b91c1c)",
      ok: "var(--dsw-alias-state-success-primary, #166534)",
      warn: "var(--dsw-alias-state-warn-primary, #92400e)",
      idle: "var(--dsw-alias-state-idle-primary, #6b7280)",
      onAccent: "#ffffff",
    };

    // A translucent wash of a token: readable on light and dark surfaces alike.
    function tint(color, percent) {
      return "color-mix(in srgb, " + color + " " + percent + "%, transparent)";
    }

    function api(path, init) {
      return fetch(path, Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {})).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || body.ok === false) throw new Error(body && body.error ? body.error : res.status + " " + res.statusText);
          return body;
        });
      });
    }

    function postJson(path, payload) {
      return api(path, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    function num(value, fallback) {
      var parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function money(perM) {
      if (!Number.isFinite(perM)) return "未知";
      if (perM === 0) return "$0";
      return "$" + (perM < 0.01 ? perM.toFixed(4) : perM < 1 ? perM.toFixed(3) : perM.toFixed(2)) + "/M";
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    /** Drop the server-computed fields before writing the file back. */
    function stripModel(model) {
      return {
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
      };
    }

    function stripRegistry(state) {
      return {
        version: 2,
        defaultModel: state.defaultModel,
        defaultSystem: state.defaultSystem,
        weights: state.weights,
        routing: state.routing,
        channels: state.channels.map(function (channel) {
          return {
            id: channel.id,
            name: channel.name,
            provider: channel.provider,
            multiplier: channel.multiplier,
            cacheHitRate: channel.cacheHitRate,
            stability: channel.stability,
            enabled: channel.enabled,
            models: channel.models.map(stripModel),
          };
        }),
      };
    }

    var inputStyle = {
      width: "100%",
      boxSizing: "border-box",
      padding: "5px 8px",
      fontSize: 13,
      color: COLORS.text,
      background: COLORS.card,
      border: "1px solid " + COLORS.border,
      borderRadius: 6,
      fontFamily: "inherit",
    };

    var labelStyle = { display: "block", fontSize: 11, color: COLORS.muted, marginBottom: 3 };

    var buttonStyle = {
      padding: "5px 12px",
      fontSize: 12,
      borderRadius: 6,
      border: "1px solid " + COLORS.border,
      background: COLORS.card,
      color: COLORS.text,
      cursor: "pointer",
      fontFamily: "inherit",
    };

    function Field(props) {
      return h(
        "label",
        { style: Object.assign({ display: "block", minWidth: 0 }, props.style) },
        h("span", { style: labelStyle }, props.label),
        props.children,
      );
    }

    function NumberField(props) {
      return h(
        Field,
        { label: props.label, style: props.style },
        h("input", {
          type: "number",
          step: props.step || "any",
          value: props.value === undefined ? "" : props.value,
          onChange: function (event) {
            var raw = event.target.value;
            props.onChange(raw === "" ? undefined : num(raw, undefined));
          },
          style: inputStyle,
        }),
      );
    }

    function Check(props) {
      return h(
        "label",
        { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS.text, cursor: "pointer" } },
        h("input", { type: "checkbox", checked: !!props.checked, onChange: function (e) { props.onChange(e.target.checked); } }),
        props.label,
      );
    }

    function Pill(props) {
      return h(
        "span",
        {
          style: {
            display: "inline-block",
            padding: "1px 7px",
            borderRadius: 999,
            fontSize: 11,
            lineHeight: "17px",
            color: props.color || COLORS.muted,
            background: props.bg || COLORS.bg,
            border: "1px solid " + (props.border || COLORS.border),
          },
        },
        props.children,
      );
    }

    function strengthChips(model, taskTypes, onToggle) {
      return h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        taskTypes.map(function (type) {
          var on = (model.strengths || []).indexOf(type) >= 0;
          return h(
            "button",
            {
              key: type,
              type: "button",
              title: TASK_LABELS[type] || type,
              onClick: function () { onToggle(type); },
              style: {
                padding: "2px 8px",
                fontSize: 11,
                borderRadius: 999,
                cursor: "pointer",
                fontFamily: "inherit",
                color: on ? "#ffffff" : COLORS.muted,
                background: on ? COLORS.accent : COLORS.card,
                border: "1px solid " + (on ? COLORS.accent : COLORS.border),
              },
            },
            TASK_LABELS[type] || type,
          );
        }),
      );
    }

    function ModelCard(props) {
      var model = props.model;
      var taskTypes = props.taskTypes;
      var learned = model.quality || {};
      // /state reports each cell as {value, samples, decay, …}; older/raw
      // payloads may still carry a bare number. Both must render.
      function qualityValue(type) {
        var raw = learned[type];
        if (typeof raw === "number") return raw;
        if (raw && typeof raw.value === "number") return raw.value;
        return 0;
      }
      var best = taskTypes
        .map(function (type) { return { type: type, value: qualityValue(type) }; })
        .sort(function (a, b) { return b.value - a.value; })[0];

      return h(
        "div",
        {
          style: {
            border: "1px solid " + COLORS.border,
            borderRadius: 10,
            padding: 12,
            marginTop: 10,
            background: COLORS.card,
            opacity: model.enabled ? 1 : 0.55,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("strong", { style: { fontSize: 13, color: COLORS.text } }, model.id),
          h(Pill, null, "tier " + model.qualityTier),
          model.mapsTo && model.mapsTo !== model.model
            ? h(Pill, { bg: tint(COLORS.warn, 14), border: tint(COLORS.warn, 38), color: COLORS.warn }, "映射 → " + model.mapsTo)
            : null,
          h(
            Pill,
            { bg: model.supportsTools ? tint(COLORS.ok, 12) : COLORS.bg, border: model.supportsTools ? tint(COLORS.ok, 36) : COLORS.border, color: model.supportsTools ? COLORS.ok : COLORS.muted },
            model.supportsTools ? "可带工具" : "仅问答",
          ),
          model.health && model.health.breaker ? h(Pill, { bg: tint(COLORS.danger, 12), border: tint(COLORS.danger, 38), color: COLORS.danger }, "熔断中") : null,
          h(
            "span",
            { style: { marginLeft: "auto", fontSize: 11, color: COLORS.muted } },
            money(model.effective && model.effective.inputPerM) + " 入 · " + money(model.effective && model.effective.outputPerM) + " 出",
          ),
        ),
        best && best.value !== undefined
          ? h("div", { style: { fontSize: 11, color: COLORS.muted, marginTop: 4 } }, "当前学习质量最高：" + (TASK_LABELS[best.type] || best.type) + " " + best.value.toFixed(2))
          : null,
        model.evaluation && model.evaluation.total > 0
          ? h(
              "div",
              { style: { fontSize: 11, color: COLORS.muted, marginTop: 2 } },
              "最近一次评测：" + model.evaluation.pass + "/" + model.evaluation.total + " · " + Math.round((model.evaluation.avgMs || 0) / 100) / 10 + "s · " + money(model.evaluation.cost),
            )
          : null,
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 10 } },
          h(Field, { label: "显示名" }, h("input", { value: model.label || "", onChange: function (e) { props.onChange({ label: e.target.value }); }, style: inputStyle })),
          h(Field, { label: "模型 id" }, h("input", { value: model.model || "", onChange: function (e) { props.onChange({ model: e.target.value }); }, style: inputStyle })),
          h(
            Field,
            { label: "档位" },
            h(
              "select",
              { value: model.qualityTier, onChange: function (e) { props.onChange({ qualityTier: num(e.target.value, 2) }); }, style: inputStyle },
              [1, 2, 3].map(function (tier) { return h("option", { key: tier, value: tier }, TIER_LABELS[tier]); }),
            ),
          ),
          h(NumberField, { label: "官方价 入 $/M", value: model.pricing && model.pricing.inputPerM, onChange: function (v) { props.onPricing({ inputPerM: v }); } }),
          h(NumberField, { label: "官方价 出 $/M", value: model.pricing && model.pricing.outputPerM, onChange: function (v) { props.onPricing({ outputPerM: v }); } }),
          h(NumberField, { label: "上下文 tokens", value: model.contextWindow, step: 1024, onChange: function (v) { props.onChange({ contextWindow: v }); } }),
        ),
        h(
          "div",
          { style: { marginTop: 8 } },
          h("span", { style: labelStyle }, "擅长（影响分派）"),
          strengthChips(model, taskTypes, function (type) {
            var next = (model.strengths || []).slice();
            var index = next.indexOf(type);
            if (index >= 0) next.splice(index, 1);
            else next.push(type);
            props.onChange({ strengths: next });
          }),
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 14, marginTop: 10, flexWrap: "wrap" } },
          h(Check, { label: "启用", checked: model.enabled, onChange: function (v) { props.onChange({ enabled: v }); } }),
          h(Check, { label: "可带工具", checked: model.supportsTools, onChange: function (v) { props.onChange({ supportsTools: v }); } }),
          h(
            "button",
            {
              type: "button",
              onClick: props.onTest,
              disabled: props.testing,
              style: {
                marginLeft: "auto",
                padding: "4px 10px",
                fontSize: 12,
                borderRadius: 6,
                cursor: props.testing ? "default" : "pointer",
                fontFamily: "inherit",
                border: "1px solid " + COLORS.border,
                background: COLORS.bg,
                color: COLORS.text,
              },
            },
            props.testing ? "测试中…" : "试一次",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: props.onDelete,
              style: { padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", border: "1px solid " + tint(COLORS.danger, 40), background: tint(COLORS.danger, 12), color: COLORS.danger },
            },
            "删除",
          ),
        ),
        props.testResult
          ? h(
              "div",
              { style: { marginTop: 8, fontSize: 12, lineHeight: "18px", color: props.testResult.ok ? COLORS.ok : COLORS.danger, whiteSpace: "pre-wrap" } },
              props.testResult.ok
                ? "✓ " + (props.testResult.elapsedMs / 1000).toFixed(1) + "s" +
                  (props.testResult.tokens ? " · " + props.testResult.tokens.input + "/" + props.testResult.tokens.output + " tok" : "") +
                  (props.testResult.costUsd !== undefined ? " · ~$" + props.testResult.costUsd : "") +
                  "\n" + props.testResult.text
                : "✗ " + props.testResult.error,
            )
          : null,
      );
    }

    function GatewayPanel(props) {
      var routes = props.routes;
      var draftHook = useState(null);
      var draft = draftHook[0];
      var setDraft = draftHook[1];
      var busyHook = useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var noteHook = useState(null);
      var note = noteHook[0];
      var setNote = noteHook[1];
      var errorHook = useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      var confirmHook = useState(null);
      var confirming = confirmHook[0];
      var setConfirming = confirmHook[1];

      if (!routes) return null;

      function patch(next) {
        setDraft(Object.assign({}, draft, next));
      }

      function startNew() {
        setNote(null);
        setError(null);
        setDraft({
          provider: "",
          displayName: "",
          api: (routes.apis && routes.apis[0]) || "openai-completions",
          baseURL: "https://",
          apiKeyEnv: "",
          apiKey: "",
          modelsText: "",
          editing: false,
        });
      }

      function startEdit(provider) {
        setNote(null);
        setError(null);
        setDraft({
          provider: provider.id,
          displayName: provider.displayName,
          api: provider.api || "openai-completions",
          baseURL: provider.baseURL,
          apiKeyEnv: provider.apiKeyEnv,
          apiKey: "",
          modelsText: (provider.models || []).join("\n"),
          editing: true,
        });
      }

      function parseModels(text) {
        return String(text || "")
          .split(/\n+/)
          .map(function (line) { return line.trim(); })
          .filter(Boolean)
          .map(function (line) {
            var parts = line.split(/\s+/);
            return {
              id: parts[0],
              contextWindow: parts[1] ? num(parts[1], 262144) : 262144,
              maxTokens: parts[2] ? num(parts[2], 32768) : 32768,
            };
          });
      }

      function discover() {
        setBusy(true);
        setNote(null);
        setError(null);
        postJson("/dsh-aux-models/discover", {
          baseURL: draft.baseURL,
          api: draft.api,
          apiKeyEnv: draft.apiKeyEnv,
          apiKey: draft.apiKey,
        })
          .then(function (result) {
            patch({ modelsText: (result.models || []).join("\n") });
            setNote("探测到 " + (result.models || []).length + " 个模型 · " + (result.url || ""));
          })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      function submit() {
        setBusy(true);
        setNote(null);
        setError(null);
        postJson("/dsh-aux-models/route", {
          provider: draft.provider,
          displayName: draft.displayName,
          api: draft.api,
          baseURL: draft.baseURL,
          apiKeyEnv: draft.apiKeyEnv,
          apiKey: draft.apiKey,
          models: parseModels(draft.modelsText),
        })
          .then(function (result) {
            setNote("已写入 " + result.provider + "（" + result.models.length + " 个模型）" +
              (result.credential && result.credential.configured ? " · 密钥已配置" : " · 密钥未配置"));
            setDraft(null);
            if (props.onRefresh) props.onRefresh();
          })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      function remove(provider) {
        if (confirming !== provider.id) {
          setConfirming(provider.id);
          setNote("再点一次「确认删除」移除路由 " + provider.id + "（引用它的辅助模型要先删掉）");
          return;
        }
        setConfirming(null);
        setBusy(true);
        setNote(null);
        setError(null);
        postJson("/dsh-aux-models/route-remove", { provider: provider.id })
          .then(function (result) {
            setNote("已删除路由 " + result.provider + (result.note ? " · " + result.note : ""));
            if (props.onRefresh) props.onRefresh();
          })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      var providers = (routes && routes.providers) || [];

      return h(
        "div",
        { style: { marginTop: 16, border: "1px solid " + COLORS.border, borderRadius: 12, padding: 12, background: COLORS.bg } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("strong", { style: { fontSize: 13 } }, "网关路由"),
          h("span", { style: { fontSize: 12, color: COLORS.muted } }, "写入 llm-pi-ai 的 provider（改这里 = 改 profile 配置，走 Loader 校验）"),
          h(
            "button",
            {
              type: "button",
              onClick: startNew,
              disabled: busy || !routes.available,
              style: { marginLeft: "auto", padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: routes.available ? "pointer" : "default", fontFamily: "inherit", border: "1px dashed " + COLORS.border, background: "transparent", color: COLORS.muted },
            },
            "+ 新增网关",
          ),
        ),
        !routes.available
          ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.muted } }, routes.reason || "configEditor 不可用，无法管理网关路由")
          : null,
        routes.available && providers.length === 0
          ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.muted } }, "还没有 provider 路由。")
          : null,

        providers.map(function (provider) {
          return h(
            "div",
            { key: provider.id, style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8, padding: "6px 8px", border: "1px solid " + COLORS.border, borderRadius: 8, background: COLORS.card } },
            h("strong", { style: { fontSize: 12 } }, provider.id),
            h(Pill, null, provider.api || "?"),
            h(Pill, null, (provider.models || []).length + " 个模型"),
            h(
              Pill,
              provider.credential && provider.credential.configured
                ? { bg: tint(COLORS.ok, 12), border: tint(COLORS.ok, 36), color: COLORS.ok }
                : { bg: tint(COLORS.danger, 12), border: tint(COLORS.danger, 38), color: COLORS.danger },
              (provider.apiKeyEnv || "无变量名") + (provider.credential && provider.credential.configured ? " 已配置" : " 未配置"),
            ),
            h("code", { style: { fontSize: 11, color: COLORS.muted, wordBreak: "break-all" } }, provider.baseURL),
            h(
              "div",
              { style: { marginLeft: "auto", display: "flex", gap: 6 } },
              h(
                "button",
                {
                  type: "button",
                  onClick: function () { remove(provider); },
                  disabled: busy,
                  style: {
                    padding: "2px 8px",
                    fontSize: 11,
                    borderRadius: 6,
                    cursor: busy ? "default" : "pointer",
                    fontFamily: "inherit",
                    border: "1px solid " + (confirming === provider.id ? COLORS.danger : COLORS.border),
                    background: confirming === provider.id ? tint(COLORS.danger, 12) : COLORS.card,
                    color: confirming === provider.id ? COLORS.danger : COLORS.muted,
                  },
                },
                confirming === provider.id ? "确认删除" : "删除",
              ),
              h(
                "button",
                {
                  type: "button",
                  onClick: function () { startEdit(provider); },
                  style: { padding: "2px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", border: "1px solid " + COLORS.border, background: COLORS.card, color: COLORS.text },
                },
                "编辑",
              ),
            ),
          );
        }),

        draft
          ? h(
              "div",
              { style: { marginTop: 10, padding: 10, border: "1px solid " + COLORS.border, borderRadius: 10, background: COLORS.card } },
              h("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, draft.editing ? "编辑网关路由 · " + draft.provider : "新增网关路由"),
              h(
                "div",
                { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 } },
                h(Field, { label: "路由 id（aux 注册表里的 provider）" }, h("input", {
                  value: draft.provider,
                  readOnly: !!draft.editing,
                  onChange: function (e) { patch({ provider: e.target.value }); },
                  placeholder: "relay-img",
                  style: draft.editing ? Object.assign({}, inputStyle, { opacity: 0.7 }) : inputStyle,
                })),
                h(Field, { label: "显示名" }, h("input", { value: draft.displayName, onChange: function (e) { patch({ displayName: e.target.value }); }, placeholder: "中转站 图片", style: inputStyle })),
                h(Field, { label: "协议" }, h("select", {
                  value: draft.api,
                  onChange: function (e) { patch({ api: e.target.value }); },
                  style: inputStyle,
                }, (routes.apis || ["openai-completions"]).map(function (name) { return h("option", { key: name, value: name }, name); }))),
                h(Field, { label: "baseURL（含 /v1）" }, h("input", { value: draft.baseURL, onChange: function (e) { patch({ baseURL: e.target.value }); }, placeholder: "https://img.relay.example.com/v1", style: inputStyle })),
                h(Field, { label: "密钥变量名" }, h("input", { value: draft.apiKeyEnv, onChange: function (e) { patch({ apiKeyEnv: e.target.value }); }, placeholder: "RELAY_IMG_KEY", style: inputStyle })),
                h(Field, { label: "密钥值（留空 = 不改）" }, h("input", {
                  type: "password",
                  value: draft.apiKey,
                  onChange: function (e) { patch({ apiKey: e.target.value }); },
                  placeholder: "sk-…",
                  style: inputStyle,
                })),
              ),
              h(
                "div",
                { style: { marginTop: 8 } },
                h("div", { style: { fontSize: 11, color: COLORS.muted, marginBottom: 4 } }, "模型 id，每行一个（可跟 上下文tokens 最大输出tokens，例如 aux-large 1050000 128000）"),
                h("textarea", {
                  value: draft.modelsText,
                  onChange: function (e) { patch({ modelsText: e.target.value }); },
                  rows: 4,
                  style: Object.assign({}, inputStyle, { width: "100%", resize: "vertical", fontFamily: "ui-monospace, monospace" }),
                }),
              ),
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 } },
                h(
                  "button",
                  {
                    type: "button",
                    onClick: discover,
                    disabled: busy,
                    style: { padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: busy ? "default" : "pointer", fontFamily: "inherit", border: "1px solid " + COLORS.border, background: COLORS.card, color: COLORS.text },
                  },
                  busy ? "探测中…" : "探测模型",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: submit,
                    disabled: busy,
                    style: { padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: busy ? "default" : "pointer", fontFamily: "inherit", border: "1px solid " + COLORS.accent, background: COLORS.accent, color: "#ffffff" },
                  },
                  busy ? "写入中…" : "保存路由",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: function () { setDraft(null); setError(null); setNote(null); },
                    style: { padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", border: "1px solid " + COLORS.border, background: "transparent", color: COLORS.muted },
                  },
                  "取消",
                ),
              ),
            )
          : null,
        error ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.danger, whiteSpace: "pre-wrap" } }, "✗ " + error) : null,
        note ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.ok, wordBreak: "break-all" } }, "✓ " + note) : null,
      );
    }

    function RoutePreview() {
      var taskHook = useState("");
      var task = taskHook[0];
      var setTask = taskHook[1];
      var toolsHook = useState(false);
      var tools = toolsHook[0];
      var setTools = toolsHook[1];
      var strategyHook = useState("auto");
      var strategy = strategyHook[0];
      var setStrategy = strategyHook[1];
      var resultHook = useState(null);
      var result = resultHook[0];
      var setResult = resultHook[1];
      var errorHook = useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      var busyHook = useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];

      function compute() {
        if (task.trim().length === 0) return;
        setBusy(true);
        setError(null);
        postJson("/dsh-aux-models/preview", { task: task, tools: tools, strategy: strategy })
          .then(setResult)
          .catch(function (e) { setResult(null); setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      var rows = result && result.ranking ? result.ranking : [];
      return h(
        "div",
        { style: { padding: 12, marginBottom: 12, border: "1px solid " + COLORS.border, borderRadius: 10, background: COLORS.bg } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 } },
          h("b", { style: { fontSize: 13 } }, "路由预览"),
          h("span", { style: { fontSize: 11, color: COLORS.muted } }, "不真的调用模型：看分类、排名、预估价，再决定要不要派"),),
        h("textarea", {
          value: task,
          rows: 2,
          placeholder: "把一段任务贴进来，例如：把这段 Python 解析 CSV 的函数改写一下",
          onChange: function (e) { setTask(e.target.value); },
          style: Object.assign({}, inputStyle, { resize: "vertical", marginBottom: 6 }),
        }),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
          h(Check, { checked: tools, onChange: setTools, label: "按工具循环算（只看支持工具的模型）" }),
          h("select", {
            value: strategy,
            onChange: function (e) { setStrategy(e.target.value); },
            style: Object.assign({}, inputStyle, { width: 130 }),
          }, ["auto", "cheap", "best"].map(function (value) {
            return h("option", { key: value, value: value }, value === "auto" ? "auto · 按权重" : value === "cheap" ? "cheap · 省钱" : "best · 质量");
          })),
          h("button", {
            type: "button",
            onClick: compute,
            disabled: busy || task.trim().length === 0,
            style: Object.assign({}, buttonStyle, { opacity: busy || task.trim().length === 0 ? 0.5 : 1 }),
          }, busy ? "计算中…" : "算一下"),),
        error
          ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.danger } }, error)
          : null,
        result
          ? h(
            "div",
            { style: { marginTop: 10, fontSize: 12, lineHeight: "20px" } },
            h("div", null,
              "判定：", h("b", null, TASK_LABELS[result.taskType] || result.taskType),
              h("span", { style: { color: COLORS.muted } }, "（置信度 " + Math.round((result.classifierConfidence || 0) * 100) + "%）"),
              result.hits && result.hits.length
                ? h("span", { style: { color: COLORS.muted } }, " · 命中 " + result.hits.map(function (hit) { return hit.matched; }).join(" / "))
                : null,),
            result.chosen
              ? h("div", null,
                "选中：", h("b", null, result.chosen.id), " → ", h("code", null, result.chosen.model),
                h("span", { style: { color: COLORS.muted } }, " · 权重 质量 " + result.weights.quality.toFixed(2) + " / 成本 " + result.weights.cost.toFixed(2)),
                result.estimate
                  ? h("span", { style: { color: COLORS.muted } }, " · 预估 $" + result.estimate.usd.toFixed(4) + "（入 " + result.estimate.estInput + " / 出 " + result.estimate.estOutput + " tokens）")
                  : null,)
              : h("div", { style: { color: COLORS.danger } }, "没有模型能接这个任务（见下方排除原因）"),
            result.ask
              ? h("div", { style: { color: COLORS.warn } }, "⚠ 会先问你一句：" + (result.askReason || "候选差距很小"))
              : null,
            rows.length
              ? h("table", { style: { width: "100%", borderCollapse: "collapse", marginTop: 6 } },
                h("thead", null,
                  h("tr", { style: { color: COLORS.muted, textAlign: "left" } },
                    ["模型", "得分", "质量", "成本优势", "健康罚分", "档位", "有效价"].map(function (label) {
                      return h("th", { key: label, style: { fontWeight: 500, padding: "2px 6px 2px 0" } }, label);
                    }))),
                h("tbody", null,
                  rows.map(function (row) {
                    return h("tr", { key: row.id, style: { borderTop: "1px solid " + COLORS.border } },
                      h("td", { style: { padding: "3px 6px 3px 0" } }, row.id),
                      h("td", { style: { padding: "3px 6px 3px 0", fontWeight: result.chosen && row.id === result.chosen.id ? 600 : 400 } }, row.score.toFixed(3)),
                      h("td", { style: { padding: "3px 6px 3px 0" } }, row.quality.toFixed(2)),
                      h("td", { style: { padding: "3px 6px 3px 0" } }, row.cheapness.toFixed(2)),
                      h("td", { style: { padding: "3px 6px 3px 0" } }, row.penalty.toFixed(2)),
                      h("td", { style: { padding: "3px 6px 3px 0" } }, String(row.tier)),
                      h("td", { style: { padding: "3px 6px 3px 0", color: COLORS.muted } },
                        row.price && row.price.known ? "$" + row.price.inputPerM.toFixed(2) + " / $" + row.price.outputPerM.toFixed(2) : "未知"),);
                  })),)
              : null,
            result.rejected && result.rejected.length
              ? h("div", { style: { marginTop: 6, color: COLORS.muted } },
                "排除：", result.rejected.map(function (item) { return item.id + "（" + item.reason + "）"; }).join("；"),)
              : null,)
          : null,
      );
    }

    /* ---- eval console: pick a bank, run the matrix, watch the progress ---- */
    function EvalPanel() {
      var infoHook = useState(null);
      var info = infoHook[0];
      var setInfo = infoHook[1];
      var statusHook = useState(null);
      var status = statusHook[0];
      var setStatus = statusHook[1];
      var errorHook = useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      var noteHook = useState(null);
      var note = noteHook[0];
      var setNote = noteHook[1];
      var busyHook = useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var formHook = useState({ bank: "", models: "", budgetUsd: "1", concurrency: "8" });
      var form = formHook[0];
      var setForm = formHook[1];

      function load() {
        api("/dsh-aux-models/eval")
          .then(function (data) {
            setInfo(data);
            var cfg = data.config || {};
            setForm(function (prev) {
              var fallbackBank = data.banks && data.banks.length > 0 ? data.banks[0].path : "";
              return {
                bank: prev.bank || cfg.bank || fallbackBank,
                models: prev.models,
                budgetUsd: cfg.budgetUsd ? String(cfg.budgetUsd) : prev.budgetUsd,
                concurrency: cfg.concurrency ? String(cfg.concurrency) : prev.concurrency,
              };
            });
          })
          .catch(function (e) { setError(String((e && e.message) || e)); });
      }

      function poll() {
        api("/dsh-aux-models/eval/status").then(setStatus).catch(function () {});
      }

      useEffect(load, []);
      useEffect(function () {
        var timer = setInterval(function () {
          api("/dsh-aux-models/eval/status")
            .then(function (next) {
              setStatus(function (prev) {
                if (prev && prev.running && next && !next.running) load();
                return next;
              });
            })
            .catch(function () {});
        }, 1200);
        return function () { clearInterval(timer); };
      }, []);

      function patch(Next) {
        setForm(function (prev) { return Object.assign({}, prev, Next); });
        setNote(null);
      }

      function start() {
        setBusy(true);
        setError(null);
        setNote(null);
        var models = form.models.split(/[,\s]+/).filter(function (s) { return s.length > 0; });
        postJson("/dsh-aux-models/eval/run", {
          bank: form.bank,
          budgetUsd: Number(form.budgetUsd),
          concurrency: Number(form.concurrency),
          models: models,
        })
          .then(function (result) {
            setNote("已开始：" + result.tasks + " 题 · 预算 $" + result.budgetUsd + " · 并发 " + result.concurrency + (result.models && result.models.length ? " · 只测 " + result.models.length + " 个模型" : ""));
            poll();
          })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      function stop() {
        setBusy(true);
        setError(null);
        postJson("/dsh-aux-models/eval/stop", {})
          .then(function () { setNote("已请求停止"); })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); poll(); });
      }

      var banks = (info && info.banks) || [];
      var state = (status && status.state) || (info && info.state) || null;
      var running = Boolean((status && status.running) || (info && info.running));
      var pct = state && typeof state.pct === "number" ? Math.max(0, Math.min(100, Math.round(state.pct))) : 0;
      var currentBank = banks.find(function (b) { return b.path === form.bank; });
      var last = info && info.last;

      return h(
        "div",
        { style: { padding: 12, marginBottom: 12, border: "1px solid " + COLORS.border, borderRadius: 10, background: COLORS.bg } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 } },
          h("b", { style: { fontSize: 13 } }, "评测"),
          h("span", { style: { fontSize: 11, color: COLORS.muted } }, "让每个模型做同一套题，成绩写进 aux-eval.json 并参与路由打分"),),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginBottom: 8 } },
          h("label", { style: { fontSize: 11, color: COLORS.muted } },
            h("div", null, "题库来源"),
            h("select", {
              value: form.bank,
              onChange: function (e) { patch({ bank: e.target.value }); },
              style: Object.assign({}, inputStyle, { width: "100%", marginTop: 2 }),
            }, banks.map(function (b) {
              return h("option", {
                key: b.path,
                value: b.path,
                disabled: !b.usable,
              }, b.label + (b.usable ? " · " + b.tasks + " 题" : b.tasks > 0 ? " · " + b.tasks + " 条（不可直接跑）" : " · 缺失"));
            })),),
          h("label", { style: { fontSize: 11, color: COLORS.muted } },
            h("div", null, "模型范围（留空 = 全部启用）"),
            h("input", {
              value: form.models,
              placeholder: "例如 aux-audit,rv05,alpha62-04",
              onChange: function (e) { patch({ models: e.target.value }); },
              style: Object.assign({}, inputStyle, { width: "100%", marginTop: 2 }),
            })),
          h("label", { style: { fontSize: 11, color: COLORS.muted } },
            h("div", null, "预算上限（美元）"),
            h("input", {
              type: "number",
              step: "0.1",
              min: "0.01",
              value: form.budgetUsd,
              onChange: function (e) { patch({ budgetUsd: e.target.value }); },
              style: Object.assign({}, inputStyle, { width: "100%", marginTop: 2 }),
            })),
          h("label", { style: { fontSize: 11, color: COLORS.muted } },
            h("div", null, "并发"),
            h("select", {
              value: form.concurrency,
              onChange: function (e) { patch({ concurrency: e.target.value }); },
              style: Object.assign({}, inputStyle, { width: "100%", marginTop: 2 }),
            }, ["4", "8", "12", "24"].map(function (n) { return h("option", { key: n, value: n }, n); })),),),
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("button", {
            type: "button",
            onClick: start,
            disabled: busy || running || !currentBank || !currentBank.usable,
            style: Object.assign({}, buttonStyle, { opacity: busy || running || !currentBank || !currentBank.usable ? 0.5 : 1 }),
          }, running ? "运行中…" : "开始评测"),
          running
            ? h("button", { type: "button", onClick: stop, disabled: busy, style: buttonStyle }, "停止")
            : null,
          h("button", { type: "button", onClick: load, style: buttonStyle }, "刷新"),
          currentBank && !currentBank.usable && currentBank.tasks > 0
            ? h("span", { style: { fontSize: 11, color: COLORS.warn } }, "这份不是题库格式（需要 tasks 数组）")
            : null,),
        h("div", { style: { height: 8, borderRadius: 4, background: tint(COLORS.border, 70), overflow: "hidden", margin: "10px 0 4px" } },
          h("div", { style: { width: pct + "%", height: "100%", background: COLORS.accent, transition: "width 300ms ease" } })),
        h("div", { style: { fontSize: 11, color: COLORS.muted } },
          running
            ? pct + "% · " + ((state && state.done) || 0) + "/" + ((state && state.total) || 0) + (state && state.current ? " · " + state.current : "") + (state && state.spentUsd ? " · 已花 $" + Number(state.spentUsd).toFixed(4) : "")
            : state && state.finished
              ? "上一次已完成：" + ((state.done) || 0) + " 格" + (state.spentUsd ? " · 花费 $" + Number(state.spentUsd).toFixed(4) : "") + (state.error ? " · 错误 " + state.error : "")
              : "没有正在跑的评测"),
        error ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.danger } }, error) : null,
        note ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.ok } }, note) : null,
        last && last.models && last.models.length > 0
          ? h("div", { style: { marginTop: 10 } },
            h("div", { style: { fontSize: 11, color: COLORS.muted, marginBottom: 4 } },
              "上次成绩" + (last.ranAt ? "（" + String(last.ranAt).replace("T", " ").slice(0, 16) + "）" : "") + " · " + last.models.length + " 个模型 · 花费 $" + Number(last.spentUsd || 0).toFixed(4)),
            h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 11 } },
              h("thead", null, h("tr", { style: { color: COLORS.muted, textAlign: "left" } },
                h("th", { style: { padding: "3px 6px" } }, "模型"),
                h("th", { style: { padding: "3px 6px" } }, "通过"),
                h("th", { style: { padding: "3px 6px" } }, "均耗时"),
                h("th", { style: { padding: "3px 6px" } }, "花费"),)),
              h("tbody", null, last.models.slice(0, 12).map(function (m) {
                return h("tr", { key: m.id, style: { borderTop: "1px solid " + COLORS.border } },
                  h("td", { style: { padding: "3px 6px" } }, m.id),
                  h("td", { style: { padding: "3px 6px" } }, m.pass + "/" + m.total + (m.errors ? " (" + m.errors + " 错)" : "")),
                  h("td", { style: { padding: "3px 6px" } }, m.avgMs ? Math.round(m.avgMs) + "ms" : "—"),
                  h("td", { style: { padding: "3px 6px" } }, m.cost == null ? "—" : "$" + Number(m.cost).toFixed(4)));
              }))),)
          : null,
      );
    }

    function AuxModelsSection() {
      var stateHook = useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];
      var errorHook = useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      var busyHook = useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var noteHook = useState(null);
      var note = noteHook[0];
      var setNote = noteHook[1];
      var testHook = useState({});
      var tests = testHook[0];
      var setTests = testHook[1];
      var routesHook = useState(null);
      var routes = routesHook[0];
      var setRoutes = routesHook[1];

      function load() {
        setError(null);
        api("/dsh-aux-models/state")
          .then(setState)
          .catch(function (e) { setError(String((e && e.message) || e)); });
      }

      function loadRoutes() {
        api("/dsh-aux-models/routes")
          .then(setRoutes)
          .catch(function (e) {
            setRoutes({ available: false, reason: String((e && e.message) || e), providers: [], apis: [] });
          });
      }

      useEffect(load, []);
      useEffect(loadRoutes, []);

      if (!state) {
        return h("div", { style: { padding: 16, fontSize: 13, color: COLORS.muted } }, error ? "读取注册表失败：" + error : "读取辅助模型注册表…");
      }

      function mutate(fn) {
        var draft = clone({
          channels: state.channels,
          weights: state.weights,
          routing: state.routing,
          defaultModel: state.defaultModel,
          defaultSystem: state.defaultSystem,
        });
        fn(draft);
        setState(Object.assign({}, state, draft));
        setNote(null);
      }

      function channelAt(channelId, fn) {
        mutate(function (draft) {
          var channel = draft.channels.find(function (c) { return c.id === channelId; });
          if (channel) fn(channel);
        });
      }

      function modelAt(channelId, modelId, fn) {
        channelAt(channelId, function (channel) {
          var model = channel.models.find(function (m) { return m.id === modelId; });
          if (model) fn(model);
        });
      }

      function save() {
        setBusy(true);
        setNote(null);
        setError(null);
        postJson("/dsh-aux-models/save", { registry: stripRegistry(state) })
          .then(function (result) { setNote("已保存到 " + result.path + "（" + result.models.length + " 个模型）"); })
          .catch(function (e) { setError(String((e && e.message) || e)); })
          .then(function () { setBusy(false); });
      }

      function runTest(modelId) {
        setTests(Object.assign({}, tests, { [modelId]: { testing: true } }));
        postJson("/dsh-aux-models/test", { modelId: modelId })
          .then(function (result) { setTests(Object.assign({}, tests, { [modelId]: result })); })
          .catch(function (e) { setTests(Object.assign({}, tests, { [modelId]: { ok: false, error: String((e && e.message) || e) } })); });
      }

      var weights = state.weights || { quality: 0.7, cost: 0.3 };
      var taskTypes = state.taskTypes || Object.keys(TASK_LABELS);

      return h(
        "div",
        { style: { padding: "4px 0 20px", color: COLORS.text, fontSize: 13 } },
        h("h3", { style: { margin: "0 0 4px", fontSize: 15 } }, "辅助模型"),
        h(
          "p",
          { style: { margin: "0 0 14px", fontSize: 12, color: COLORS.muted, lineHeight: "19px" } },
          "主模型通过 aux_delegate 把子任务派给这里的模型；分派按「擅长 × 质量 × 价格」打分，跑得越多估得越准。注册表：",
          h("code", { style: { fontSize: 11 } }, state.path || "(默认路径)"),
          state.totals ? "　累计 " + state.totals.calls + " 次调用 · 约 $" + state.totals.usd : "",
        ),
        error
          ? h("div", { style: { padding: "8px 10px", marginBottom: 10, borderRadius: 8, background: tint(COLORS.danger, 12), color: COLORS.danger, fontSize: 12 } }, error)
          : null,

        h(GatewayPanel, { routes: routes, onRefresh: loadRoutes }),

        h(RoutePreview, null),

        h(EvalPanel, null),

        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, padding: 12, border: "1px solid " + COLORS.border, borderRadius: 10, background: COLORS.bg } },
          h(
            Field,
            { label: "质量权重 " + weights.quality.toFixed(2) + " / 成本权重 " + weights.cost.toFixed(2) },
            h("input", {
              type: "range",
              min: 0,
              max: 1,
              step: 0.05,
              value: weights.quality,
              onChange: function (e) {
                var quality = num(e.target.value, 0.7);
                mutate(function (draft) { draft.weights = { quality: Number(quality.toFixed(2)), cost: Number((1 - quality).toFixed(2)) }; });
              },
              style: { width: "100%" },
            }),
          ),
          h(Field, { label: "默认模型（无法判断时用）" }, h("input", {
            value: state.defaultModel || "",
            onChange: function (e) { mutate(function (draft) { draft.defaultModel = e.target.value; }); },
            style: inputStyle,
          })),
          h(NumberField, {
            label: "单次预算上限 $",
            value: state.routing && state.routing.maxCostPerCall,
            step: 0.01,
            onChange: function (v) { mutate(function (draft) { draft.routing = Object.assign({}, draft.routing, { maxCostPerCall: v }); }); },
          }),
          h(
            Field,
            { label: "不确定时询问（质量差阈值）" },
            h("input", {
              type: "range",
              min: 0.02,
              max: 0.5,
              step: 0.01,
              value: (state.routing && state.routing.askBelowConfidence) || 0.15,
              onChange: function (e) { mutate(function (draft) { draft.routing = Object.assign({}, draft.routing, { askBelowConfidence: num(e.target.value, 0.15) }); }); },
              style: { width: "100%" },
            }),
          ),
        ),

        state.channels.map(function (channel) {
          return h(
            "div",
            { key: channel.id, style: { marginTop: 16, border: "1px solid " + COLORS.border, borderRadius: 12, padding: 12, background: COLORS.bg } },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
              h("strong", { style: { fontSize: 13 } }, "分组 · " + (channel.name || channel.id)),
              h(Pill, null, "×" + channel.multiplier),
              h(Pill, null, "缓存命中 " + Math.round((channel.cacheHitRate || 0) * 100) + "%"),
              h(
                Pill,
                { bg: channel.stability >= 7 ? tint(COLORS.ok, 12) : tint(COLORS.warn, 14), border: channel.stability >= 7 ? tint(COLORS.ok, 36) : tint(COLORS.warn, 38), color: channel.stability >= 7 ? COLORS.ok : COLORS.warn },
                "稳定性 " + channel.stability + "/10",
              ),
              h(Check, { label: "启用分组", checked: channel.enabled, onChange: function (v) { channelAt(channel.id, function (c) { c.enabled = v; }); } }),
            ),
            h(
              "div",
              { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 10 } },
              h(Field, { label: "分组 id" }, h("input", { value: channel.id, readOnly: true, style: Object.assign({}, inputStyle, { opacity: 0.7 }) })),
              h(Field, { label: "provider 路由" }, h("input", { value: channel.provider, onChange: function (e) { channelAt(channel.id, function (c) { c.provider = e.target.value; }); }, style: inputStyle })),
              h(NumberField, { label: "倍率", value: channel.multiplier, step: 0.01, onChange: function (v) { channelAt(channel.id, function (c) { c.multiplier = v; }); } }),
              h(NumberField, { label: "缓存命中率", value: channel.cacheHitRate, step: 0.05, onChange: function (v) { channelAt(channel.id, function (c) { c.cacheHitRate = v; }); } }),
              h(NumberField, { label: "稳定性 1-10", value: channel.stability, step: 1, onChange: function (v) { channelAt(channel.id, function (c) { c.stability = v; }); } }),
            ),
            channel.models.map(function (model) {
              var test = tests[model.id] || null;
              return h(ModelCard, {
                key: model.id,
                model: model,
                taskTypes: taskTypes,
                onChange: function (patch) { modelAt(channel.id, model.id, function (m) { Object.assign(m, patch); }); },
                onPricing: function (patch) { modelAt(channel.id, model.id, function (m) { m.pricing = Object.assign({}, m.pricing, patch); }); },
                onDelete: function () { channelAt(channel.id, function (c) { c.models = c.models.filter(function (m) { return m.id !== model.id; }); }); },
                onTest: function () { runTest(model.id); },
                testing: !!(test && test.testing),
                testResult: test && !test.testing ? test : null,
              });
            }),
            h(
              "button",
              {
                type: "button",
                onClick: function () {
                  channelAt(channel.id, function (c) {
                    var index = 1;
                    var id = "model-" + index;
                    while (c.models.some(function (m) { return m.id === id; })) id = "model-" + ++index;
                    c.models.push({
                      id: id,
                      label: id,
                      model: "",
                      qualityTier: 2,
                      strengths: ["general"],
                      contextWindow: 128000,
                      maxOutputTokens: 16000,
                      supportsTools: true,
                      enabled: true,
                      notes: "",
                      pricing: { inputPerM: undefined, outputPerM: undefined, source: "manual" },
                    });
                  });
                },
                style: { marginTop: 10, padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", border: "1px dashed " + COLORS.border, background: "transparent", color: COLORS.muted },
              },
              "+ 添加模型",
            ),
          );
        }),

        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 16 } },
          h(
            "button",
            {
              type: "button",
              onClick: save,
              disabled: busy,
              style: { padding: "6px 16px", fontSize: 13, borderRadius: 8, cursor: busy ? "default" : "pointer", fontFamily: "inherit", border: "1px solid " + COLORS.accent, background: COLORS.accent, color: "#ffffff", opacity: busy ? 0.7 : 1 },
            },
            busy ? "保存中…" : "保存",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: load,
              style: { padding: "6px 12px", fontSize: 13, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", border: "1px solid " + COLORS.border, background: COLORS.card, color: COLORS.text },
            },
            "重新读取",
          ),
          note ? h("span", { style: { fontSize: 12, color: COLORS.ok } }, note) : null,
        ),
        h(
          "p",
          { style: { margin: "12px 0 0", fontSize: 11, color: COLORS.muted, lineHeight: "18px" } },
          "保存后立即生效（不需要重启）。模型 id 是 aux_delegate / aux_route 里用的名字；映射表示该 id 在网关上实际路由到哪个模型，只影响显示与真实计费口径。",
        ),
      );
    }

    // 「价格设置」页（dsh-balance 的定价段）从 window.dshDesktop.balancePrices
    // 取读写桥。本构建的桌面壳用 contextBridge 暴露 dshDesktop（对象冻结、
    // window 属性不可写），所以**挂不上去**；页面侧已改为同时接受
    // window.__dshBalancePrices 这个普通全局槽位。这里补一个同契约的实现，
    // 后端走我们自己的 /dsh-aux-models/balance-prices（落到 price-table.json），
    // 于是那一页原地可用，且和实测单价同一个真源。
    function balanceBridge() {
      function call(method, body) {
        return fetch("/dsh-aux-models/balance-prices", {
          method: method,
          cache: "no-store",
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        }).then(function (res) {
          return res.json();
        });
      }
      return {
        get: function (model) {
          return call("GET").then(function (payload) {
            var prices = payload.prices || {};
            var defaults = payload.defaults || {};
            return {
              ok: payload.ok !== false,
              current: prices[model] || defaults[model] || null,
              defaults: defaults[model] || null,
              error: payload.error,
            };
          });
        },
        save: function (model, prices) {
          return call("POST", { model: model, prices: prices });
        },
        reset: function (model) {
          return call("POST", { model: model, reset: true });
        },
      };
    }

    function installBalanceBridge() {
      try {
        if (!window.__dshBalancePrices) window.__dshBalancePrices = balanceBridge();
      } catch (error) {
        /* 装不上就还是原来的报错，不影响其它功能 */
      }
      try {
        // 真桌面壳（或未来版本）如果已经给了官方桥，就不要动它。
        var desktop = window.dshDesktop;
        if (desktop && !desktop.balancePrices) {
          desktop.balancePrices = window.__dshBalancePrices;
        }
      } catch (error) {
        /* contextBridge 暴露的对象是冻结的，写不进去属正常情况 */
      }
    }

    function apply(ctx) {
      installBalanceBridge();
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({ name: "settings.section", id: "aux-models", order: 72, label: "辅助模型" }, AuxModelsSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.__internals = { stripRegistry: stripRegistry, money: money, installBalanceBridge: installBalanceBridge, balanceBridge: balanceBridge };
    return module.exports;
  },
});
