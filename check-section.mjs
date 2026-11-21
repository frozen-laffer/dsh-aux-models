// Offline check: run this plugin against a stub ctx and print the rendered
// system-prompt section. Lets you verify a code change without restarting the
// desktop client (HMR keeps loaded modules on their previous code).
//
//   node check-section.mjs
//
// Exits non-zero when the section is missing or empty, so it can gate a commit.

const mod = await import("./index.js");

const sections = [];
const tools = [];
const ctx = {
  effect: (fn) => fn(),
  tools: { register: (definition) => { tools.push(definition); return () => {}; } },
  llm: { stream: async function* () { yield { type: "finish", reason: { kind: "eof" } }; } },
  systemPrompt: {
    section: (section) => { sections.push(section); return () => {}; },
    async assemble() {
      return {
        sections: sections.map((section) => ({
          name: section.name,
          text: typeof section.text === "function" ? section.text({}) : section.text,
        })),
        contexts: [],
        tools: [],
        variables: {},
      };
    },
  },
};

ctx.inject = function () { return undefined; };

await mod.apply(ctx, {});

console.log(`plugin ${mod.name} · inject ${JSON.stringify(mod.inject)}`);
console.log(`tools: ${tools.map((tool) => tool.name).join(", ") || "(none)"}`);
console.log(`sections: ${sections.map((section) => `${section.name}@${section.order}`).join(", ") || "(none)"}`);

const assembly = await ctx.systemPrompt.assemble();
const mine = assembly.sections.find((section) => section.name === "aux-models:routing");
console.log("--- rendered section ---");
console.log(mine ? mine.text : "(MISSING)");
console.log("--- end ---");

if (!mine || mine.text.trim().length === 0) {
  console.error("check-section: the routing section is missing or empty");
  process.exit(1);
}
