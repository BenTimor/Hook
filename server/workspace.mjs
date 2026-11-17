import { randomBytes } from "node:crypto";

import { Router, json } from "express";

import { requireApiUser } from "./tokens.mjs";

/**
 * Hook Workspace: projects, folders, boards, tasks, comments, documents and the
 * people they are shared with.
 *
 * This is the account service's half of the product, and it is deliberately the
 * whole product: every action a Workspace window can take is an endpoint here
 * first. That is what lets Hook's chat agent create a project, file a task or
 * invite a teammate on a machine where Workspace is not installed.
 *
 * Shape of the data:
 *
 *   ws_projects   one row per project; `owner_subject` is duplicated as an
 *                 `owner` membership so every authorization query is one join
 *   ws_members    roles: owner > manager > editor > viewer
 *   ws_invites    addressed to an email, accepted/declined in the product
 *   ws_folders    pure organization inside a project
 *   ws_boards     a task container with typed columns; one status column
 *   ws_tasks      `status` is the column option, `fields` holds the rest
 *   ws_comments   `author_kind` says whether a person or their Hook agent wrote
 *   ws_documents  Markdown is the source of truth; `rev` catches stale writes
 *
 * Every row carries `seq` from one global counter. Clients pull
 * `/api/ws/changes?since=N` and get only rows in projects they belong to, so a
 * device converges on the same view as every other device without merging.
 */
export const ROLES = ["owner", "manager", "editor", "viewer"];
const RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 };

export const LIMITS = {
  projectsPerAccount: 200,
  membersPerProject: 100,
  foldersPerProject: 500,
  boardsPerProject: 200,
  tasksPerProject: 20_000,
  documentsPerProject: 5_000,
  documentBytes: 512 * 1024,
  commentBytes: 16 * 1024,
  page: 200,
};

const ACTIONS = {
  read: 1,
  write: 2,
  invite: 3,
  manageMembers: 3,
  deleteProject: 4,
  transfer: 4,
};

/** What a role may do. One table, used by every route and by the tests. */
export function can(role, action) {
  const need = ACTIONS[action];
  if (!need) return false;
  return (RANK[role] ?? 0) >= need;
}

/** Which roles a manager/owner may hand out. Managers cannot create peers. */
function grantable(actorRole, role) {
  if (!ROLES.includes(role) || role === "owner") return false;
  if (actorRole === "owner") return role === "manager" || role === "editor" || role === "viewer";
  if (actorRole === "manager") return role === "editor" || role === "viewer";
  return false;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ws_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_projects (
      id TEXT PRIMARY KEY,
      owner_subject TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_members (
      project_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','manager','editor','viewer')),
      joined_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL,
      PRIMARY KEY (project_id, subject)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_invites (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('manager','editor','viewer')),
      invited_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','revoked')),
      created_at INTEGER NOT NULL,
      responded_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_folders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_boards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      folder_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      columns TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      assignee TEXT,
      fields TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      author TEXT NOT NULL,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
      via_chat_id TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ws_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      folder_id TEXT,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL DEFAULT '',
      rev INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      seq INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS ws_members_subject ON ws_members (subject);
    CREATE INDEX IF NOT EXISTS ws_invites_email ON ws_invites (email, status);
    CREATE INDEX IF NOT EXISTS ws_tasks_board ON ws_tasks (board_id, position);
    CREATE INDEX IF NOT EXISTS ws_comments_task ON ws_comments (task_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ws_invites_pending
      ON ws_invites (project_id, email) WHERE status = 'pending';
  `);
  db.prepare("INSERT OR IGNORE INTO ws_seq (id, next) VALUES (1, 0)").run();
}

export const SCHEMA = "workspace-v1";

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** One global counter: clients keep one cursor, not one per entity kind. */
function nextSeq(db) {
  db.prepare("UPDATE ws_seq SET next = next + 1 WHERE id = 1").run();
  return db.prepare("SELECT next FROM ws_seq WHERE id = 1").get().next;
}

function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not hide the original error.
    }
    throw error;
  }
}

function badRequest(res, message, code = "invalid_request") {
  return res.status(400).json({
    error: { message, type: "invalid_request_error", code },
  });
}

function forbidden(res, message = "You do not have permission to do that.") {
  return res.status(403).json({
    error: { message, type: "permission_error", code: "forbidden" },
  });
}

function notFound(res, message = "That item no longer exists.") {
  return res.status(404).json({
    error: { message, type: "invalid_request_error", code: "not_found" },
  });
}

function text(value, max) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length <= max ? trimmed : null;
}

function emailKey(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return null;
  return email;
}

function projectName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 80) return null;
  return name;
}

const COLUMN_TYPES = ["status", "text", "number", "date", "select", "person"];

/** Columns are a board's schema; tasks store values keyed by column id. */
function parseColumns(raw) {
  if (!Array.isArray(raw) || raw.length > 12) return null;
  const columns = [];
  let statuses = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const name = text(entry.name, 40);
    const type = COLUMN_TYPES.includes(entry.type) ? entry.type : null;
    if (!name || !type) return null;
    if (type === "status") statuses += 1;
    const column = {
      id: typeof entry.id === "string" && /^col_[A-Za-z0-9_-]{1,24}$/.test(entry.id)
        ? entry.id
        : newId("col"),
      name,
      type,
    };
    if (type === "status" || type === "select") {
      const options = Array.isArray(entry.options)
        ? entry.options
            .slice(0, 40)
            .map((option) => ({
              id:
                typeof option?.id === "string" && /^opt_[A-Za-z0-9_-]{1,24}$/.test(option.id)
                  ? option.id
                  : newId("opt"),
              label: text(option?.label, 40) ?? "Untitled",
            }))
        : [];
      if (options.length === 0) {
        options.push({ id: newId("opt"), label: "To do" }, { id: newId("opt"), label: "Done" });
      }
      column.options = options;
    }
    columns.push(column);
  }
  if (statuses > 1) return null;
  return columns;
}

export function createWorkspaceRouter({ db, env = {} }) {
  migrate(db);
  const router = Router();
  // Documents are up to 512 KB of Markdown; everything else is much smaller.
  router.use(json({ limit: "1mb" }));
  const limit = { ...LIMITS, ...(env.WORKSPACE_LIMITS ?? {}) };

  const member = (projectId, subject) =>
    db
      .prepare(
        "SELECT role FROM ws_members WHERE project_id = ? AND subject = ? AND deleted_at IS NULL",
      )
      .get(projectId, subject) ?? null;

  const project = (projectId) =>
    db
      .prepare("SELECT * FROM ws_projects WHERE id = ? AND deleted_at IS NULL")
      .get(projectId) ?? null;

  /** Resolve the signed-in account and their role in a project. */
  function actor(req, res, projectId, action) {
    const result = requireApiUser(db, req, res);
    if (!result) return null;
    const subject = result.google_subject;
    const row = member(projectId, subject);
    if (!row) {
      forbidden(res, "You are not a member of this project.");
      return null;
    }
    if (action && !can(row.role, action)) {
      forbidden(res);
      return null;
    }
    return { subject, role: row.role, row };
  }

  function projectIdOf(req, res, table, id) {
    const row = db
      .prepare(`SELECT project_id, deleted_at FROM ${table} WHERE id = ?`)
      .get(id);
    if (!row || row.deleted_at) {
      notFound(res);
      return null;
    }
    return row.project_id;
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  router.get("/projects", (req, res) => {
    const result = requireApiUser(db, req, res);
    if (!result) return;
    const subject = result.google_subject;
    const projects = db
      .prepare(
        `SELECT p.*, m.role
         FROM ws_projects p
         JOIN ws_members m ON m.project_id = p.id AND m.subject = ? AND m.deleted_at IS NULL
         WHERE p.deleted_at IS NULL
         ORDER BY p.updated_at DESC`,
      )
      .all(subject)
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        // The account subject of the owner, plus whether that is the caller:
        // clients show "you" without knowing their own subject.
        owner: row.owner_subject,
        mine: row.owner_subject === subject,
        role: row.role,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        seq: row.seq,
      }));
    res.json({ projects });
  });

  router.post("/projects", (req, res) => {
    const result = requireApiUser(db, req, res);
    if (!result) return;
    const subject = result.google_subject;
    const name = projectName(req.body?.name);
    if (!name) return badRequest(res, "Give the project a name (80 characters at most).");
    const description = text(req.body?.description ?? "", 2000);
    if (description === null) return badRequest(res, "That description is too long.");

    const owned = db
      .prepare(
        "SELECT COUNT(*) AS total FROM ws_projects WHERE owner_subject = ? AND deleted_at IS NULL",
      )
      .get(subject).total;
    if (owned >= limit.projectsPerAccount) {
      return badRequest(res, "You have reached the project limit.", "project_quota");
    }

    const at = now();
    const id = newId("wp");
    const seq = transaction(db, () => {
      const seq = nextSeq(db);
      db.prepare(
        `INSERT INTO ws_projects (id, owner_subject, name, description, created_at, updated_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, subject, name, description, at, at, seq);
      const memberSeq = nextSeq(db);
      db.prepare(
        `INSERT INTO ws_members (project_id, subject, role, joined_at, seq)
         VALUES (?, ?, 'owner', ?, ?)`,
      ).run(id, subject, at, memberSeq);
      return seq;
    });
    res.status(201).json({
      project: { id, name, description, owner: true, role: "owner", createdAt: at, updatedAt: at, seq },
    });
  });

  router.patch("/projects/:id", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "write");
    if (!who) return;
    const current = project(id);
    if (!current) return notFound(res);
    const name = req.body?.name === undefined ? current.name : projectName(req.body.name);
    if (!name) return badRequest(res, "Give the project a name (80 characters at most).");
    const description =
      req.body?.description === undefined
        ? current.description
        : text(req.body.description, 2000);
    if (description === null) return badRequest(res, "That description is too long.");

    const at = now();
    const seq = nextSeq(db);
    db.prepare(
      "UPDATE ws_projects SET name = ?, description = ?, updated_at = ?, seq = ? WHERE id = ?",
    ).run(name, description, at, seq, id);
    res.json({ project: { ...shapeProject({ ...current, name, description, updated_at: at, seq }), role: who.role } });
  });

  router.delete("/projects/:id", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "deleteProject");
    if (!who) return;
    const at = now();
    const seq = nextSeq(db);
    db.prepare("UPDATE ws_projects SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ?").run(
      at,
      at,
      seq,
      id,
    );
    res.json({ ok: true });
  });

  /** Ownership moves to an accepted manager, and the old owner becomes one. */
  router.post("/projects/:id/owner", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "transfer");
    if (!who) return;
    const target = typeof req.body?.subject === "string" ? req.body.subject : "";
    if (!target || target === who.subject) {
      return badRequest(res, "Choose another member to own the project.");
    }
    const targetRow = member(id, target);
    if (!targetRow || targetRow.role !== "manager") {
      return badRequest(
        res,
        "Ownership can only go to someone who accepted the invitation and is a manager.",
        "not_a_manager",
      );
    }
    const at = now();
    transaction(db, () => {
      const transferSeq = nextSeq(db);
      db.prepare("UPDATE ws_projects SET owner_subject = ?, updated_at = ?, seq = ? WHERE id = ?").run(
        target,
        at,
        transferSeq,
        id,
      );
      const oldSeq = nextSeq(db);
      db.prepare("UPDATE ws_members SET role = 'manager', seq = ? WHERE project_id = ? AND subject = ?").run(
        oldSeq,
        id,
        who.subject,
      );
      const newSeq = nextSeq(db);
      db.prepare("UPDATE ws_members SET role = 'owner', seq = ? WHERE project_id = ? AND subject = ?").run(
        newSeq,
        id,
        target,
      );
    });
    res.json({ ok: true, owner: target });
  });

  // ── Members and invites ───────────────────────────────────────────────────

  router.get("/projects/:id/members", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "read");
    if (!who) return;
    res.json({ members: listMembers(db, id) });
  });

  router.patch("/projects/:id/members/:subject", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "manageMembers");
    if (!who) return;
    const target = req.params.subject;
    const role = req.body?.role;
    const targetRow = member(id, target);
    if (!targetRow) return notFound(res, "That person is not a member of this project.");
    if (targetRow.role === "owner") return badRequest(res, "Transfer ownership instead of changing the owner's role.");
    if (!grantable(who.role, role)) return forbidden(res, "You cannot grant that role.");
    if (targetRow.role === "manager" && who.role !== "owner") {
      return forbidden(res, "Only the owner can change a manager's role.");
    }
    const seq = nextSeq(db);
    db.prepare("UPDATE ws_members SET role = ?, seq = ? WHERE project_id = ? AND subject = ?").run(
      role,
      seq,
      id,
      target,
    );
    res.json({ member: { subject: target, role } });
  });

  router.delete("/projects/:id/members/:subject", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "manageMembers");
    if (!who) return;
    const target = req.params.subject;
    const targetRow = member(id, target);
    if (!targetRow) return notFound(res, "That person is not a member of this project.");
    if (targetRow.role === "owner") {
      return badRequest(res, "The owner cannot be removed. Transfer ownership first.");
    }
    if (targetRow.role === "manager" && who.role !== "owner") {
      return forbidden(res, "Only the owner can remove a manager.");
    }
    // A tombstone, not a DELETE: the changes feed has to tell every device.
    const seq = nextSeq(db);
    db.prepare(
      "UPDATE ws_members SET deleted_at = ?, seq = ? WHERE project_id = ? AND subject = ?",
    ).run(now(), seq, id, target);
    res.json({ ok: true });
  });

  router.get("/projects/:id/invites", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "manageMembers");
    if (!who) return;
    const invites = db
      .prepare(
        `SELECT * FROM ws_invites
         WHERE project_id = ? AND status = 'pending'
         ORDER BY created_at DESC`,
      )
      .all(id)
      .map(shapeInvite);
    res.json({ invites });
  });

  router.post("/projects/:id/invites", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "invite");
    if (!who) return;
    const email = emailKey(req.body?.email);
    if (!email) return badRequest(res, "Enter a valid email address.");
    const role = req.body?.role ?? "editor";
    if (!grantable(who.role, role)) {
      return forbidden(
        res,
        who.role === "manager"
          ? "Managers can invite viewers and editors. Ask the owner for another manager."
          : "You cannot invite with that role.",
      );
    }
    const total = db
      .prepare("SELECT COUNT(*) AS total FROM ws_members WHERE project_id = ?")
      .get(id).total;
    if (total >= limit.membersPerProject) {
      return badRequest(res, "This project has reached its member limit.", "member_quota");
    }
    const existing = db
      .prepare(
        "SELECT * FROM ws_invites WHERE project_id = ? AND email = ? AND status = 'pending'",
      )
      .get(id, email);
    if (existing) {
      // Re-inviting someone pending is a role change, not a duplicate.
      if (!grantable(who.role, role)) return forbidden(res);
      const seq = nextSeq(db);
      db.prepare("UPDATE ws_invites SET role = ?, invited_by = ?, seq = ? WHERE id = ?").run(
        role,
        who.subject,
        seq,
        existing.id,
      );
      return res.json({ invite: shapeInvite({ ...existing, role, seq }) });
    }
    const invite = {
      id: newId("iv"),
      project_id: id,
      email,
      role,
      invited_by: who.subject,
      status: "pending",
      created_at: now(),
      responded_at: null,
    };
    invite.seq = nextSeq(db);
    db.prepare(
      `INSERT INTO ws_invites
         (id, project_id, email, role, invited_by, status, created_at, responded_at, seq)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?)`,
    ).run(invite.id, id, email, role, who.subject, invite.created_at, invite.seq);
    res.status(201).json({ invite: shapeInvite(invite) });
  });

  router.delete("/invites/:id", (req, res) => {
    const invite = db.prepare("SELECT * FROM ws_invites WHERE id = ?").get(req.params.id);
    if (!invite) return notFound(res);
    const who = actor(req, res, invite.project_id, "invite");
    if (!who) return;
    if (invite.status !== "pending") return badRequest(res, "That invitation is already answered.");
    const seq = nextSeq(db);
    db.prepare("UPDATE ws_invites SET status = 'revoked', responded_at = ?, seq = ? WHERE id = ?").run(
      now(),
      seq,
      invite.id,
    );
    res.json({ ok: true });
  });

  /** Invitations waiting for me: the inbox Workspace shows, and the agent can read. */
  router.get("/invites", (req, res) => {
    const result = requireApiUser(db, req, res);
    if (!result) return;
    const email = emailKey(result.email);
    const invites = email
      ? db
          .prepare(
            `SELECT i.*, p.name AS project_name, p.owner_subject
             FROM ws_invites i
             JOIN ws_projects p ON p.id = i.project_id AND p.deleted_at IS NULL
             WHERE i.email = ? AND i.status = 'pending'
             ORDER BY i.created_at DESC`,
          )
          .all(email)
          .map((row) => ({ ...shapeInvite(row), projectName: row.project_name }))
      : [];
    res.json({ invites });
  });

  router.post("/invites/:id/accept", (req, res) => acceptInvite(req, res, "accepted"));
  router.post("/invites/:id/decline", (req, res) => acceptInvite(req, res, "declined"));

  function acceptInvite(req, res, status) {
    const result = requireApiUser(db, req, res);
    if (!result) return;
    const subject = result.google_subject;
    const invite = db.prepare("SELECT * FROM ws_invites WHERE id = ?").get(req.params.id);
    if (!invite) return notFound(res);
    const mine = emailKey(result.email);
    if (!mine || invite.email !== mine) {
      return forbidden(res, "That invitation is for a different email address.");
    }
    if (invite.status !== "pending") return badRequest(res, "That invitation is already answered.");

    const at = now();
    transaction(db, () => {
      const inviteSeq = nextSeq(db);
      db.prepare("UPDATE ws_invites SET status = ?, responded_at = ?, seq = ? WHERE id = ?").run(
        status,
        at,
        inviteSeq,
        invite.id,
      );
      if (status === "accepted") {
        const seq = nextSeq(db);
        db.prepare(
          `INSERT INTO ws_members (project_id, subject, role, joined_at, seq)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, subject)
           DO UPDATE SET role = excluded.role, deleted_at = NULL, seq = excluded.seq`,
        ).run(invite.project_id, subject, invite.role, at, seq);
      }
    });
    res.json({ ok: true, status });
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  router.get("/projects/:id/folders", (req, res) => {
    const id = req.params.id;
    if (!actor(req, res, id, "read")) return;
    res.json({ folders: list(db, "folders", id) });
  });

  router.post("/projects/:id/folders", (req, res) => {
    const id = req.params.id;
    if (!actor(req, res, id, "write")) return;
    const name = text(req.body?.name, 80);
    if (!name) return badRequest(res, "Give the folder a name (80 characters at most).");
    const parent = req.body?.parentId ?? null;
    if (parent && !db.prepare("SELECT id FROM ws_folders WHERE id = ? AND project_id = ? AND deleted_at IS NULL").get(parent, id)) {
      return badRequest(res, "That parent folder does not exist.");
    }
    const row = insert(db, "folders", {
      project_id: id,
      parent_id: parent,
      name,
      position: Number.isSafeInteger(req.body?.position) ? req.body.position : 0,
    });
    res.status(201).json({ folder: shapeFolder(row) });
  });

  router.patch("/folders/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_folders", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "write")) return;
    const fields = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name, 80);
      if (!name) return badRequest(res, "Give the folder a name (80 characters at most).");
      fields.name = name;
    }
    if (req.body?.parentId !== undefined) {
      if (req.body.parentId && req.body.parentId === req.params.id) {
        return badRequest(res, "A folder cannot contain itself.");
      }
      fields.parent_id = req.body.parentId ?? null;
    }
    if (Number.isSafeInteger(req.body?.position)) fields.position = req.body.position;
    res.json({ folder: shapeFolder(update(db, "folders", req.params.id, fields)) });
  });

  router.delete("/folders/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_folders", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "write")) return;
    remove(db, "folders", req.params.id);
    res.json({ ok: true });
  });

  // ── Boards ────────────────────────────────────────────────────────────────

  router.get("/projects/:id/boards", (req, res) => {
    const id = req.params.id;
    if (!actor(req, res, id, "read")) return;
    res.json({ boards: list(db, "boards", id).map(shapeBoard) });
  });

  router.get("/boards/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_boards", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "read")) return;
    const row = db.prepare("SELECT * FROM ws_boards WHERE id = ?").get(req.params.id);
    res.json({ board: shapeBoard(row) });
  });

  router.post("/projects/:id/boards", (req, res) => {
    const id = req.params.id;
    if (!actor(req, res, id, "write")) return;
    const name = text(req.body?.name, 80);
    if (!name) return badRequest(res, "Give the board a name (80 characters at most).");
    const description = text(req.body?.description ?? "", 2000);
    if (description === null) return badRequest(res, "That description is too long.");
    const columns = parseColumns(
      req.body?.columns ?? [
        {
          name: "Status",
          type: "status",
          options: [
            { label: "To do" },
            { label: "In progress" },
            { label: "Done" },
          ],
        },
        { name: "Assignee", type: "person" },
      ],
    );
    if (!columns) return badRequest(res, "Those columns are not valid.");
    const row = insert(db, "boards", {
      project_id: id,
      folder_id: req.body?.folderId ?? null,
      name,
      description,
      columns: JSON.stringify(columns),
      position: Number.isSafeInteger(req.body?.position) ? req.body.position : 0,
    });
    res.status(201).json({ board: shapeBoard(row) });
  });

  router.patch("/boards/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_boards", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "write")) return;
    const fields = {};
    if (req.body?.name !== undefined) {
      const name = text(req.body.name, 80);
      if (!name) return badRequest(res, "Give the board a name (80 characters at most).");
      fields.name = name;
    }
    if (req.body?.description !== undefined) {
      const description = text(req.body.description, 2000);
      if (description === null) return badRequest(res, "That description is too long.");
      fields.description = description;
    }
    if (req.body?.columns !== undefined) {
      const columns = parseColumns(req.body.columns);
      if (!columns) return badRequest(res, "Those columns are not valid.");
      fields.columns = JSON.stringify(columns);
    }
    for (const [key, column] of [
      ["folderId", "folder_id"],
      ["position", "position"],
    ]) {
      if (req.body?.[key] !== undefined) fields[column] = req.body[key];
    }
    res.json({ board: shapeBoard(update(db, "boards", req.params.id, fields)) });
  });

  router.delete("/boards/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_boards", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "write")) return;
    remove(db, "boards", req.params.id);
    res.json({ ok: true });
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────

  router.get("/boards/:id/tasks", (req, res) => {
    const boardId = req.params.id;
    const projectId = projectIdOf(req, res, "ws_boards", boardId);
    if (!projectId) return;
    if (!actor(req, res, projectId, "read")) return;
    const tasks = db
      .prepare(
        "SELECT * FROM ws_tasks WHERE board_id = ? AND deleted_at IS NULL ORDER BY position, created_at",
      )
      .all(boardId)
      .map(shapeTask);
    res.json({ tasks });
  });

  router.post("/boards/:id/tasks", (req, res) => {
    const boardId = req.params.id;
    const projectId = projectIdOf(req, res, "ws_boards", boardId);
    if (!projectId) return;
    const who = actor(req, res, projectId, "write");
    if (!who) return;
    const title = text(req.body?.title, 200);
    if (!title) return badRequest(res, "Give the task a title (200 characters at most).");
    const description = text(req.body?.description ?? "", limit.documentBytes);
    if (description === null) return badRequest(res, "That description is too long.");
    const board = db.prepare("SELECT columns FROM ws_boards WHERE id = ?").get(boardId);
    const columns = JSON.parse(board.columns);
    const status = normaliseStatus(columns, req.body?.status, null);
    if (status === undefined) return badRequest(res, "That status is not on this board's columns.");
    const assignee = req.body?.assignee === null || req.body?.assignee === undefined
      ? null
      : String(req.body.assignee);
    const fields = normaliseFields(columns, req.body?.fields);
    if (fields === undefined) return badRequest(res, "One of those field values is not valid.");

    const at = now();
    const row = insert(db, "tasks", {
      project_id: projectId,
      board_id: boardId,
      title,
      description,
      status: status ?? defaultStatus(columns),
      assignee,
      fields: JSON.stringify(fields),
      position: Number.isSafeInteger(req.body?.position) ? req.body.position : 0,
      created_by: who.subject,
      created_at: at,
    });
    res.status(201).json({ task: shapeTask(row) });
  });

  router.get("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM ws_tasks WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!task) return notFound(res);
    if (!actor(req, res, task.project_id, "read")) return;
    const comments = db
      .prepare(
        "SELECT * FROM ws_comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at",
      )
      .all(task.id)
      .map(shapeComment);
    res.json({ task: shapeTask(task), comments });
  });

  router.patch("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM ws_tasks WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!task) return notFound(res);
    if (!actor(req, res, task.project_id, "write")) return;
    const board = db.prepare("SELECT columns FROM ws_boards WHERE id = ?").get(task.board_id);
    const columns = JSON.parse(board.columns);
    const fields = {};
    if (req.body?.title !== undefined) {
      const title = text(req.body.title, 200);
      if (!title) return badRequest(res, "Give the task a title (200 characters at most).");
      fields.title = title;
    }
    if (req.body?.description !== undefined) {
      const description = text(req.body.description, limit.documentBytes);
      if (description === null) return badRequest(res, "That description is too long.");
      fields.description = description;
    }
    if (req.body?.status !== undefined) {
      const status = normaliseStatus(columns, req.body.status, task.status);
      if (status === undefined) return badRequest(res, "That status is not on this board's columns.");
      fields.status = status;
    }
    if (req.body?.assignee !== undefined) {
      fields.assignee = req.body.assignee === null ? null : String(req.body.assignee);
    }
    if (req.body?.fields !== undefined) {
      const merged = { ...JSON.parse(task.fields), ...(req.body.fields ?? {}) };
      const next = normaliseFields(columns, merged);
      if (next === undefined) return badRequest(res, "One of those field values is not valid.");
      fields.fields = JSON.stringify(next);
    }
    if (Number.isSafeInteger(req.body?.position)) fields.position = req.body.position;
    if (req.body?.boardId !== undefined && req.body.boardId !== task.board_id) {
      const target = db
        .prepare("SELECT project_id FROM ws_boards WHERE id = ? AND deleted_at IS NULL")
        .get(req.body.boardId);
      if (!target || target.project_id !== task.project_id) {
        return badRequest(res, "That board is not in this project.");
      }
      fields.board_id = req.body.boardId;
    }
    res.json({ task: shapeTask(update(db, "tasks", task.id, fields)) });
  });

  router.delete("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM ws_tasks WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!task) return notFound(res);
    if (!actor(req, res, task.project_id, "write")) return;
    remove(db, "tasks", task.id);
    res.json({ ok: true });
  });

  // ── Comments ──────────────────────────────────────────────────────────────

  router.get("/tasks/:id/comments", (req, res) => {
    const task = db.prepare("SELECT * FROM ws_tasks WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!task) return notFound(res);
    if (!actor(req, res, task.project_id, "read")) return;
    const comments = db
      .prepare("SELECT * FROM ws_comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at")
      .all(task.id)
      .map(shapeComment);
    res.json({ comments });
  });

  router.post("/tasks/:id/comments", (req, res) => {
    const task = db.prepare("SELECT * FROM ws_tasks WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!task) return notFound(res);
    const who = actor(req, res, task.project_id, "write");
    if (!who) return;
    const body = text(req.body?.body, limit.commentBytes);
    if (!body) return badRequest(res, "Write something first.");
    // The chat agent comments as the user, marked so readers know how it was
    // written and which conversation to open.
    const kind = req.body?.authorKind === "agent" ? "agent" : "user";
    const viaChat = kind === "agent" ? text(req.body?.viaChatId, 64) : null;
    const at = now();
    const row = insert(db, "comments", {
      project_id: task.project_id,
      task_id: task.id,
      author: who.subject,
      author_kind: kind,
      via_chat_id: viaChat,
      body,
      created_at: at,
    });
    res.status(201).json({ comment: shapeComment(row) });
  });

  router.delete("/comments/:id", (req, res) => {
    const comment = db
      .prepare("SELECT * FROM ws_comments WHERE id = ? AND deleted_at IS NULL")
      .get(req.params.id);
    if (!comment) return notFound(res);
    const who = actor(req, res, comment.project_id, "write");
    if (!who) return;
    if (comment.author !== who.subject && !can(who.role, "manageMembers")) {
      return forbidden(res, "Only the author, a manager or the owner can delete a comment.");
    }
    remove(db, "comments", comment.id);
    res.json({ ok: true });
  });

  // ── Documents ─────────────────────────────────────────────────────────────

  router.get("/projects/:id/documents", (req, res) => {
    const id = req.params.id;
    if (!actor(req, res, id, "read")) return;
    res.json({ documents: list(db, "documents", id) });
  });

  router.get("/documents/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_documents", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "read")) return;
    const row = db.prepare("SELECT * FROM ws_documents WHERE id = ?").get(req.params.id);
    res.json({ document: shapeDocument(row) });
  });

  router.post("/projects/:id/documents", (req, res) => {
    const id = req.params.id;
    const who = actor(req, res, id, "write");
    if (!who) return;
    const title = text(req.body?.title, 200) ?? "Untitled";
    const markdown = text(req.body?.markdown ?? "", limit.documentBytes);
    if (markdown === null) return badRequest(res, "That document is too large.", "document_too_large");
    const at = now();
    const row = insert(db, "documents", {
      project_id: id,
      folder_id: req.body?.folderId ?? null,
      title,
      markdown,
      rev: 1,
      updated_by: who.subject,
      created_at: at,
    });
    res.status(201).json({ document: shapeDocument(row) });
  });

  router.patch("/documents/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_documents", req.params.id);
    if (!projectId) return;
    const who = actor(req, res, projectId, "write");
    if (!who) return;
    const current = db.prepare("SELECT * FROM ws_documents WHERE id = ?").get(req.params.id);
    const fields = {};
    if (req.body?.title !== undefined) {
      const title = text(req.body.title, 200);
      if (!title) return badRequest(res, "Give the document a title.");
      fields.title = title;
    }
    if (req.body?.folderId !== undefined) fields.folder_id = req.body.folderId ?? null;
    if (req.body?.markdown !== undefined) {
      const markdown = text(req.body.markdown, limit.documentBytes);
      if (markdown === null) return badRequest(res, "That document is too large.", "document_too_large");
      // Markdown is the source of truth, so the only merge question is "did you
      // edit the version you read?". A stale write is refused and the current
      // copy is returned for the editor to keep or replace.
      const baseRev = Number.isSafeInteger(req.body?.baseRev) ? req.body.baseRev : null;
      if (baseRev !== null && baseRev !== current.rev) {
        return res.status(409).json({
          error: {
            message: "Someone else edited this document. Your copy was kept.",
            type: "conflict_error",
            code: "stale_revision",
          },
          document: shapeDocument(current),
        });
      }
      if (baseRev === null) fields.conflict = true;
      fields.markdown = markdown;
      fields.rev = current.rev + 1;
      fields.updated_by = who.subject;
    }
    const row = update(db, "documents", current.id, fields);
    res.json({ document: shapeDocument(row) });
  });

  router.delete("/documents/:id", (req, res) => {
    const projectId = projectIdOf(req, res, "ws_documents", req.params.id);
    if (!projectId) return;
    if (!actor(req, res, projectId, "write")) return;
    remove(db, "documents", req.params.id);
    res.json({ ok: true });
  });

  // ── Changes feed ──────────────────────────────────────────────────────────

  /**
   * Everything that changed in the projects I belong to, after `since`.
   *
   * One cursor for the whole account, like the chat sync: the server filters by
   * membership at query time, so a cursor may skip rows that were never mine,
   * and that is fine — gaps are not meaningful.
   */
  router.get("/changes", (req, res) => {
    const result = requireApiUser(db, req, res);
    if (!result) return;
    const subject = result.google_subject;
    const email = emailKey(result.email);
    const since = Math.max(0, Number.parseInt(req.query.since, 10) || 0);
    const page = Math.min(
      limit.page,
      Math.max(1, Number.parseInt(req.query.limit, 10) || limit.page),
    );
    const mine = "SELECT project_id FROM ws_members WHERE subject = ? AND deleted_at IS NULL";

    // Per table rather than one UNION: each row keeps its own shape, and the
    // cursor is a plain max(seq). Membership filtering happens here, at read
    // time, so a device never sees a row for a project it left.
    const rows = [
      ...db
        .prepare(`SELECT * FROM ws_projects WHERE seq > ? AND id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "project", ...row })),
      ...db
        .prepare(`SELECT * FROM ws_folders WHERE seq > ? AND project_id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "folder", ...row })),
      ...db
        .prepare(`SELECT * FROM ws_boards WHERE seq > ? AND project_id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "board", ...row })),
      ...db
        .prepare(`SELECT * FROM ws_tasks WHERE seq > ? AND project_id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "task", ...row })),
      ...db
        .prepare(`SELECT * FROM ws_comments WHERE seq > ? AND project_id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "comment", ...row })),
      ...db
        .prepare(`SELECT * FROM ws_documents WHERE seq > ? AND project_id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "document", ...row })),
      ...db
        .prepare(`SELECT * FROM ws_members WHERE seq > ? AND project_id IN (${mine})`)
        .all(since, subject)
        .map((row) => ({ kind: "member", id: `${row.project_id}:${row.subject}`, ...row })),
      ...(email
        ? db
            .prepare(
              "SELECT * FROM ws_invites WHERE seq > ? AND email = ? AND status = 'pending'",
            )
            .all(since, email)
            .map((row) => ({ kind: "invite", ...row }))
        : []),
    ].sort((left, right) => left.seq - right.seq);

    // A page is bounded by rows and by bytes: a document can be half a megabyte,
    // and a device that asked for changes should not receive 200 of them.
    const budget = 4 * 1024 * 1024;
    const changes = [];
    let bytes = 0;
    let hasMore = false;
    for (const row of rows) {
      if (changes.length >= page) {
        hasMore = true;
        break;
      }
      const cost = 512 + (typeof row.markdown === "string" ? row.markdown.length : 0);
      if (changes.length > 0 && bytes + cost > budget) {
        hasMore = true;
        break;
      }
      bytes += cost;
      changes.push(shapeChange(row));
    }

    res.json({
      cursor: changes.length ? changes[changes.length - 1].seq : since,
      hasMore,
      changes,
    });
  });

  return { router, schema: SCHEMA };
}

// ── Row helpers ───────────────────────────────────────────────────────────────

function list(db, kind, projectId) {
  const order = kind === "documents" ? "updated_at DESC" : "position, updated_at";
  const rows = db
    .prepare(`SELECT * FROM ws_${kind} WHERE project_id = ? AND deleted_at IS NULL ORDER BY ${order}`)
    .all(projectId);
  if (kind === "folders") return rows.map(shapeFolder);
  return kind === "documents" ? rows.map(shapeDocumentMeta) : rows;
}

const PREFIX = {
  folders: "fd",
  boards: "bd",
  tasks: "tk",
  comments: "cm",
  documents: "dc",
};

function insert(db, kind, values) {
  const columns = {
    id: values.id ?? newId(PREFIX[kind] ?? "ws"),
    ...values,
    updated_at: values.updated_at ?? now(),
  };
  columns.seq = nextSeq(db);
  const keys = [...Object.keys(columns), "seq"];
  db.prepare(
    `INSERT INTO ws_${kind} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
  ).run(...keys.map((key) => columns[key]));
  return db.prepare(`SELECT * FROM ws_${kind} WHERE id = ?`).get(columns.id) ?? null;
}

function update(db, kind, id, fields) {
  const keys = Object.keys(fields).filter((key) => key !== "conflict");
  const seq = nextSeq(db);
  const assignments = [...keys.map((key) => `${key} = ?`), "updated_at = ?", "seq = ?"];
  const values = [...keys.map((key) => fields[key]), now(), seq, id];
  db.prepare(`UPDATE ws_${kind} SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return db.prepare(`SELECT * FROM ws_${kind} WHERE id = ?`).get(id);
}

function remove(db, kind, id) {
  const at = now();
  const seq = nextSeq(db);
  db.prepare(
    `UPDATE ws_${kind} SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ?`,
  ).run(at, at, seq, id);
}

function listMembers(db, projectId) {
  return db
    .prepare(
      `SELECT m.subject, m.role, m.joined_at AS joinedAt, s.email, s.name
       FROM ws_members m
       LEFT JOIN waitlist_signups s ON s.google_subject = m.subject
       WHERE m.project_id = ? AND m.deleted_at IS NULL
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
                m.joined_at`,
    )
    .all(projectId);
}

/** Folders are the one table whose rows are not shaped by hand anywhere else. */
function shapeFolder(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    name: row.name,
    position: row.position,
    updatedAt: row.updated_at,
    seq: row.seq,
  };
}

function shapeProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: row.owner_subject,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seq: row.seq,
  };
}

function shapeBoard(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    folderId: row.folder_id,
    name: row.name,
    description: row.description,
    columns: JSON.parse(row.columns),
    position: row.position,
    updatedAt: row.updated_at,
    seq: row.seq,
  };
}

function shapeTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    fields: JSON.parse(row.fields),
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seq: row.seq,
  };
}

function shapeComment(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    author: row.author,
    authorKind: row.author_kind,
    viaChatId: row.via_chat_id,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seq: row.seq,
  };
}

/** A listing keeps the revision, not the body. */
function shapeDocumentMeta(row) {
  const document = shapeDocument(row);
  return {
    ...document,
    markdown: undefined,
    bytes: typeof row.markdown === "string" ? row.markdown.length : 0,
  };
}

function shapeDocument(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    folderId: row.folder_id,
    title: row.title,
    markdown: row.markdown,
    rev: row.rev,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seq: row.seq,
  };
}

function shapeInvite(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    seq: row.seq,
  };
}

/** The changes feed carries tombstones, so clients can delete their copy. */
function shapeChange(row) {
  const change = {
    kind: row.kind,
    id: row.id,
    seq: row.seq,
    deleted: row.deleted_at != null,
    updatedAt: row.updated_at,
  };
  if (row.project_id) change.projectId = row.project_id;
  switch (row.kind) {
    case "project":
      Object.assign(change, shapeProject(row));
      break;
    case "folder":
      Object.assign(change, {
        parentId: row.parent_id,
        name: row.name,
        position: row.position,
      });
      break;
    case "board":
      Object.assign(change, {
        folderId: row.folder_id,
        name: row.name,
        columns: row.columns ? JSON.parse(row.columns) : [],
        position: row.position,
      });
      break;
    case "task":
      Object.assign(change, {
        boardId: row.board_id,
        title: row.title,
        description: row.description,
        status: row.status,
        assignee: row.assignee,
        fields: row.fields ? JSON.parse(row.fields) : {},
        position: row.position,
        createdBy: row.created_by,
      });
      break;
    case "comment":
      Object.assign(change, {
        taskId: row.task_id,
        body: row.body,
        author: row.author,
        authorKind: row.author_kind,
        viaChatId: row.via_chat_id,
      });
      break;
    case "document":
      Object.assign(change, {
        folderId: row.folder_id,
        title: row.title,
        markdown: row.markdown,
        rev: row.rev,
        updatedBy: row.updated_by,
      });
      break;
    case "member":
      Object.assign(change, { subject: row.subject, role: row.role });
      break;
    case "invite":
      Object.assign(change, {
        email: row.email,
        role: row.role,
        status: row.status,
      });
      break;
    default:
      break;
  }
  return change;
}

// ── Board columns ─────────────────────────────────────────────────────────────

function defaultStatus(columns) {
  const status = columns.find((column) => column.type === "status");
  return status?.options?.[0]?.id ?? "";
}

/** `undefined` = invalid, `null` = the column is gone (keep the old value). */
function normaliseStatus(columns, value, current) {
  if (value === undefined || value === null) return current;
  const status = columns.find((column) => column.type === "status");
  if (!status) return "";
  if (typeof value !== "string" || !status.options.some((option) => option.id === value)) {
    return undefined;
  }
  return value;
}

export function validateFields(columns, raw) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const allowed = new Map(
    columns.filter((column) => column.type !== "status").map((column) => [column.id, column]),
  );
  const values = {};
  for (const [key, value] of Object.entries(raw)) {
    const column = allowed.get(key);
    if (!column) return undefined;
    if (value === null || value === "") {
      values[key] = null;
      continue;
    }
    switch (column.type) {
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
        values[key] = value;
        break;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
        values[key] = value;
        break;
      case "person":
        values[key] = String(value).slice(0, 64);
        break;
      case "select":
        if (typeof value !== "string" || !column.options.some((option) => option.id === value)) {
          return undefined;
        }
        values[key] = value;
        break;
      case "text":
      default:
        if (typeof value !== "string" || value.length > 2000) return undefined;
        values[key] = value;
        break;
    }
  }
  return values;
}

const normaliseFields = (columns, raw) => validateFields(columns, raw ?? {});
