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
 *    Nothing here talks to a network or a model; it only writes files.
 *
 * Tunables (environment, set by the Hook runtime from harness.config.toml):
 *   PI_BASH_MAX_TIMEOUT  hard cap in seconds (default 3600)
 *   PI_BASH_MIN_TIMEOUT  floor in seconds (default 1)
 *   PI_BASH_ENFORCE      "0" downgrades to warn-and-cap instead of blocking
 *   HOOK_UPDATES_DIR     mailbox folder for progress notes (unset = disabled)
 *
 * Plain ESM on purpose: only Node built-ins, nothing that can fail to resolve.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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
    const guideline = `\n\nGuideline (Hook guard): EVERY \`bash\` tool call MUST include a \`timeout\` in seconds (between ${clampLabel(
      MIN_TIMEOUT,
    )} and ${clampLabel(
      MAX_TIMEOUT,
    )}). Calls without a \`timeout\`, or with a \`timeout\` larger than ${clampLabel(
      MAX_TIMEOUT,
    )}, are BLOCKED and will not execute. Pick the smallest timeout that comfortably covers the command (e.g. 15s for a quick curl, 60s for a build, 300s for a long test). Never issue a bash call without setting \`timeout\`.`;
    return { systemPrompt: (event.systemPrompt ?? "") + guideline };
  });

  pi.on("tool_call", async (event) => {
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
}
