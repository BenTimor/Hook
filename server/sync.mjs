/**
 * Conversation and project sync.
 *
 * Hook's data is one JSON document per conversation, rewritten wholesale. Git
 * is the wrong tool for merging those, so this module borrows the useful parts
 * of git instead — content hashes, a monotonic cursor and tombstones — and does
 * the merge itself, once, on the server:
 *
 *   GET  /api/sync/changes?since=<cursor>   everything this device has not seen
 *   POST /api/sync/chats                    push full chats, receive merged ones
 *   POST /api/sync/projects                 project identity + description
 *   PUT  /api/sync/media/<sha256>           content-addressed pictures
 *   GET  /api/sync/media/<sha256>
 *   GET  /api/sync/status                   quota and cursor for the Settings line
 *   DELETE /api/sync/account                delete everything stored for the account
 *
 * Merge rules:
 * - messages are unioned by id, ordered by creation time; a finished copy
 *   beats a stale in-flight one, and the newer chat wins an edit conflict
 * - title/pin follow the newer chat; preview/count are recomputed here
 * - a deletion is a tombstone that beats a stale push; an explicit restore
 *   revives it
 * - an unchanged push is a no-op, so devices never echo each other
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { Router, json, raw } from "express";
import { apiUser, deviceId } from "./tokens.mjs";
import { ensureRepo, forgetUser, gitRoot, userKey } from "./git.mjs";

const PAGE = 100;
const CHANGES_BYTE_BUDGET = 4 * 1024 * 1024;
const MAX_BATCH = 10;

/** Storage limits. Read from env so tests can exercise quotas without 250 MB. */
function limits(env = {}) {
  return {
    chatBytes: Number(env.SYNC_CHAT_MAX_BYTES) || 8 * 1024 * 1024,
    mediaBytes: Number(env.SYNC_MEDIA_MAX_BYTES) || 8 * 1024 * 1024,
    chatQuota: Number(env.SYNC_CHAT_QUOTA_BYTES) || 250 * 1024 * 1024,
    mediaQuota: Number(env.SYNC_MEDIA_QUOTA_BYTES) || 250 * 1024 * 1024,
    chats: Number(env.SYNC_MAX_CHATS) || 5000,
    projects: Number(env.SYNC_MAX_PROJECTS) || 200,
    // Generous against the desktop's own ceiling (400): the server should not be
    // the thing that surprises a user who has been saving preferences for a year.
    memory: Number(env.SYNC_MAX_MEMORY) || 1000,
  };
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{4,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEMORY_KINDS = new Set(["user", "feedback", "project", "reference"]);

const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function nowMs() {
  return Date.now();
}

export function syncRoot(env = {}) {
  return resolve(env.SYNC_ROOT || "waitlist-data/sync");
}

function mediaPath(env, subject, sha256) {
  return join(syncRoot(env), "media", userKey(subject), sha256);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authError(res, result) {
  res.status(result.status).json({
    error: {
      message: result.message,
      type: "invalid_request_error",
      code: result.code,
    },
  });
}

function badRequest(res, message) {
  res.status(400).json({ error: { message, type: "invalid_request_error" } });
}

function projectName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 64) return null;
  if (name === "." || name === ".." || name.startsWith(".")) return null;
  if (name.endsWith(".") || name.endsWith(" ")) return null;
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(name)) return null;
  if (RESERVED.has(name.toLowerCase())) return null;
  return name;
}

function nameKey(name) {
  return name.toLowerCase();
}

function bumpSeq(db, subject) {
  db.prepare(
    `INSERT INTO sync_state (google_subject, next_seq) VALUES (?, 1)
     ON CONFLICT(google_subject) DO UPDATE SET next_seq = next_seq + 1`,
  ).run(subject);
  return db
    .prepare("SELECT next_seq FROM sync_state WHERE google_subject = ?")
    .get(subject).next_seq;
}

function currentSeq(db, subject) {
  const row = db
    .prepare("SELECT next_seq FROM sync_state WHERE google_subject = ?")
    .get(subject);
  return row?.next_seq ?? 0;
}

function truncate(value, max) {
  const text = String(value).trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Same derived metadata the desktop keeps, so every device lists a chat alike. */
function refreshMeta(chat) {
  const visible = chat.messages.filter(
    (message) => !message.hidden && message.role !== "tool",
  );
  chat.meta.messageCount = visible.length;
  const last = [...visible]
    .reverse()
    .find((message) => String(message.content ?? "").trim());
  chat.meta.preview = last
    ? truncate(String(last.content).replace(/\n/g, " "), 160)
    : "";
}

function hashOf(chat) {
  // updatedAt is stamped by the server; it must not make an unchanged chat
  // look changed on the next push.
  return sha256(
    JSON.stringify({
      meta: { ...chat.meta, updatedAt: 0 },
      messages: chat.messages,
    }),
  );
}

function validMessage(message) {
  return (
    message &&
    typeof message === "object" &&
    typeof message.id === "string" &&
    SAFE_ID.test(message.id) &&
    typeof message.role === "string" &&
    typeof message.content === "string" &&
    typeof message.status === "string" &&
    Number.isFinite(message.createdAt)
  );
}

function normalizeChat(raw) {
  if (!raw || typeof raw !== "object") return null;
  const meta = raw.meta;
  if (!meta || typeof meta !== "object" || !SAFE_ID.test(meta.id ?? "")) return null;
  if (!Array.isArray(raw.messages) || raw.messages.length > 100_000) return null;
  if (!raw.messages.every(validMessage)) return null;
  return {
    meta: {
      ...meta,
      id: meta.id,
      title: typeof meta.title === "string" ? meta.title : "New chat",
      createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : nowMs(),
      updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : nowMs(),
      pinned: meta.pinned === true,
      pinnedAt: Number.isFinite(meta.pinnedAt) ? meta.pinnedAt : null,
      messageCount: 0,
      preview: "",
    },
    messages: raw.messages.map((message) => ({ ...message })),
  };
}

/**
 * Union of two versions of one conversation. `stored` is what the account has;
 * `incoming` is what a device just pushed.
 */
function mergeChat(stored, incoming) {
  if (!stored) {
    refreshMeta(incoming);
    return incoming;
  }
  const incomingNewer = (incoming.meta.updatedAt ?? 0) > (stored.meta.updatedAt ?? 0);
  const winner = incomingNewer ? incoming : stored;
  const loser = incomingNewer ? stored : incoming;

  const storedById = new Map(stored.messages.map((message) => [message.id, message]));
  const incomingById = new Map(incoming.messages.map((message) => [message.id, message]));
  const messages = new Map(storedById);
  for (const [id, message] of incomingById) messages.set(id, message);
  // Never let a half-streamed snapshot replace a finished message.
  for (const [id, message] of messages) {
    if (message.status === "streaming" || message.status === "aborted") {
      const other = incomingById.get(id) ?? storedById.get(id);
      if (other && other.status === "complete") messages.set(id, other);
    }
  }

  const ordered = [...messages.values()].sort((a, b) => {
    const delta = (a.createdAt ?? 0) - (b.createdAt ?? 0);
    if (delta) return delta;
    return String(a.id).localeCompare(String(b.id));
  });

  const merged = {
    ...winner,
    meta: {
      ...winner.meta,
      // The original creation time belongs to whoever started the chat.
      createdAt: Math.min(stored.meta.createdAt, incoming.meta.createdAt),
      // Title and pin follow the newer chat; both are explicit user actions.
      title: winner.meta.title,
      pinned: winner.meta.pinned,
      pinnedAt: winner.meta.pinnedAt,
      updatedAt: Math.max(
        stored.meta.updatedAt ?? 0,
        incoming.meta.updatedAt ?? 0,
      ),
      messageCount: 0,
      preview: "",
    },
    messages: ordered,
  };
  refreshMeta(merged);
  return merged;
}

function storedChat(db, subject, chatId) {
  const row = db
    .prepare("SELECT * FROM sync_chats WHERE google_subject = ? AND chat_id = ?")
    .get(subject, chatId);
  if (!row) return null;
  return {
    row,
    chat: row.deleted || !row.body
      ? null
      : JSON.parse(gunzipSync(row.body).toString("utf8")),
  };
}

function chatStorageBytes(db, subject) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(length(body)), 0) AS total FROM sync_chats WHERE google_subject = ?",
    )
    .get(subject).total;
}

function chatCount(db, subject) {
  return db
    .prepare(
      "SELECT COUNT(*) AS total FROM sync_chats WHERE google_subject = ? AND deleted = 0",
    )
    .get(subject).total;
}

function mediaStorageBytes(db, subject) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM sync_media WHERE google_subject = ?",
    )
    .get(subject).total;
}

function writeChat(db, subject, chatId, body, deleted, version) {
  const seq = bumpSeq(db, subject);
  if (deleted) {
    db.prepare(
      `INSERT INTO sync_chats
         (google_subject, chat_id, seq, updated_at, deleted, hash, body)
       VALUES (?, ?, ?, ?, 1, '', NULL)
       ON CONFLICT(google_subject, chat_id) DO UPDATE SET
         seq = excluded.seq, updated_at = excluded.updated_at,
         deleted = 1, hash = '', body = NULL`,
    ).run(subject, chatId, seq, version);
    return seq;
  }
  const compressed = gzipSync(Buffer.from(body, "utf8"));
  const hash = sha256(
    JSON.stringify({
      meta: { ...JSON.parse(body).meta, updatedAt: 0 },
      messages: JSON.parse(body).messages,
    }),
  );
  db.prepare(
    `INSERT INTO sync_chats
       (google_subject, chat_id, seq, updated_at, deleted, hash, body)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(google_subject, chat_id) DO UPDATE SET
       seq = excluded.seq, updated_at = excluded.updated_at,
       deleted = 0, hash = excluded.hash, body = excluded.body`,
  ).run(subject, chatId, seq, version, hash, compressed);
  return seq;
}

function storedProject(db, subject, projectId) {
  return db
    .prepare(
      "SELECT * FROM sync_projects WHERE google_subject = ? AND project_id = ?",
    )
    .get(subject, projectId);
}

function writeProject(db, subject, project, deleted) {
  const seq = bumpSeq(db, subject);
  const now = nowMs();
  if (deleted) {
    db.prepare(
      `INSERT INTO sync_projects
         (google_subject, project_id, seq, updated_at, deleted, name,
          name_key, description, created_at)
       VALUES (?, ?, ?, ?, 1, '', '', '', ?)
       ON CONFLICT(google_subject, project_id) DO UPDATE SET
         seq = excluded.seq, updated_at = excluded.updated_at, deleted = 1`,
    ).run(subject, project.id, seq, now, now);
    return seq;
  }
  db.prepare(
    `INSERT INTO sync_projects
       (google_subject, project_id, seq, updated_at, deleted, name, name_key,
        description, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(google_subject, project_id) DO UPDATE SET
       seq = excluded.seq, updated_at = excluded.updated_at, deleted = 0,
       name = excluded.name, name_key = excluded.name_key,
       description = excluded.description, created_at = excluded.created_at`,
  ).run(
    subject,
    project.id,
    seq,
    now,
    project.name,
    nameKey(project.name),
    project.description,
    project.createdAt,
  );
  return seq;
}

function reply(res, payload) {
  res.json(payload);
}

/** One memory entry, or null when the row is shaped in a way this build cannot
 * trust. The body travels inline: entries are a sentence, not a conversation. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !SAFE_ID.test(raw.id)) return null;
  const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 2000) : "";
  // A tombstone carries no text; everything else has to say something.
  if (!text && raw.deleted !== true) return null;
  return {
    id: raw.id,
    text,
    kind: MEMORY_KINDS.has(raw.kind) ? raw.kind : "user",
    pinned: raw.pinned === true,
    chatId: typeof raw.chatId === "string" && SAFE_ID.test(raw.chatId) ? raw.chatId : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : nowMs(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : nowMs(),
    deleted: raw.deleted === true,
  };
}

function writeMemory(db, subject, entry) {
  const seq = bumpSeq(db, subject);
  db.prepare(
    `INSERT INTO sync_memory
       (google_subject, entry_id, seq, updated_at, deleted, text, kind,
        pinned, chat_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(google_subject, entry_id) DO UPDATE SET
       seq = excluded.seq, updated_at = excluded.updated_at,
       deleted = excluded.deleted, text = excluded.text, kind = excluded.kind,
       pinned = excluded.pinned, chat_id = excluded.chat_id,
       created_at = excluded.created_at`,
  ).run(
    subject,
    entry.id,
    seq,
    entry.updatedAt,
    entry.deleted ? 1 : 0,
    entry.text,
    entry.kind,
    entry.pinned ? 1 : 0,
    entry.chatId,
    entry.createdAt,
  );
  return seq;
}

export function createSyncRouter({ env, db }) {
  const router = Router();
  const root = syncRoot(env);
  const caps = limits(env);

  router.get("/status", (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    res.json({
      cursor: currentSeq(db, subject),
      chats: chatCount(db, subject),
      projects: db
        .prepare(
          "SELECT COUNT(*) AS total FROM sync_projects WHERE google_subject = ? AND deleted = 0",
        )
        .get(subject).total,
      memory: db
        .prepare(
          "SELECT COUNT(*) AS total FROM sync_memory WHERE google_subject = ? AND deleted = 0",
        )
        .get(subject).total,
      chatBytes: chatStorageBytes(db, subject),
      mediaBytes: mediaStorageBytes(db, subject),
      limits: {
        chats: caps.chats,
        projects: caps.projects,
        chatBytes: caps.chatQuota,
        mediaBytes: caps.mediaQuota,
        mediaItemBytes: caps.mediaBytes,
      },
    });
  });

  router.get("/changes", (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    const since = Math.max(0, Number.parseInt(req.query.since, 10) || 0);
    const limit = Math.min(
      PAGE,
      Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE),
    );

    const rows = db
      .prepare(
        `SELECT kind, id, seq, updated_at, deleted, hash, body,
                name, description, created_at, payload
         FROM (
           SELECT 'chat' AS kind, chat_id AS id, seq, updated_at, deleted,
                  hash, body, NULL AS name, NULL AS description,
                  NULL AS created_at, NULL AS payload
           FROM sync_chats WHERE google_subject = ? AND seq > ?
           UNION ALL
           SELECT 'project' AS kind, project_id AS id, seq, updated_at, deleted,
                  NULL AS hash, NULL AS body, name, description, created_at,
                  NULL AS payload
           FROM sync_projects WHERE google_subject = ? AND seq > ?
           UNION ALL
           SELECT 'memory' AS kind, entry_id AS id, seq, updated_at, deleted,
                  NULL AS hash, NULL AS body, NULL AS name,
                  NULL AS description, created_at,
                  json_object(
                    'id', entry_id,
                    'text', text,
                    'kind', kind,
                    'pinned', json(CASE WHEN pinned = 1 THEN 'true' ELSE 'false' END),
                    'chatId', chat_id,
                    'createdAt', created_at,
                    'updatedAt', updated_at,
                    'deleted', json(CASE WHEN deleted = 1 THEN 'true' ELSE 'false' END)
                  ) AS payload
           FROM sync_memory WHERE google_subject = ? AND seq > ?
         )
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(subject, since, subject, since, subject, since, limit + 1);

    const hasMoreRows = rows.length > limit;
    const page = hasMoreRows ? rows.slice(0, limit) : rows;
    const changes = [];
    let bytes = 0;
    let hasMore = hasMoreRows;
    for (const row of page) {
      const change = row.kind === "chat"
        ? {
            kind: "chat",
            id: row.id,
            seq: row.seq,
            deleted: row.deleted === 1,
            updatedAt: row.updated_at,
            ...(row.deleted === 1 || !row.body
              ? {}
              : { chat: JSON.parse(gunzipSync(row.body).toString("utf8")) }),
          }
        : row.kind === "memory"
          ? {
              kind: "memory",
              id: row.id,
              seq: row.seq,
              deleted: row.deleted === 1,
              updatedAt: row.updated_at,
              entry: JSON.parse(row.payload),
            }
          : {
              kind: "project",
            id: row.id,
            seq: row.seq,
            deleted: row.deleted === 1,
            updatedAt: row.updated_at,
            name: row.name,
            description: row.description,
            createdAt: row.created_at,
          };
      const size = row.body ? row.body.length : 64;
      // A first sync can contain hundreds of conversations. Stop before the
      // response gets silly, report hasMore, and let the client keep pulling.
      if (changes.length && bytes + size > CHANGES_BYTE_BUDGET) {
        hasMore = true;
        break;
      }
      changes.push(change);
      bytes += size;
    }
    reply(res, {
      cursor: changes.length ? changes[changes.length - 1].seq : since,
      hasMore,
      changes,
    });
  });

  router.post("/chats", json({ limit: "24mb" }), (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    const incoming = req.body?.chats;
    if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > MAX_BATCH)
      return badRequest(res, `Send between 1 and ${MAX_BATCH} chats.`);

    db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const raw of incoming) {
        const deleted = raw?.deleted === true;
        const id = deleted ? raw?.id : raw?.meta?.id;
        if (typeof id !== "string" || !SAFE_ID.test(id)) {
          db.exec("ROLLBACK");
          return badRequest(res, "Invalid chat id.");
        }
        const stored = storedChat(db, subject, id);

        if (deleted) {
          const version = Number.isFinite(raw?.updatedAt) ? raw.updatedAt : nowMs();
          if (!stored) {
            writeChat(db, subject, id, "", true, version);
            results.push({ id, seq: currentSeq(db, subject), deleted: true });
          } else if (stored.row.deleted) {
            results.push({ id, seq: stored.row.seq, deleted: true });
          } else {
            writeChat(db, subject, id, "", true, version);
            results.push({ id, seq: currentSeq(db, subject), deleted: true });
          }
          continue;
        }

        const chat = normalizeChat(raw);
        if (!chat) {
          db.exec("ROLLBACK");
          return badRequest(res, "A chat is not shaped like a Hook conversation.");
        }
        const body = JSON.stringify(chat);
        if (Buffer.byteLength(body, "utf8") > caps.chatBytes) {
          db.exec("ROLLBACK");
          return res.status(413).json({
            error: {
              message: "This conversation is too large to sync.",
              type: "invalid_request_error",
              code: "chat_too_large",
            },
          });
        }

        // A deletion on another device wins over a stale copy of the chat. The
        // desktop sends `restored` when the user explicitly restored it.
        if (stored?.row.deleted && raw?.restored !== true) {
          results.push({ id, seq: stored.row.seq, deleted: true });
          continue;
        }

        const merged = mergeChat(stored?.chat ?? null, chat);
        const hash = hashOf(merged);
        if (stored && !stored.row.deleted && stored.row.hash === hash) {
          results.push({ id, seq: stored.row.seq, deleted: false, unchanged: true });
          continue;
        }
        if (!stored && chatCount(db, subject) >= caps.chats) {
          db.exec("ROLLBACK");
          return res.status(413).json({
            error: {
              message: "This account has reached its conversation limit.",
              type: "invalid_request_error",
              code: "chat_quota",
            },
          });
        }

        refreshMeta(merged);
        const storedBody = JSON.stringify(merged);
        const seq = writeChat(
          db,
          subject,
          id,
          storedBody,
          false,
          merged.meta.updatedAt,
        );
        if (chatStorageBytes(db, subject) > caps.chatQuota) {
          db.exec("ROLLBACK");
          return res.status(413).json({
            error: {
              message: "Conversation storage for this account is full.",
              type: "invalid_request_error",
              code: "chat_quota",
            },
          });
        }
        results.push({ id, seq, deleted: false, chat: merged });
      }
      db.exec("COMMIT");
      reply(res, {
        cursor: currentSeq(db, subject),
        device: deviceId(req),
        results,
      });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  });

  router.post("/projects", json({ limit: "256kb" }), async (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    const incoming = req.body?.projects;
    if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > MAX_BATCH)
      return badRequest(res, `Send between 1 and ${MAX_BATCH} projects.`);

    const created = [];
    const out = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const raw of incoming) {
        if (!raw || typeof raw.id !== "string" || !PROJECT_ID.test(raw.id)) {
          db.exec("ROLLBACK");
          return badRequest(res, "Invalid project id.");
        }
        const stored = storedProject(db, subject, raw.id);
        if (raw.deleted === true) {
          if (!stored || stored.deleted) {
            out.push({ id: raw.id, ok: true, deleted: true });
          } else {
            writeProject(db, subject, { id: raw.id }, true);
            out.push({ id: raw.id, ok: true, deleted: true });
          }
          continue;
        }
        const name = projectName(raw.name);
        if (!name) {
          db.exec("ROLLBACK");
          return badRequest(res, "Invalid project name.");
        }
        const description =
          typeof raw.description === "string"
            ? raw.description.trim().slice(0, 2000)
            : "";
        const key = nameKey(name);
        const conflict = db
          .prepare(
            `SELECT project_id FROM sync_projects
             WHERE google_subject = ? AND name_key = ? AND deleted = 0
               AND project_id <> ?`,
          )
          .get(subject, key, raw.id);
        if (conflict) {
          out.push({
            id: raw.id,
            ok: false,
            error: "duplicate_name",
            conflictId: conflict.project_id,
          });
          continue;
        }
        if (!stored) {
          if (
            db
              .prepare(
                "SELECT COUNT(*) AS total FROM sync_projects WHERE google_subject = ? AND deleted = 0",
              )
              .get(subject).total >= caps.projects
          ) {
            db.exec("ROLLBACK");
            return res.status(413).json({
              error: {
                message: "This account has reached its project limit.",
                type: "invalid_request_error",
                code: "project_quota",
              },
            });
          }
          created.push(raw.id);
        }
        const createdAt = Number.isFinite(raw.createdAt)
          ? raw.createdAt
          : stored?.created_at ?? nowMs();
        writeProject(db, subject, {
          id: raw.id,
          name,
          description,
          createdAt,
        }, false);
        out.push({
          id: raw.id,
          ok: true,
          deleted: false,
          name,
          description,
          createdAt,
          updatedAt: nowMs(),
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }

    // Provision the bare repository lazily but before the coding agent can try
    // to push. A failure here is not worth failing the metadata write over.
    for (const id of created) {
      try {
        await ensureRepo(env, subject, id);
      } catch (error) {
        console.error(`hook: could not provision git repo ${id}: ${error.message}`);
      }
    }
    reply(res, { cursor: currentSeq(db, subject), results: out });
  });

  /**
   * Memory entries, one row each. Last write wins on the device's clock, and a
   * tombstone is just an entry with nothing left in it, so the merge rule is
   * the same one chats use.
   */
  router.post("/memory", json({ limit: "256kb" }), (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    const incoming = req.body?.entries;
    if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > MAX_BATCH)
      return badRequest(res, `Send between 1 and ${MAX_BATCH} memories.`);

    db.exec("BEGIN IMMEDIATE");
    try {
      const out = [];
      for (const raw of incoming) {
        const entry = normalizeEntry(raw);
        if (!entry) {
          db.exec("ROLLBACK");
          return badRequest(res, "A memory is not shaped like a Hook memory.");
        }
        const stored = db
          .prepare(
            "SELECT * FROM sync_memory WHERE google_subject = ? AND entry_id = ?",
          )
          .get(subject, entry.id);
        const same =
          stored &&
          stored.updated_at === entry.updatedAt &&
          stored.deleted === (entry.deleted ? 1 : 0) &&
          stored.text === entry.text &&
          stored.pinned === (entry.pinned ? 1 : 0);
        // An older stamp never wins; an identical one is the same fact, so it is
        // accepted without a new revision and the devices stop echoing.
        if (stored && (stored.updated_at > entry.updatedAt || same)) {
          out.push({
            id: entry.id,
            ok: true,
            unchanged: true,
            updatedAt: stored.updated_at,
          });
          continue;
        }
        if (!stored) {
          const total = db
            .prepare(
              "SELECT COUNT(*) AS total FROM sync_memory WHERE google_subject = ? AND deleted = 0",
            )
            .get(subject).total;
          if (total >= caps.memory) {
            db.exec("ROLLBACK");
            return res.status(413).json({
              error: {
                message: "This account has reached its memory limit.",
                type: "invalid_request_error",
                code: "memory_quota",
              },
            });
          }
        }
        writeMemory(db, subject, entry);
        out.push({
          id: entry.id,
          ok: true,
          deleted: entry.deleted,
          updatedAt: entry.updatedAt,
        });
      }
      db.exec("COMMIT");
      reply(res, { cursor: currentSeq(db, subject), entries: out });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  });

  router.put(
    "/media/:sha256",
    raw({ type: "*/*", limit: `${Math.ceil(caps.mediaBytes / (1024 * 1024)) + 1}mb` }),
    (req, res) => {
      const result = apiUser(db, req);
      if (!result.row) return authError(res, result);
      const subject = result.row.google_subject;
      const digest = req.params.sha256;
      if (!SHA256.test(digest)) return badRequest(res, "Invalid media digest.");
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!body || body.length === 0) return badRequest(res, "Empty media.");
      if (body.length > caps.mediaBytes)
        return res.status(413).json({
          error: {
            message: `That picture is over the ${Math.round(caps.mediaBytes / (1024 * 1024))} MB limit.`,
            type: "invalid_request_error",
          },
        });
      if (sha256(body) !== digest)
        return badRequest(res, "The media digest does not match its bytes.");
      const mime = String(req.get("content-type") || "application/octet-stream");
      if (!/^image\/[a-z0-9.+-]+$/i.test(mime))
        return res.status(415).json({
          error: {
            message: "Only images can be synced.",
            type: "invalid_request_error",
          },
        });
      if (
        mediaStorageBytes(db, subject) + body.length > caps.mediaQuota &&
        !db
          .prepare(
            "SELECT 1 AS present FROM sync_media WHERE google_subject = ? AND sha256 = ?",
          )
          .get(subject, digest)
      )
        return res.status(413).json({
          error: {
            message: "Picture storage for this account is full.",
            type: "invalid_request_error",
            code: "media_quota",
          },
        });

      const file = mediaPath(env, subject, digest);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (!existsSync(file)) {
        const temp = `${file}.tmp-${process.pid}`;
        writeFileSync(temp, body, { mode: 0o600 });
        renameSync(temp, file);
      }
      db.prepare(
        `INSERT INTO sync_media (google_subject, sha256, size, mime)
         VALUES (?, ?, ?, ?) ON CONFLICT(google_subject, sha256) DO NOTHING`,
      ).run(subject, digest, body.length, mime);
      reply(res, { ok: true, sha256: digest, size: body.length });
    },
  );

  router.get("/media/:sha256", (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    const digest = req.params.sha256;
    if (!SHA256.test(digest)) return badRequest(res, "Invalid media digest.");
    const row = db
      .prepare(
        "SELECT * FROM sync_media WHERE google_subject = ? AND sha256 = ?",
      )
      .get(subject, digest);
    const file = mediaPath(env, subject, digest);
    if (!row || !existsSync(file)) {
      return res.status(404).json({ error: { message: "Media not found." } });
    }
    if (statSync(file).size !== row.size) {
      return res.status(409).json({ error: { message: "Media is incomplete." } });
    }
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.type(row.mime);
    res.sendFile(file);
  });

  router.delete("/account", (req, res) => {
    const result = apiUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM sync_chats WHERE google_subject = ?").run(subject);
      db.prepare("DELETE FROM sync_projects WHERE google_subject = ?").run(subject);
      db.prepare("DELETE FROM sync_memory WHERE google_subject = ?").run(subject);
      db.prepare("DELETE FROM sync_media WHERE google_subject = ?").run(subject);
      db.prepare("UPDATE sync_state SET next_seq = 0 WHERE google_subject = ?").run(subject);
      // Hook Workspace belongs to the same account. The projects this account
      // owns go with everything inside them; in projects owned by someone else
      // only the membership, the invitations it sent and its own invites go,
      // because other people's boards and documents must not move.
      const owned = "SELECT id FROM ws_projects WHERE owner_subject = ?";
      for (const table of ["comments", "tasks", "documents", "boards", "folders"]) {
        db.prepare(`DELETE FROM ws_${table} WHERE project_id IN (${owned})`).run(subject);
      }
      db.prepare(`DELETE FROM ws_invites WHERE project_id IN (${owned})`).run(subject);
      db.prepare(`DELETE FROM ws_members WHERE project_id IN (${owned})`).run(subject);
      db.prepare(`DELETE FROM ws_projects WHERE owner_subject = ?`).run(subject);
      db.prepare("DELETE FROM ws_members WHERE subject = ?").run(subject);
      db.prepare("DELETE FROM ws_invites WHERE invited_by = ? OR email IN (SELECT lower(email) FROM waitlist_signups WHERE google_subject = ?)").run(subject, subject);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    rmSync(join(root, "media", userKey(subject)), { recursive: true, force: true });
    rmSync(join(gitRoot(env), userKey(subject)), { recursive: true, force: true });
    forgetUser(env, subject);
    res.json({ ok: true });
  });

  return router;
}
