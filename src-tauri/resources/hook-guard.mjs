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
 *
 * Tunables (environment, set by the Hook runtime from harness.config.toml):
 *   PI_BASH_MAX_TIMEOUT  hard cap in seconds (default 3600)
 *   PI_BASH_MIN_TIMEOUT  floor in seconds (default 1)
 *   PI_BASH_ENFORCE      "0" downgrades to warn-and-cap instead of blocking
 *   HOOK_UPDATES_DIR     mailbox folder for progress notes and the plan
 *                        (unset = disabled)
 *
 * Plain ESM on purpose: only Node built-ins, nothing that can fail to resolve.
 */

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


const UPDATES_DIR = process.env.HOOK_UPDATES_DIR ?? "";
const MAX_PICTURES = 4;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const PICTURE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

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
    return { systemPrompt: (event.systemPrompt ?? "") + guideline + (UPDATES_DIR ? planGuidance() : "") };
  });

  pi.on("tool_call", async (event) => {
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

  // ── Progress reporting ───────────────────────────────────────────────────
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
        "Keep the plan from the chat agent. Add a step only if the work genuinely needs it, and keep the total at eight or fewer.",
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
}
