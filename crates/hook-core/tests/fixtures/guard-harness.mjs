// Exercises Hook's guard extension without pi: loads it, wires a fake
// ExtensionAPI, and calls the hooks and tools the way pi would.
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guardPath = process.argv[2];
// The guard reads its shape from the environment - and so does whatever ran
// this test. A run started from inside a coding agent inherits `HOOK_DIRECT`,
// `HOOK_SYNC` and the mailbox, and would quietly test the wrong shape. Start
// from nothing; the two modes below set exactly what they mean.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HOOK_") || key.startsWith("PI_")) delete process.env[key];
}
// A directly-driven agent (the user talks to it, nothing relays it) loads the
// same guard with a different shape. The guard reads the flag at import time.
const direct = process.argv[3] === "direct";
if (direct) process.env.HOOK_DIRECT = "1";

// The guard reads its mailbox at import time, so the folder has to exist first.
const updatesDir = mkdtempSync(join(tmpdir(), "hook-guard-"));
process.env.HOOK_UPDATES_DIR = updatesDir;
process.env.GIT_CONFIG_GLOBAL = join(updatesDir, "gitconfig");
writeFileSync(
  join(updatesDir, "plan.json"),
  JSON.stringify({
    steps: [
      { title: "Setting things up", status: "active" },
      { title: "Designing the front page", status: "pending" },
    ],
  }),
);

const source = readFileSync(guardPath, "utf8");
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64") + `#${Date.now()}`
).catch(() => import(pathToFileURL(guardPath).href + `?t=${Date.now()}`));

const handlers = {};
const tools = {};
const pi = {
  on(name, fn) {
    (handlers[name] ||= []).push(fn);
  },
  registerTool(tool) {
    tools[tool.name] = tool;
  },
};
mod.default(pi);

const before = await handlers.before_agent_start[0]({ systemPrompt: "BASE" });
const bash = (input) => handlers.tool_call[0]({ toolName: "bash", input }, {});

const planResult = await tools.update_plan?.execute("call_plan", {
  steps: [
    { title: "Setting things up", status: "done" },
    { title: "Designing the front page", status: "active" },
    { title: "", status: "whatever" },
  ],
});
const emptyPlan = await tools.update_plan?.execute("call_empty", { steps: [] });
const previewOk = await tools.show_preview?.execute("call_preview", {
  file: "preview.html",
  title: "Insights",
});
const previewOutside = await tools.show_preview?.execute("call_preview_bad", {
  file: "../evil.tsx",
  title: "Nope",
});
const previewNotHtml = await tools.show_preview?.execute("call_preview_tsx", {
  file: "app.tsx",
  title: "Nope",
});
const planFiles = readdirSync(updatesDir).filter((name) => name.startsWith("p-"));
const previewFiles = readdirSync(updatesDir).filter((name) => name.startsWith("v-"));
const previewWritten = previewFiles.length
  ? JSON.parse(readFileSync(join(updatesDir, previewFiles[0]), "utf8"))
  : null;
const written = planFiles.length
  ? JSON.parse(readFileSync(join(updatesDir, planFiles[0]), "utf8"))
  : null;

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
  forcePush: await bash({ command: "git push --force origin main", timeout: 30 }),
  forcePushLease: await bash({
    command: "git push --force-with-lease origin main",
    timeout: 30,
  }),
  deleteBranch: await bash({ command: "git push origin --delete main", timeout: 30 }),
  normalPush: await bash({ command: "git push origin main", timeout: 30 }),
  preview: {
    toolsRegistered: Boolean(tools.show_preview),
    guidanceExplainsOptional: /optional/i.test(before?.systemPrompt ?? ""),
    resultOk: previewOk?.isError !== true,
    outsideNonHtmlRejected: previewOutside?.isError === true,
    nonHtmlRejected: previewNotHtml?.isError === true,
    written: previewWritten
      ? { file: previewWritten.file, title: previewWritten.title }
      : null,
  },
  sync: {
    toolsRegistered: Boolean(tools.sync_pull && tools.sync_push),
    guidanceExplainsPull: /sync_pull/.test(before?.systemPrompt ?? ""),
    guidanceExplainsSave: /sync_push/.test(before?.systemPrompt ?? ""),
  },
  plan: {
    toolsRegistered: Boolean(tools.update_plan),
    guidanceIncludesSeed:
      typeof before?.systemPrompt === "string" &&
      before.systemPrompt.includes("Setting things up"),
    guidanceExplainsPlainLanguage: /no file names/i.test(before?.systemPrompt ?? ""),
    resultOk: planResult?.isError !== true,
    emptyPlanRejected: emptyPlan?.isError === true,
    written: written?.steps ?? null,
  },
  direct,
  // The one tool a relayed run has and a direct conversation does not.
  relayOnly: {
    reportProgress: Boolean(tools.report_progress),
  },
  guidance: {
    checklist: /update_plan/.test(before?.systemPrompt ?? ""),
    preview: /show_preview/.test(before?.systemPrompt ?? ""),
  },
};

process.stdout.write(JSON.stringify(results));
