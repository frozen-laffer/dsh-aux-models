// Offline check for the aux_delegate tool loop: stubs ctx.llm.stream and
// ctx.tools so the loop, the message shapes, and the tool-result plumbing can be
// inspected without restarting the desktop client.
//
//   node check-loop.mjs
//
// Exits non-zero when the loop stops producing the expected round trip.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "aux-loop-"));
const registryPath = join(dir, "aux-models.json");
writeFileSync(registryPath, JSON.stringify({
  defaultModel: "luna",
  models: [{ id: "luna", provider: "dieqi", model: "gpt-5.6-luna", supportsTools: true }],
}));

const mod = await import(pathToFileURL(join(import.meta.dirname, "index.js")).href);

const requests = [];
const executed = [];
let round = 0;

const schemas = [
  { name: "read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "write", description: "Write a file", parameters: { type: "object", properties: {} } },
];

const ctx = {
  effect: (fn) => fn(),
  inject: () => {},
  get: () => undefined,
  tools: {
    register: () => () => {},
    schemas: () => schemas,
    async execute(input) {
      executed.push(input);
      return { isError: false, value: "line1\nline2", content: [{ type: "text", text: "line1\nline2" }] };
    },
  },
  systemPrompt: { section: () => () => {}, assemble: async () => ({ sections: [] }) },
  llm: {
    async *stream(request) {
      requests.push(request);
      round++;
      if (round === 1) {
        yield { type: "text-delta", index: 0, text: "我看看文件" };
        yield { type: "tool-call-delta", index: 0, id: "call_abc", name: "read", argumentsDelta: "" };
        yield { type: "tool-call-delta", index: 0, id: "call_abc", name: "read", argumentsDelta: '{"file_path":' };
        yield { type: "tool-call-delta", index: 0, id: "call_abc", name: "read", argumentsDelta: '"F:/a.txt"}' };
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
      yield { type: "text-delta", index: 0, text: "文件里有两行，第一行是 line1。" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
};

await mod.apply(ctx, { registryPath });

// The plugin registers aux_models first, aux_delegate second.
const registrations = [];
const probe = { ...ctx, tools: { ...ctx.tools, register: (definition) => { registrations.push(definition); return () => {}; } } };
await mod.apply(probe, { registryPath });
const delegate = registrations.find(definition => definition.name === "aux_delegate");
if (!delegate) {
  console.error("check-loop: aux_delegate was not registered");
  process.exit(1);
}

const result = await delegate.execute(
  { task: "读一下 F:/a.txt 并总结", tools: true, max_rounds: 4 },
  { sessionId: "test-session", signal: new AbortController().signal, token: Symbol("t"), rootCallId: "root-1", agent: { id: "agent-1" } },
);

console.log(`rounds=${result.rounds} toolCalls=${result.toolCalls} used=${JSON.stringify(result.used)}`);
console.log(`answer: ${result.text}`);
console.log(`llm requests: ${requests.length} (first round tools: ${(requests[0].tools ?? []).map(tool => tool.name).join(",") || "none"})`);
console.log("--- second request messages ---");
console.log(JSON.stringify(requests[1]?.messages, null, 1));
console.log(`executed: ${executed.map(call => `${call.name}(${JSON.stringify(call.arguments)})`).join(", ")}`);

const second = requests[1];
const assistant = second?.messages?.[1];
const toolMessage = second?.messages?.[2];
const ok = result.text.includes("line1")
  && executed.length === 1
  && executed[0].name === "read"
  && executed[0].arguments?.file_path === "F:/a.txt"
  && assistant?.role === "assistant"
  && assistant.content.some(block => block.type === "tool-call" && block.id === "call_abc")
  && toolMessage?.role === "tool"
  && toolMessage.toolCallId === "call_abc";

if (!ok) {
  console.error("check-loop: the tool round trip did not produce the expected messages");
  process.exit(1);
}
console.log("check-loop: ok");
