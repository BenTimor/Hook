#!/usr/bin/env node
/**
 * The CLA gate.
 *
 * Hook is AGPL-3.0-only *and* commercially licensed. That only works if the
 * project holds relicensing rights over every contribution, so a patch without
 * a signed CLA cannot be merged — and it cannot be fixed after the fact either,
 * because the contributor keeps the copyright on their own code.
 *
 * This runs from `.github/workflows/cla.yml` on `pull_request_target` and on
 * `issue_comment`. It never executes contributor code: the workflow checks out
 * the *base* branch, and this script only talks to the GitHub API.
 *
 * Signatures live in `.github/cla-signatures.json` on the default branch, next
 * to the policy they cover, so a reviewer can see who is on the list.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_EVENT_PATH=... \
 *     node scripts/cla.mjs
 *
 * The phrase is deliberately long and awkward: a comment that could be typed by
 * accident is not a signature.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SIGNING_PHRASE =
  "I have read the CLA Document and I hereby sign the CLA";

export const SIGNATURES_PATH = ".github/cla-signatures.json";

/** Comments this script leaves carry this marker, so it never repeats itself. */
export const COMMENT_MARKER = "<!-- hook-cla-gate -->";

/** Accounts that never need to sign: the owner, and anything a bot drives. */
export function isExempt(login, owner, allowlist = []) {
  if (!login) return true;
  if (login === owner) return true;
  // Every GitHub App and Dependabot account ends in `[bot]`.
  if (login.endsWith("[bot]")) return true;
  if (allowlist.includes(login)) return true;
  return false;
}

/**
 * True when a comment body is the signing phrase and nothing else. Trailing
 * whitespace and a leading/trailing quote are tolerated because people paste
 * it; an appended "…but with a caveat" is not, because that is not agreement.
 */
export function isSigningComment(body) {
  if (typeof body !== "string") return false;
  const normalised = body
    .replace(/^\s*>+\s*/gm, "") // quoting the bot's instructions is fine
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim()
    .toLowerCase();
  return normalised === SIGNING_PHRASE.toLowerCase();
}

/** Parse a signatures file, tolerating a missing or older one. */
export function parseSignatures(raw) {
  if (!raw) return { version: 1, signed: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, signed: [] };
  }
  const signed = Array.isArray(parsed?.signed) ? parsed.signed : [];
  return {
    version: 1,
    signed: signed
      .filter((entry) => entry && typeof entry.login === "string")
      .map((entry) => ({
        login: entry.login,
        signedAt: typeof entry.signedAt === "string" ? entry.signedAt : "",
      })),
  };
}

export function hasSigned(signatures, login) {
  if (!login) return false;
  return signatures.signed.some(
    (entry) => entry.login.toLowerCase() === login.toLowerCase(),
  );
}

export function addSignature(signatures, login, signedAt) {
  if (hasSigned(signatures, login)) return signatures;
  return {
    version: 1,
    signed: [...signatures.signed, { login, signedAt }],
  };
}

/* ------------------------------------------------------------------ */
/* Everything below talks to GitHub and only runs inside the workflow. */
/* ------------------------------------------------------------------ */

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${body}`);
  }
  return response;
};

/** The pull request this event is about, or null when it is not one. */
function pullRequestOf(event) {
  if (event.pull_request) return event.pull_request;
  // A comment on a pull request arrives as an issue event.
  if (event.issue?.pull_request) {
    return { number: event.issue.number, user: event.issue.user };
  }
  return null;
}

async function readSignatures(ref) {
  const response = await api(
    `/repos/${repo}/contents/${SIGNATURES_PATH}?ref=${encodeURIComponent(ref)}`,
  );
  if (response.status === 404) {
    return { content: { version: 1, signed: [] }, sha: null };
  }
  const body = await response.json();
  const text = Buffer.from(body.content, "base64").toString("utf8");
  return { content: parseSignatures(text), sha: body.sha };
}

async function writeSignatures(content, sha, branch, login) {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const response = await api(`/repos/${repo}/contents/${SIGNATURES_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Record the CLA for @${login}`,
      content: Buffer.from(text, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `could not commit the CLA signature (${response.status}). If "${branch}" ` +
        "is protected, allow github-actions[bot] to push to it or move the " +
        `signatures to a dedicated branch — see ${SIGNATURES_PATH}.`,
    );
  }
}

/**
 * Logins that do not need the gate, from `.github/cla-allowlist.json`.
 * Missing or unreadable means "nobody" — the gate fails closed.
 */
async function readAllowlist() {
  const response = await api(
    `/repos/${repo}/contents/.github/cla-allowlist.json`,
  );
  if (response.status === 404) return [];
  try {
    const body = await response.json();
    const parsed = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
    return Array.isArray(parsed?.allow) ? parsed.allow.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function setStatus(sha, state, description) {
  await api(`/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    body: JSON.stringify({
      state,
      context: "CLA",
      description,
      target_url: `https://github.com/${repo}/blob/HEAD/CLA.md`,
    }),
  });
}

async function commentOnce(pullNumber, body) {
  const existing = await api(`/repos/${repo}/issues/${pullNumber}/comments?per_page=100`);
  const comments = existing.status === 404 ? [] : await existing.json();
  if (Array.isArray(comments) && comments.some((c) => c.body?.includes(COMMENT_MARKER))) {
    return;
  }
  await api(`/repos/${repo}/issues/${pullNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `${COMMENT_MARKER}\n${body}` }),
  });
}

function instructions(login) {
  return [
    `Thanks @${login}! Before this can be merged, please sign the CLA.`,
    "",
    "Hook is AGPL-3.0-only **and** commercially licensed, so the project needs",
    "relicensing rights over every contribution. You keep the copyright to your",
    "own work — the CLA is a broad license to the project, not an assignment.",
    "",
    "Read [CLA.md](../blob/HEAD/CLA.md), then reply to this pull request with:",
    "",
    `> ${SIGNING_PHRASE}`,
    "",
    "That single comment is your signature. You only need to do it once, and it",
    "covers your future contributions too. If you are contributing on behalf of",
    "an employer, a corporate CLA is required instead — see CLA.md.",
    "",
    "If you would rather not sign, that is fine: open an issue describing the",
    "change and a maintainer will write it.",
  ].join("\n");
}

async function main() {
  if (!token || !repo || !eventPath) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required");
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pull = pullRequestOf(event);
  if (!pull) {
    console.log("cla: not a pull request event, nothing to do");
    return;
  }

  const owner = repo.split("/")[0];
  const defaultBranch = event.repository?.default_branch ?? "main";
  const login = pull.user?.login;
  // The owner and bot accounts are handled by isExempt; this list is for a
  // person who has signed the corporate CLA and does not need the gate.
  const allowlist = await readAllowlist();

  let { content: signatures, sha } = await readSignatures(defaultBranch);

  // A signature comment may arrive on this very pull request.
  if (event.comment && isSigningComment(event.comment.body)) {
    if (isExempt(login, owner, allowlist)) {
      console.log(`cla: @${login} is exempt`);
      return;
    }
    if (!hasSigned(signatures, login)) {
      signatures = addSignature(signatures, login, event.comment.created_at);
      await writeSignatures(signatures, sha, defaultBranch, login);
      console.log(`cla: recorded the CLA for @${login}`);
    }
  }

  if (event.action === "closed") {
    console.log("cla: pull request closed, nothing to do");
    return;
  }

  const headSha = pull.head?.sha ?? event.issue?.pull_request?.head?.sha;
  if (!headSha) {
    console.log("cla: no head sha on this event, nothing to do");
    return;
  }

  if (isExempt(login, owner, allowlist) || hasSigned(signatures, login)) {
    await setStatus(headSha, "success", "CLA signed");
    console.log(`cla: @${login} is covered`);
    return;
  }

  await setStatus(headSha, "failure", "CLA not signed yet");
  await commentOnce(pull.number, instructions(login));
  console.log(`cla: @${login} has not signed — status set to failure`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`cla: ${error.message}`);
    process.exit(1);
  });
}
