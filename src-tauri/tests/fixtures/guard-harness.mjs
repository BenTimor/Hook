// Exercises Hook's guard extension without pi: loads it, wires a fake
// ExtensionAPI, and calls the hooks the way pi would.
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const guardPath = process.argv[2];
const source = readFileSync(guardPath, "utf8");
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64") + `#${Date.now()}`
).catch(() => import(pathToFileURL(guardPath).href + `?t=${Date.now()}`));

const handlers = {};
const pi = {
  on(name, fn) {
    (handlers[name] ||= []).push(fn);
  },
};
mod.default(pi);

const before = await handlers.before_agent_start[0]({ systemPrompt: "BASE" });
const bash = (input) => handlers.tool_call[0]({ toolName: "bash", input }, {});

const results = {
  hooks: Object.keys(handlers).sort(),
  guidelineAppended:
    typeof before?.systemPrompt === "string" &&
    before.systemPrompt.startsWith("BASE") &&
    /timeout/i.test(before.systemPrompt),
  missing: await bash({ command: "ls -la" }),
  zero: await bash({ command: "ls -la", timeout: 0 }),
  huge: await bash({ command: "ls -la", timeout: 99999 }),
  negative: await bash({ command: "ls -la", timeout: -5 }),
  wrongType: await bash({ command: "ls -la", timeout: "30" }),
  ok: await bash({ command: "ls -la", timeout: 30 }),
  nonBash: await handlers.tool_call[0]({ toolName: "read", input: {} }, {}),
};

process.stdout.write(JSON.stringify(results));
