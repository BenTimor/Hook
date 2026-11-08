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
 *
 * Tunables (environment, set by the Hook runtime from harness.config.toml):
 *   PI_BASH_MAX_TIMEOUT  hard cap in seconds (default 3600)
 *   PI_BASH_MIN_TIMEOUT  floor in seconds (default 1)
 *   PI_BASH_ENFORCE      "0" downgrades to warn-and-cap instead of blocking
 *
 * Plain ESM on purpose: no imports, no types, nothing that can fail to resolve.
 */

const MAX_TIMEOUT = Number(process.env.PI_BASH_MAX_TIMEOUT ?? 3600);
const MIN_TIMEOUT = Number(process.env.PI_BASH_MIN_TIMEOUT ?? 1);
const ENFORCE = (process.env.PI_BASH_ENFORCE ?? "1") !== "0";

function clampLabel(v) {
  if (v >= 3600) return `${Math.round(v / 3600)}h`;
  if (v >= 60) return `${Math.round(v / 60)}min`;
  return `${v}s`;
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
}
