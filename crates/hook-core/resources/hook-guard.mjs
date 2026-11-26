/**
 * Hook coding-agent guard.
 *
 * Loaded into every coding agent that Hook launches. Coding agents run fully
 * sandboxed from the host's pi setup (`-ne -e this-file`), so the only policy
 * they inherit is what lives here.
 *
 * 1. Deadline enforcement: every `bash` tool call must carry a finite `timeout`
 *    in seconds within [MIN, MAX]. A command that hangs with no deadline stalls
 *    the whole agent run, so an unset/oversized timeout is blocked and the model
 *    is told to re-issue the call. Mirrors the enforce-bash-timeout convention.
 * 2. The rule is also stated up front in the system prompt so the model rarely
 *    trips over it.
 * 3. Progress reporting: the `report_progress` tool drops notes (and optional
 *    pictures) into a mailbox Hook owns. Hook batches them and hands them to the
 *    chat agent, which turns them into the updates the user actually reads.
 * 4. The checklist: the user watches a short, plain-language plan in the chat.
 *    Hook seeds it (the chat agent writes it) and the `update_plan` tool lets the
 *    coding agent move steps between pending, active and done. Plain files only:
 *    nothing here talks to a network or a model.
 * 5. Checklist upkeep: a model deep in a task will happily make forty tool calls
 *    with the first step still marked active, then mark everything done at the
 *    end - the user watches a stuck checklist for the whole run. The guard keeps
 *    the plan in front of the model: a one-line reminder rides on a tool result
 *    after a few calls, and after more the next tool call is refused until the
 *    plan moves. Both counters reset, so a run can never be deadlocked.
 * 6. The preview panel: the user can watch one HTML page from the project in a
 *    panel on the right. `show_preview` writes a pointer into the same mailbox;
 *    Hook serves the page and reloads it as the project changes. The coding
 *    agent decides when a page is worth showing, and can switch it later.
 *
 * Tunables (environment, set by the Hook runtime from harness.config.toml):
 *   PI_BASH_MAX_TIMEOUT  hard cap in seconds (default 3600)
 *   PI_BASH_MIN_TIMEOUT  floor in seconds (default 1)
 *   PI_BASH_ENFORCE      "0" downgrades to warn-and-cap instead of blocking
 *   HOOK_UPDATES_DIR     mailbox folder for progress notes, the plan and the
 *                        preview pointer
 *                        (unset = disabled)
 *
 * Plain ESM on purpose: only Node built-ins, nothing that can fail to resolve.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAX_TIMEOUT = Number(process.env.PI_BASH_MAX_TIMEOUT ?? 3600);
const MIN_TIMEOUT = Number(process.env.PI_BASH_MIN_TIMEOUT ?? 1);
const ENFORCE = (process.env.PI_BASH_ENFORCE ?? "1") !== "0";

function clampLabel(v) {
  if (v >= 3600) return `${Math.round(v / 3600)}h`;
  if (v >= 60) return `${Math.round(v / 60)}min`;
  return `${v}s`;
}

// ── Project sync (Hook cloud) ─────────────────────────────────────────────
// The project is stored in the user's account. These two tools are the only
// supported way to touch the network: the git credential lives in Hook's
// managed global config, never in the project or the remote URL.
//
// `HOOK_SYNC=0` means this folder is not one of the account's projects (the
// user pointed a direct coding agent at some other folder), so the tools would
// have no repository to talk to.
const SYNC_ENABLED =
  Boolean(process.env.GIT_CONFIG_GLOBAL) && process.env.HOOK_SYNC !== "0";
const GIT_TIMEOUT_MS = 180_000;

function runGit(args, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    const out = execFileSync("git", args, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, out, err: "" };
  } catch (error) {
    if (error?.code === "ENOENT")
      return { ok: false, out: "", err: "git is not available on this machine" };
    return {
      ok: false,
      out: String(error?.stdout ?? ""),
      err: String(error?.stderr || error?.message || "git failed"),
    };
  }
}

function syncGuidance() {
  if (!SYNC_ENABLED) return "";
  return `

## Project sync (Hook cloud)
This project is stored in the user's Hook account and can be worked on from any of their computers. The folder you start in may be empty because the work was started somewhere else.
- Before doing anything else, call \`sync_pull\`. It fetches and applies the latest saved version. If it reports that nothing has been saved yet, that is normal for a new project: carry on.
- When you finish - and also when you are blocked or stopping early - call \`sync_push\` with a short message describing what changed. Never leave finished work only on this computer.
- If pulling reports conflicts, edit the listed files to resolve them, then call \`sync_push\`.
- \`sync_pull\` and \`sync_push\` only work on the folder this run started in. Work in another folder is not part of the Hook project and Hook will not save it. If that folder is a git repository, use git yourself; Hook's credential only covers Hook project remotes.
- Never force-push, never rewrite history that is already saved, and never delete a branch on the account. The guard blocks those commands.
- Keep the repository small: do not commit node_modules, virtualenvs, build output, caches or large binaries. Hook rejects projects over its storage limit.`;
}


const UPDATES_DIR = process.env.HOOK_UPDATES_DIR ?? "";

/**
 * The user is talking to this agent directly, in its own chat.
 *
 * Nothing relays its words and nothing reads its progress notes, so the guard
 * changes shape: `report_progress` would be a mailbox nobody empties, and the
 * chat agent's own tools (projects, memory, Workspace) arrive over Hook's
 * loopback bridge instead of being Rust-only.
 */
const DIRECT = process.env.HOOK_DIRECT === "1";

const MAX_PICTURES = 4;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const PICTURE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const PREVIEW_TITLE_MAX = 80;

const PLAN_SEED_FILE = join(UPDATES_DIR || ".", "plan.json");
const MAX_PLAN_STEPS = 12;
const MAX_STEP_TITLE = 90;
const STEP_STATUSES = ["pending", "active", "done"];

// How many tool calls may pass before the checklist is put back in front of the
// model, and before one call is refused outright. Small enough that a long run
// moves the plan several times, large enough not to interrupt every other turn.
const PLAN_NUDGE_AFTER = 3;
const PLAN_BLOCK_AFTER = 5;
let callsSincePlan = 0;
let callsSinceNudge = 0;

/** Keep only steps a person can read; drop empties and unknown statuses. */
function cleanPlan(input) {
  if (!Array.isArray(input)) return [];
  const steps = [];
  for (const raw of input.slice(0, MAX_PLAN_STEPS)) {
    // Tolerate a plain string: the schema asks for objects, but a model that
    // sends ["Setting things up", ...] should not lose its plan.
    const step = typeof raw === "string" ? { title: raw } : raw;
    const title = String(step?.title ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_STEP_TITLE);
    if (!title) continue;
    const status = STEP_STATUSES.includes(step?.status) ? step.status : "pending";
    steps.push({ title, status });
  }
  return steps;
}

/** The plan Hook seeded from the chat agent's brief, if any. */
function readSeedPlan() {
  if (!UPDATES_DIR) return [];
  try {
    return cleanPlan(JSON.parse(readFileSync(PLAN_SEED_FILE, "utf8"))?.steps);
  } catch {
    return [];
  }
}

/** The checklist as the user is seeing it, one step per line. */
function planLines(steps) {
  return steps.map((step, index) => `${index + 1}. ${step.title} [${step.status}]`).join("\n");
}

/** The step the user currently sees spinning, in one short sentence. */
function planReminder() {
  const steps = readSeedPlan();
  if (!steps.length) {
    return "The user is watching an empty checklist: call `update_plan` with three to six plain-language steps.";
  }
  const index = steps.findIndex((step) => step.status === "active");
  const position = index < 0 ? 0 : index;
  return `The user still sees step ${position + 1}/${steps.length} active: "${steps[position].title}". Call \`update_plan\` as soon as that changes.`;
}

/** Tell the coding agent which checklist the user is watching, and how to keep it. */
function planGuidance() {
  const seed = readSeedPlan();
  const rules =
    "\n\n## The user's checklist (Hook)\n" +
    "The user watches this checklist at the bottom of the chat while you work. Keeping it current is part of the job, not a report you write at the end. `update_plan` is how you move it:\n" +
    "- Call `update_plan` the moment a step is finished: mark that step `done` and the step you are now on `active` in the same call. Do not wait for the end of the work, and never mark several finished steps only when you are done.\n" +
    "- A step that is finished but still shown `active` is a lie to the user. If you have moved past a step, update the checklist before you carry on.\n" +
    "- If one step is taking a lot of tool calls because it really holds several jobs, split it into smaller plain-language steps instead of leaving it as one. The user should see the checklist move.\n" +
    "- Keep the wording that is already shown. Add or reorder a step only when the work genuinely changes. Never more than " +
    MAX_PLAN_STEPS +
    " steps.\n" +
    "- Plain, everyday language only. The user is not reading a changelog: no file names, no tool names, no commands, no package names, no jargon. Good: 'Setting things up', 'Designing the front page', 'Hooking up the real service'.\n" +
    "- At most one step is `active` at a time; everything not started stays `pending`. When the whole job is finished, every step is `done`.\n";
  if (!seed.length) {
    return rules + "There is no checklist yet. Before your first tool call, call `update_plan` with three to six steps.";
  }
  const index = seed.findIndex((step) => step.status === "active");
  const current = index < 0 ? "" : `\nThe user currently sees step ${index + 1} active. Move it on as soon as it is done.`;
  return rules + "Current checklist:\n" + planLines(seed) + current;
}

/** The page a coding agent wants Hook to show in the right-side panel. */
function normalizePreviewFile(raw) {
  const text = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!text) return { error: "show_preview needs a `file`." };
  const absolute = resolve(process.cwd(), text);
  if (!/\.html?$/i.test(absolute)) {
    return { error: "The preview file must be an .html page." };
  }
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return { error: "The preview path must be an HTML file, not a folder." };
  }
  // Any HTML page on this machine. The panel serves the page's own folder, so
  // its relative and absolute asset paths still resolve.
  return { file: absolute, absolute };
}

/** Tell the coding agent when a preview is worth showing, and how to point it. */
function previewGuidance() {
  return (
    "\n\n## Preview panel (Hook)\n" +
    "Hook has a preview panel on the right side of the window. It shows one HTML page from this project and refreshes it by itself whenever the project changes. It is optional, and it is for the user - you never see it.\n" +
    "- Call `show_preview` when the work has something worth looking at: a frontend page, a UI change, a data analysis with charts, a visual report. Skip it for backend work, refactors, scripts, configuration, or anything with nothing to look at.\n" +
    "- Set it as early as possible, not at the end. The page does not have to exist yet: `show_preview` can point at a file you are about to write, and the panel waits for it.\n" +
    "- Frontend work: point at the page the user should see, usually index.html or the project preview entry - never a source file such as App.tsx. Keep that page working and current while you change the app, with relative paths so it behaves like the real page.\n" +
    "- Other work worth seeing: create a standalone, self-contained HTML page (for example preview.html) with the real insights and charts, and call `show_preview` for it. Keep it updated as findings change.\n" +
    "- Call `show_preview` again only to switch to a different page. Do not re-show the same file.\n" +
    "- The panel opens by itself the first time in a session; never ask permission and never explain the mechanics to the user. If the brief asks for a preview, do it."
  );
}

/** Copy one picture into the mailbox so it cannot vanish before Hook reads it. */
function stagePicture(filesDir, source, files) {
  const absolute = resolve(source);
  if (!existsSync(absolute)) {
    return { error: `${source} does not exist` };
  }
  const name = basename(absolute);
  if (!PICTURE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
    return { error: `${name} is not a png, jpg, webp or gif` };
  }
  if (statSync(absolute).size > MAX_PICTURE_BYTES) {
    return { error: `${name} is larger than ${MAX_PICTURE_BYTES / 1048576} MB` };
  }
  const target = `${Date.now()}-${files.length}-${name}`;
  copyFileSync(absolute, join(filesDir, target));
  files.push(target);
  return { name: target };
}

/**
 * The chat agent's own tools, handed to a directly-driven agent.
 *
 * Hook runs them (projects, memory, the Workspace API) and the guard only
 * forwards the call over loopback: the engine cannot reach Rust, and the token
 * in this file is what proves the call belongs to this chat. See
 * `crates/hook-core/src/bridge.rs`.
 */
function bridgeHandle() {
  if (!DIRECT || !UPDATES_DIR) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(UPDATES_DIR, "tools.json"), "utf8"));
    const url = String(parsed?.url ?? "");
    const token = String(parsed?.token ?? "");
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    if (!url || !token || !tools.length) return null;
    return { url, token, tools };
  } catch {
    return null;
  }
}

/** What Hook already remembers about the user, from the same account store. */
function memoryGuidance() {
  if (!DIRECT || !UPDATES_DIR) return "";
  try {
    const text = readFileSync(join(UPDATES_DIR, "memory.txt"), "utf8").trim();
    return text ? `\n\n${text}` : "";
  } catch {
    return "";
  }
}

/** Why this run looks different from a run the chat agent started. */
function directGuidance() {
  if (!DIRECT) return "";
  return (
    "\n\n## Talking to the user directly (Hook)" +
    "\nThis conversation is only you and the user: there is no assistant in between and no one rewrites your words. What you write is what they read, so write to them, not to a log - short, plain sentences when you are done, and nothing at all while you are simply working." +
    "\n- Your first reply of a conversation names it: call `set_title` before anything else, with three to six words saying what the work is, in the language the user writes in. It is how they find the conversation in their list. After that, change the title only when the user asks for a different one." +
    "\n- Never start another coding agent. You are the agent for this work; there is nothing to delegate to." +
    "\n- You have your own file and shell tools, plus Hook's own tools for the user's projects, memory and Workspace. Use them as you would any other tool." +
    "\n- The user may interrupt you with a new message while you work: treat it as guidance for the current work, not as a new, unrelated task." +
    "\n- The Stop button stops you immediately. Do not ask permission to stop or to continue."
  );
}

/** Search uses Hook's account service, which holds the provider key. */
function webSearchGuidance() {
  if (!process.env.HOOK_API_BASE || !process.env.HOOK_API_TOKEN) return "";
  return `

## Web search (Hook)
Use web_search when the task depends on current information: library releases, API changes, error messages, prices, documentation, or anything you cannot read in the project. Do not search for things you already know or can read locally.
- Results contain titles, URLs, snippets and summaries. Cite the URLs you actually use in your final report. If the results are empty or disagree, say so.
- Keep searches focused: a couple of queries is usually enough, and the user is paying for each one.
`;
}

export default function (pi) {
  pi.on("before_agent_start", async (event) => {
    // A new run (or a steer) starts with a clean slate: the counters describe
    // one stretch of work, not the whole process.
    callsSincePlan = 0;
    callsSinceNudge = 0;
    const guideline = `\n\nGuideline (Hook guard): EVERY \`bash\` tool call MUST include a \`timeout\` in seconds (between ${clampLabel(
      MIN_TIMEOUT,
    )} and ${clampLabel(
      MAX_TIMEOUT,
    )}). Calls without a \`timeout\`, or with a \`timeout\` larger than ${clampLabel(
      MAX_TIMEOUT,
    )}, are BLOCKED and will not execute. Pick the smallest timeout that comfortably covers the command (e.g. 15s for a quick curl, 60s for a build, 300s for a long test). Never issue a bash call without setting \`timeout\`.`;
    return {
      systemPrompt:
        (event.systemPrompt ?? "") +
        directGuidance() +
        guideline +
        webSearchGuidance() +
        (UPDATES_DIR ? planGuidance() + previewGuidance() : "") +
        syncGuidance() +
        memoryGuidance(),
    };
  });

  pi.on("tool_call", async (event) => {
    // A force-push on a shared project destroys the other computers' history.
    // It is never the right move; a pull and rebase is.
    if (event.toolName === "bash") {
      const command = String(event.input?.command ?? "");
      if (/\bgit\s+push\b/.test(command)) {
        const destructive =
          /(^|\s)(--force(-with-lease)?|-f)(\s|$)/.test(command) ||
          /--mirror(\s|$)/.test(command) ||
          /(^|\s)(--delete|-d)(\s|$)/.test(command) ||
          /\bgit\s+push\s+\S+\s+:/.test(command) ||
          /\bgit\s+push\b[^\n]*\s\+\S+/.test(command);
        if (destructive) {
          return {
            block: true,
            reason:
              "BLOCKED by Hook guard: this project is shared with the user's other computers, so force-pushing, deleting a branch or mirroring would destroy their work. Run `sync_pull` first (it rebases your changes), resolve any conflicts, then `sync_push`.",
          };
        }
      }
    }

    // The checklist first. A long run that never moves it leaves the user
    // watching a step that finished ten minutes ago, so one call is refused and
    // the model is sent back to `update_plan`. The counter resets either way:
    // a model that ignores the refusal still gets to retry instead of hanging.
    if (UPDATES_DIR && event.toolName !== "update_plan" && callsSincePlan >= PLAN_BLOCK_AFTER) {
      callsSincePlan = 0;
      callsSinceNudge = 0;
      const steps = readSeedPlan();
      return {
        block: true,
        reason:
          `BLOCKED by Hook guard: ${PLAN_BLOCK_AFTER} tool calls have gone by without updating the user's checklist, so it no longer matches what you are doing. ` +
          "Call `update_plan` now - mark the steps that are finished `done` and the step you are working on `active` - then re-issue this call.\n" +
          (steps.length ? "Current checklist:\n" + planLines(steps) : planReminder()),
      };
    }

    if (event.toolName !== "bash") return;

    const input = event.input ?? {};
    const t = input.timeout;
    const valid =
      typeof t === "number" &&
      Number.isFinite(t) &&
      t >= MIN_TIMEOUT &&
      t <= MAX_TIMEOUT;

    if (valid) return;

    const preview = String(input.command ?? "").slice(0, 160).replace(/\n/g, "\\n");

    if (!ENFORCE) {
      input.timeout = Math.min(
        MAX_TIMEOUT,
        typeof t === "number" && t > 0 ? t : MAX_TIMEOUT,
      );
      return;
    }

    let reason;
    if (t === undefined || t === null) {
      reason = `BLOCKED by Hook guard: the bash call is missing a \`timeout\`. Set \`timeout\` (seconds, ${clampLabel(
        MIN_TIMEOUT,
      )}–${clampLabel(
        MAX_TIMEOUT,
      )}) on every bash call and re-issue the same command. Command was: ${preview}`;
    } else if (typeof t === "number" && t > MAX_TIMEOUT) {
      reason = `BLOCKED by Hook guard: \`timeout\` ${clampLabel(
        t,
      )} exceeds the hard cap of ${clampLabel(MAX_TIMEOUT)}. Lower it and re-issue. Command was: ${preview}`;
    } else if (typeof t === "number" && t < MIN_TIMEOUT) {
      reason = `BLOCKED by Hook guard: \`timeout\` ${t}s is below the minimum ${clampLabel(
        MIN_TIMEOUT,
      )}. Use at least ${clampLabel(MIN_TIMEOUT)}s. Command was: ${preview}`;
    } else {
      reason = `BLOCKED by Hook guard: \`timeout\` must be a positive number of seconds (${clampLabel(
        MIN_TIMEOUT,
      )}–${clampLabel(MAX_TIMEOUT)}). Got: ${String(
        t,
      )}. Re-issue with a valid \`timeout\`. Command was: ${preview}`;
    }

    return { block: true, reason };
  });

  // ── The checklist the user watches ───────────────────────────────────────
  // Both kinds of run write it. A relayed agent and one the user drives
  // directly draw the same task board from the same mailbox, so a direct agent
  // that were not offered `update_plan` would sit under an empty card while its
  // prompt told it to fill one in.
  if (UPDATES_DIR) {
    // Keep the checklist in the freshest part of the context. The system prompt
    // is thousands of tokens behind by the time a step is finished; a line on
    // the tool result the model just read is not.
    pi.on("tool_result", async (event) => {
      if (event.toolName === "update_plan") {
        if (!event.isError) {
          callsSincePlan = 0;
          callsSinceNudge = 0;
        }
        return;
      }
      callsSincePlan += 1;
      callsSinceNudge += 1;
      if (callsSinceNudge < PLAN_NUDGE_AFTER) return;
      callsSinceNudge = 0;
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n[Hook checklist] ${planReminder()}` },
        ],
        details: event.details,
        structuredContent: event.structuredContent,
        isError: event.isError,
        usage: event.usage,
      };
    });
  }

  // ── Progress reporting ───────────────────────────────────────────────────
  // Only for an agent the chat agent relays. A direct conversation has the
  // agent's own words, so a separate note would be a mailbox nobody empties.
  if (UPDATES_DIR && !DIRECT) {
    pi.registerTool({
      name: "report_progress",
      label: "Report progress",
      description:
        "Tell the user something worth reading about the work, optionally with screenshots: a milestone with something to show, a decision, a problem, or the finished result. Not a heartbeat — if nothing changed that the user would care about, do not call this.",
      promptGuidelines: [
        "Only report when there is something worth interrupting the user for: a milestone you can show them, a decision that changes the outcome, a problem, or the finished result. A few updates across a long job is plenty; often one picture and one final summary is all it takes.",
        "Never report routine motion: 'still working', 'in progress', 'running tests', 'small delay', 'no news yet', 'making good progress'. If the user would not learn anything from reading it, stay silent and keep working.",
        "Long stretches of silence are expected and fine. Do not invent an update to fill them, and do not report the same milestone twice.",
        "When you do report, be concrete and short: what exists now that did not before, or what is blocked and why. No changelog, no list of tool calls.",
        "Attach pictures when they help the user see the work: capture them however the project allows — headless Edge/Chrome screenshots, a project test harness, an engine's own screenshot feature, a generated image — and pass their paths. Never fake a screenshot; skip the picture if you cannot render one.",
        "Keep pictures readable: capture the normal viewport (around 1280x800), not full-page, and attach at most two per update (a 1440x8000 page becomes an unreadable strip in the chat).",
        "Always send one last report when the work is finished or you are stopping, with the outcome and, if the work is visual, what it looks like now.",
      ],
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "One or two sentences for the user." },
          images: {
            type: "array",
            items: { type: "string" },
            description: "Paths to pictures to attach, up to four per update.",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
      async execute(_callId, params) {
        const note = String(params?.note ?? "").trim();
        if (!note) {
          return {
            content: [{ type: "text", text: "report_progress needs a `note`." }],
            isError: true,
            details: {},
          };
        }

        const filesDir = join(UPDATES_DIR, "files");
        mkdirSync(filesDir, { recursive: true });

        const files = [];
        const skipped = [];
        const requested = Array.isArray(params?.images) ? params.images.slice(0, MAX_PICTURES) : [];
        for (const picture of requested) {
          const staged = stagePicture(filesDir, picture, files);
          if (staged.error) skipped.push(staged.error);
        }

        const record = { note, images: files, at: Date.now() };
        const file = join(UPDATES_DIR, `u-${Date.now()}-${process.pid}.json`);
        writeFileSync(file, JSON.stringify(record));

        const parts = ["Progress recorded; it reaches the user with the next update."];
        if (files.length) parts.push(`${files.length} picture(s) attached.`);
        if (skipped.length) parts.push(`Skipped: ${skipped.join("; ")}`);

        return {
          content: [{ type: "text", text: parts.join(" ") }],
          details: { pictures: files.length, skipped },
        };
      },
    });
  }

  // ── What the run shows while it works ────────────────────────────────────
  // The preview panel and the checklist draw for a direct conversation exactly
  // as they do for a relayed run, so both write the same mailbox.
  if (UPDATES_DIR) {
    // ── The page the user watches on the right ────────────────────────────
    pi.registerTool({
      name: "show_preview",
      label: "Show preview",
      description:
        "Show one HTML page on this machine in Hook's right-side preview panel. The panel refreshes it whenever the page's folder changes. Optional: use it when the work has something worth looking at, and set it early - the file may not exist yet.",
      promptGuidelines: [
        "Use `show_preview` for visual work: a frontend page, a UI change, a data analysis with charts, a visual report. Skip it when there is nothing to look at.",
        "Point `file` at the page the user should see, never at a source file such as App.tsx. Keep that page current while you work.",
        "Set it as early as possible, not at the end. The page may not exist yet; the panel waits for it.",
        "Call it again only to switch pages. Do not re-show the same file.",
      ],
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "HTML page path, relative to the project or absolute, e.g. 'index.html', 'dist/preview.html' or 'C:/reports/summary.html'.",
          },
          title: {
            type: "string",
            description: "Short, plain-language title shown above the page, e.g. 'Pricing page'.",
          },
        },
        required: ["file", "title"],
        additionalProperties: false,
      },
      async execute(_callId, params) {
        const checked = normalizePreviewFile(params?.file);
        if (checked.error) {
          return {
            content: [{ type: "text", text: checked.error }],
            isError: true,
            details: {},
          };
        }
        const title =
          String(params?.title ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, PREVIEW_TITLE_MAX) || basename(checked.file);
        const record = { file: checked.file, title, at: Date.now() };
        mkdirSync(UPDATES_DIR, { recursive: true });
        writeFileSync(
          join(UPDATES_DIR, `v-${Date.now()}-${process.pid}.json`),
          JSON.stringify(record),
        );
        const state = existsSync(checked.absolute)
          ? "It is live now."
          : "It will load as soon as that file appears.";
        return {
          content: [
            {
              type: "text",
              text: `Preview set to ${basename(checked.file)}. ${state} It refreshes by itself as the page's folder changes; call show_preview again only to switch pages.`,
            },
          ],
          details: { file: checked.file, title },
        };
      },
    });

    // ── The checklist the user watches ────────────────────────────────────
    pi.registerTool({
      name: "update_plan",
      label: "Update plan",
      description:
        "Replace the checklist the user is watching under the chat. Call it the moment a step is finished - before you move on to the next piece of work - not at the end. Keep the existing plain-language wording; never add technical detail.",
      promptGuidelines: [
        "`update_plan` is the user's checklist: call it when you start or finish a step, and before you pick up the next piece of work.",
        "Mark the finished step `done` and the next one `active` in the same `update_plan` call. Never leave a finished step marked active, and never batch the whole plan to the end.",
        "When a step turns out to hide several separate jobs, split it into smaller plain-language steps rather than keeping one step active for many tool calls.",
        "Keep the step names short, friendly and non-technical - the user reads them directly. No file names, tool names, commands, package names or jargon.",
        DIRECT
          ? "Keep the plan you already set. Add a step only if the work genuinely needs it, and keep the total at eight or fewer."
          : "Keep the plan from the chat agent. Add a step only if the work genuinely needs it, and keep the total at eight or fewer.",
        "Before you finish, make sure every step you completed is marked `done`.",
      ],
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PLAN_STEPS,
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Short, everyday-language step exactly as the user should read it.",
                },
                status: {
                  type: "string",
                  enum: STEP_STATUSES,
                  description: "pending, active (the one you are on) or done.",
                },
              },
              required: ["title", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
      async execute(_callId, params) {
        const steps = cleanPlan(params?.steps);
        if (!steps.length) {
          return {
            content: [{ type: "text", text: "update_plan needs at least one step with a title." }],
            isError: true,
            details: {},
          };
        }
        mkdirSync(UPDATES_DIR, { recursive: true });
        const record = { steps, at: Date.now() };
        writeFileSync(join(UPDATES_DIR, `p-${Date.now()}-${process.pid}.json`), JSON.stringify(record));
        // Keep the seed current so a later turn (after a steer) starts from the
        // plan as it stands, not from the original brief.
        writeFileSync(PLAN_SEED_FILE, JSON.stringify(record));
        const done = steps.filter((step) => step.status === "done").length;
        return {
          content: [
            {
              type: "text",
              text: `Plan updated (${done}/${steps.length} done). The user sees the checklist in the chat.`,
            },
          ],
          details: { steps: steps.length, done },
        };
      },
    });
  }

  // ── Project sync tools ────────────────────────────────────────────────
  if (SYNC_ENABLED) {
    pi.registerTool({
      name: "sync_pull",
      label: "Pull latest work",
      description:
        "Fetch and apply the latest version of this project saved in the user's Hook account. Call it before doing anything else: this folder may be empty because the project was started on another computer. A new project with nothing saved yet reports that normally.",
      promptGuidelines: [
        "Call `sync_pull` as your first action in this project. It is how work from the user's other computers reaches this folder.",
        "If it reports conflicts, resolve the listed files and then call `sync_push`.",
        "Do not run `git pull` or `git push` yourself; use these tools so the account's credentials are applied correctly.",
      ],
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const fetched = runGit(["fetch", "hook", "--prune"], 120_000);
        if (!fetched.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Could not reach the user's account. Continue with the files already here and call sync_pull again later. Details: ${fetched.err.slice(0, 400)}`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        const pulled = runGit(["pull", "--rebase", "--autostash", "hook", "main"]);
        if (pulled.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Pulled the latest version from the user's account.\n${pulled.out.trim() || "Already up to date."}`,
              },
            ],
            details: {},
          };
        }
        if (/couldn't find remote ref|no such ref|not found/i.test(pulled.err)) {
          return {
            content: [
              {
                type: "text",
                text: "Nothing has been saved to the user's account for this project yet. This is normal for a new project; start working, then call sync_push when you finish.",
              },
            ],
            details: {},
          };
        }
        if (/CONFLICT|Automatic merge failed|needs merge|unmerged|Resolve all conflicts/i.test(pulled.err)) {
          return {
            content: [
              {
                type: "text",
                text: `Pulling produced conflicts. Resolve these files by editing them, then call sync_push:\n${pulled.err.slice(0, 1200)}`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Could not pull the latest version: ${pulled.err.slice(0, 800)}`,
            },
          ],
          isError: true,
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "sync_push",
      label: "Save work to the account",
      description:
        "Commit every change in this project and save it to the user's Hook account so another computer can continue. Call it when you finish, and also when you are blocked or stopping early.",
      promptGuidelines: [
        "Call `sync_push` once at the end of a run, with a short message about what changed. The user does not see the message, so keep it factual.",
        "Never force-push. If a push is rejected, pull (or run `sync_pull`), resolve conflicts, then call sync_push again.",
        "Do not leave finished work only on this computer: saving it is what makes it available everywhere.",
      ],
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "One short line describing what changed, e.g. 'Add invoice totals'.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async execute(_callId, params) {
        const message =
          String(params?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 200) ||
          "Update from Hook";
        const status = runGit(["status", "--porcelain"], 30_000);
        if (!status.ok) {
          return {
            content: [{ type: "text", text: `Could not inspect the project: ${status.err.slice(0, 400)}` }],
            isError: true,
            details: {},
          };
        }
        if (status.out.trim()) {
          const added = runGit(["add", "-A"], 120_000);
          if (!added.ok) {
            return {
              content: [{ type: "text", text: `Could not stage the changes: ${added.err.slice(0, 400)}` }],
              isError: true,
              details: {},
            };
          }
          const committed = runGit(["commit", "-m", message, "--no-verify"]);
          if (!committed.ok && !/nothing to commit|no changes added/i.test(committed.err)) {
            return {
              content: [{ type: "text", text: `Could not commit the changes: ${committed.err.slice(0, 800)}` }],
              isError: true,
              details: {},
            };
          }
        }
        let pushed = runGit(["push", "-u", "hook", "HEAD:main"]);
        if (!pushed.ok && /rejected|non-fast-forward|fetch first/i.test(pushed.err)) {
          const rebased = runGit(["pull", "--rebase", "--autostash", "hook", "main"]);
          if (!rebased.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Saving needs a conflict resolved first. Edit these files, then call sync_push again:\n${rebased.err.slice(0, 1200)}`,
                },
              ],
              isError: true,
              details: {},
            };
          }
          pushed = runGit(["push", "-u", "hook", "HEAD:main"]);
        }
        if (!pushed.ok) {
          if (/src refspec .* does not match any|nothing to push/i.test(pushed.err)) {
            return {
              content: [
                {
                  type: "text",
                  text: "There is nothing to save yet: the project has no commits. Make the first change and call sync_push again.",
                },
              ],
              details: {},
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Could not save to the user's account: ${pushed.err.slice(0, 1200)}`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        const head = runGit(["rev-parse", "--short", "HEAD"], 10_000);
        return {
          content: [
            {
              type: "text",
              text: `Saved this project to the user's account${head.ok && head.out.trim() ? ` at ${head.out.trim()}` : ""}. It is available on the user's other computers now.`,
            },
          ],
          details: {},
        };
      },
    });
  }

  // ── Web search ──────────────────────────────────────────────────────────
  if (process.env.HOOK_API_BASE && process.env.HOOK_API_TOKEN) {
    pi.registerTool({
      name: "web_search",
      label: "Web search",
      description:
        "Search the live web and return titles, URLs, snippets and summaries. Use it when the task depends on current information - releases, API changes, error messages, prices, docs - rather than things you can read in the project or already know. Cite the URLs you use.",
      promptGuidelines: [
        "Use web_search when current external information would change the answer: a new library release, an API change, an error message you do not recognise, pricing, or documentation you cannot read locally.",
        "Do not search for things you can find in the project, things the user already told you, or general reasoning you can do yourself.",
        "Results contain titles, URLs, snippets and summaries. Cite the URLs you actually use in your final report. If the results are empty or disagree, say so instead of guessing.",
        "Keep searches focused. A couple of queries is usually enough; the user pays for each search.",
      ],
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query, 1-128 characters. Supports site:, after:, before:, lang:, and quoted phrases.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "How many results to return. Default 6.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(_callId, params) {
        const query = String(params?.query ?? "").trim();
        if (!query) {
          return {
            content: [{ type: "text", text: "web_search needs a query." }],
            isError: true,
            details: {},
          };
        }
        const base = String(process.env.HOOK_API_BASE ?? "").replace(/[/]+$/, "");
        const token = String(process.env.HOOK_API_TOKEN ?? "");
        const count = Math.min(10, Math.max(1, Number(params?.count) || 6));
        try {
          const response = await fetch(`${base}/api/v1/search`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ query, count }),
            signal: AbortSignal.timeout(30_000),
          });
          const text = await response.text();
          if (!response.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Web search failed (${response.status}): ${text.slice(0, 300)}`,
                },
              ],
              isError: true,
              details: {},
            };
          }
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            return {
              content: [{ type: "text", text: "Web search returned an invalid response." }],
              isError: true,
              details: {},
            };
          }
          const results = Array.isArray(data?.results) ? data.results : [];
          if (!results.length) {
            return {
              content: [{ type: "text", text: `No web results for "${query}".` }],
              details: { count: 0 },
            };
          }
          const lines = [`Web search results for "${query}":`];
          results.slice(0, count).forEach((result, index) => {
            const summary = String(result.summary || result.snippet || "")
              .replace(/[ \t\r\n]+/g, " ")
              .slice(0, 700);
            const meta = [result.site_name, result.date].filter(Boolean).join(" · ");
            lines.push(`
${index + 1}. ${result.title || "(untitled)"}
${result.url || ""}
${summary}${meta ? `
(${meta})` : ""}`);
          });
          lines.push(`
Cite the URLs you use. Search results can be incomplete or disagree; say so when they do.`);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { count: results.length },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Web search failed: ${error.message}` }],
            isError: true,
            details: {},
          };
        }
      },
    });
  }

  registerBridgeTools(pi);
}

/**
 * Register the tools Hook itself owns, for a chat where the user drives the
 * agent directly: the chat agent's projects, memory and Workspace tools.
 *
 * The schemas come from Rust (the same `definitions()` the chat agent gets), so
 * the two surfaces cannot drift; only the descriptions travel with them. Names
 * the guard already provides are skipped: two tools with one name would shadow
 * each other.
 */
function registerBridgeTools(pi) {
  const bridge = bridgeHandle();
  if (!bridge) return;
  const taken = new Set([
    "web_search",
    "report_progress",
    "show_preview",
    "update_plan",
    "sync_pull",
    "sync_push",
  ]);
  for (const entry of bridge.tools) {
    const spec = entry?.function ?? entry;
    const name = String(spec?.name ?? "");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || taken.has(name)) continue;
    taken.add(name);
    const description = String(spec?.description ?? "");
    const label = description.split(/[.:]/)[0].slice(0, 40) || name.replace(/_/g, " ");
    pi.registerTool({
      name,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      description,
      parameters: spec?.parameters ?? { type: "object", properties: {} },
      async execute(_callId, params) {
        try {
          const response = await fetch(bridge.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hook-token": bridge.token,
            },
            body: JSON.stringify({ name, args: params ?? {} }),
            // Memory, projects and Workspace calls are local or a single
            // request to Hook's own service; a minute is generous.
            signal: AbortSignal.timeout(60_000),
          });
          const text = await response.text();
          if (!response.ok) {
            return {
              content: [{ type: "text", text: `${name} failed (${response.status}): ${text.slice(0, 400)}` }],
              isError: true,
              details: {},
            };
          }
          return {
            content: [{ type: "text", text: text || "Done." }],
            details: {},
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `${name} could not reach Hook: ${error?.message ?? error}`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      },
    });
  }
}
