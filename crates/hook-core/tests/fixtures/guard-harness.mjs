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

// The other half of the git rule: a folder that is not one of Hook's projects.
// Hook gives those runs no managed config, so the guard says what git can do
// there instead - and the two answers are different, because a folder inside
// the user's own repository keeps their credentials and one outside any
// repository has none.
async function promptFor(tag) {
  const text = readFileSync(guardPath, "utf8");
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(text).toString("base64") + `#${tag}`
  );
  const seen = {};
  mod.default({
    on(name, fn) {
      (seen[name] ||= []).push(fn);
    },
    registerTool() {},
  });
  const started = await seen.before_agent_start[0]({ systemPrompt: "BASE" });
  return started?.systemPrompt ?? "";
}

/** The same, keeping the tools the guard registered. */
async function toolsFor(tag) {
  const text = readFileSync(guardPath, "utf8");
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(text).toString("base64") + `#${tag}`
  );
  const seen = {};
  const registered = {};
  mod.default({
    on(name, fn) {
      (seen[name] ||= []).push(fn);
    },
    registerTool(tool) {
      registered[tool.name] = tool;
    },
  });
  const started = await seen.before_agent_start[0]({ systemPrompt: "BASE" });
  return { prompt: started?.systemPrompt ?? "", names: Object.keys(registered), tools: registered };
}
delete process.env.GIT_CONFIG_GLOBAL;
process.env.HOOK_SYNC = "0";
process.env.HOOK_USER_GIT = "1";
const userRepoPrompt = await promptFor("git-user-repo");
process.env.HOOK_USER_GIT = "0";
const noRepoPrompt = await promptFor("git-no-repo");

// Pictures: the guard only promises `read` on an image when the model card
// said the model can see one. A text-only model must never be told it can.
process.env.HOOK_VISION = "1";
const visionPrompt = await promptFor("vision-on");
delete process.env.HOOK_VISION;
const noVisionPrompt = await promptFor("vision-off");

// Making pictures: Hook hands the key down, and without one the tool is never
// registered - a tool that can only fail is worse than no tool.
// A direct conversation gets `generate_image` from the bridge instead (it can
// put the picture in front of the user), so the local-only tool is loaded from
// the relayed shape whatever mode this harness was started in. The tool is an
// account request, so what turns it on is the service Hook handed down - never
// an endpoint key, which the engine does not get.
const wasDirect = process.env.HOOK_DIRECT;
delete process.env.HOOK_DIRECT;
process.env.HOOK_API_BASE = "https://hookcode.test";
process.env.HOOK_API_TOKEN = "hk_test_token_0123456789abcdefghij";
const picturesOn = await toolsFor("image-on");
delete process.env.HOOK_API_BASE, process.env.HOOK_API_TOKEN;
const picturesOff = await toolsFor("image-off");
if (wasDirect) process.env.HOOK_DIRECT = wasDirect;

// The tool itself, with the endpoint stubbed: no key is spent and no network is
// needed. What matters is what lands on disk, because this run has no chat to
// show a picture in.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const imageDir = mkdtempSync(join(tmpdir(), "hook-image-"));
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] }),
});
const madeOnce = await picturesOn.tools.generate_image.execute("c_img", {
  prompt: "A red panda, in space",
  save_to: imageDir,
});
const madeTwice = await picturesOn.tools.generate_image.execute("c_img2", {
  prompt: "A red panda, in space",
  save_to: imageDir,
});
const madeNothing = await picturesOn.tools.generate_image.execute("c_img3", { prompt: " " });
const imageFiles = readdirSync(imageDir).sort();

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
  pictures: {
    promisedWithVision:
      /## Pictures/.test(visionPrompt) && /returns the image itself/.test(visionPrompt),
    silentWithoutVision: !/## Pictures/.test(noVisionPrompt),
    absentByDefault: !/## Pictures/.test(before?.systemPrompt ?? ""),
  },
  pictureMaking: {
    registeredWithService: picturesOn.names.includes("generate_image"),
    silentWithoutService: !picturesOff.names.includes("generate_image"),
    wrote: imageFiles,
    resultOk: madeOnce?.isError !== true,
    reportsThePath:
      typeof madeOnce?.content?.[0]?.text === "string" &&
      madeOnce.content[0].text.includes(imageDir),
    emptyPromptRejected: madeNothing?.isError === true,
    secondCallDidNotOverwrite: madeTwice?.isError !== true && imageFiles.length === 2,
    guidanceWithService: /## Making pictures/.test(picturesOn.prompt),
    guidanceWithoutService: !/## Making pictures/.test(picturesOff.prompt),
  },
  direct,
  // The one tool a relayed run has and a direct conversation does not.
  relayOnly: {
    reportProgress: Boolean(tools.report_progress),
  },
  guidance: {
    checklist: /update_plan/.test(before?.systemPrompt ?? ""),
    preview: /show_preview/.test(before?.systemPrompt ?? ""),
    identity: /running inside Hook/i.test(before?.systemPrompt ?? ""),
  },
  // A folder that is not a Hook project: the user's own repository keeps their
  // git config, and a folder outside any repository has no credentials at all.
  git: {
    userRepo: /the user's own repository/i.test(userRepoPrompt),
    noCredentials: /no credentials here/i.test(noRepoPrompt),
    userRepoKeepsConfig: /reads their own config/i.test(userRepoPrompt),
  },
};

process.stdout.write(JSON.stringify(results));
