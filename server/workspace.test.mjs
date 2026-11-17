import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";

import { createPlatform } from "./platform.mjs";
import { hashToken } from "./tokens.mjs";
import { can } from "./workspace.mjs";

const OWNER = "hk_ws_test_owner_0123456789abcdefgh";
const EDITOR = "hk_ws_test_editor_0123456789abcdefg";
const OUTSIDER = "hk_ws_test_outside_0123456789abcdef";

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "hook-ws-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = createPlatform({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: "hook-ws.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: "s".repeat(48),
    GIT_ROOT: join(directory, "git"),
    SYNC_ROOT: join(directory, "sync"),
  });
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  for (const [subject, email] of [
    ["ws-owner", "owner@example.test"],
    ["ws-editor", "editor@example.test"],
    ["ws-outsider", "outsider@example.test"],
  ]) {
    db.prepare(
      `INSERT INTO waitlist_signups
         (google_subject, email, waitlist_status, approved_at)
       VALUES (?, ?, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(subject, email);
  }
  for (const [token, subject] of [
    [OWNER, "ws-owner"],
    [EDITOR, "ws-editor"],
    [OUTSIDER, "ws-outsider"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, 'test', 'app', 'device-test')`,
    ).run(hashToken(token), subject);
  }
  db.close();

  async function request(path, { method = "GET", token = OWNER, body } = {}) {
    // `/api/...` is an absolute route (account deletion lives outside /ws).
    const url = path.startsWith("/api/") ? `${origin}${path}` : `${origin}/api/ws${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  t.after(async () => {
    await new Promise((done) => server.close(done));
    api.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return { request, directory };
}

/** Owner creates a project and adds an editor by email; the editor accepts. */
async function sharedProject(request) {
  const created = await request("/projects", {
    method: "POST",
    body: { name: "Website redesign", description: "Q3" },
  });
  assert.equal(created.status, 201);
  const project = created.body.project;

  const invited = await request(`/projects/${project.id}/invites`, {
    method: "POST",
    body: { email: "editor@example.test", role: "editor" },
  });
  assert.equal(invited.status, 201);

  const inbox = await request("/invites", { token: EDITOR });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.invites.length, 1);
  assert.equal(inbox.body.invites[0].projectName, "Website redesign");

  const accepted = await request(`/invites/${inbox.body.invites[0].id}/accept`, {
    method: "POST",
    token: EDITOR,
  });
  assert.equal(accepted.status, 200);
  return project;
}

test("the role table is the one the routes use", () => {
  assert.equal(can("viewer", "read"), true);
  assert.equal(can("viewer", "write"), false);
  assert.equal(can("editor", "write"), true);
  assert.equal(can("editor", "invite"), false);
  assert.equal(can("manager", "invite"), true);
  assert.equal(can("manager", "transfer"), false);
  assert.equal(can("owner", "transfer"), true);
});

test("a project is created with its owner and listed by role", async (t) => {
  const { request } = await setup(t);
  const created = await request("/projects", {
    method: "POST",
    body: { name: "Website redesign" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.role, "owner");

  const list = await request("/projects");
  assert.equal(list.body.projects.length, 1);
  assert.equal(list.body.projects[0].name, "Website redesign");
  assert.equal(list.body.projects[0].mine, true);
  assert.equal(list.body.projects[0].owner, "ws-owner");

  // Someone else's account sees nothing.
  const other = await request("/projects", { token: OUTSIDER });
  assert.equal(other.body.projects.length, 0);
});

test("an invitation is accepted in the product and grants exactly its role", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);

  const members = await request(`/projects/${project.id}/members`);
  assert.deepEqual(
    members.body.members.map((member) => [member.email, member.role]),
    [
      ["owner@example.test", "owner"],
      ["editor@example.test", "editor"],
    ],
  );

  // An editor writes but cannot invite or manage people.
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    token: EDITOR,
    body: { name: "Sprint 1" },
  });
  assert.equal(board.status, 201);

  const invite = await request(`/projects/${project.id}/invites`, {
    method: "POST",
    token: EDITOR,
    body: { email: "friend@example.test", role: "viewer" },
  });
  assert.equal(invite.status, 403);
});

test("a viewer reads but never writes", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  await request(`/projects/${project.id}/invites`, {
    method: "POST",
    body: { email: "outsider@example.test", role: "viewer" },
  });
  const inbox = await request("/invites", { token: OUTSIDER });
  await request(`/invites/${inbox.body.invites[0].id}/accept`, {
    method: "POST",
    token: OUTSIDER,
  });

  const boards = await request(`/projects/${project.id}/boards`, { token: OUTSIDER });
  assert.equal(boards.status, 200);

  const denied = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    token: OUTSIDER,
    body: { name: "Nope" },
  });
  assert.equal(denied.status, 403);
});

test("a manager invites people but cannot mint another manager", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);

  await request(`/projects/${project.id}/members/ws-editor`, {
    method: "PATCH",
    body: { role: "manager" },
  });

  const asManager = await request(`/projects/${project.id}/invites`, {
    method: "POST",
    token: EDITOR,
    body: { email: "friend@example.test", role: "editor" },
  });
  assert.equal(asManager.status, 201);

  const tooHigh = await request(`/projects/${project.id}/invites`, {
    method: "POST",
    token: EDITOR,
    body: { email: "another@example.test", role: "manager" },
  });
  assert.equal(tooHigh.status, 403);

  // And a manager cannot demote a peer.
  const peer = await request(`/projects/${project.id}/members/ws-owner`, {
    method: "PATCH",
    token: EDITOR,
    body: { role: "viewer" },
  });
  assert.equal(peer.status, 400);
});

test("ownership moves only to an accepted manager, permanently", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);

  const tooEarly = await request(`/projects/${project.id}/owner`, {
    method: "POST",
    body: { subject: "ws-editor" },
  });
  assert.equal(tooEarly.status, 400);
  assert.equal(tooEarly.body.error.code, "not_a_manager");

  await request(`/projects/${project.id}/members/ws-editor`, {
    method: "PATCH",
    body: { role: "manager" },
  });
  const moved = await request(`/projects/${project.id}/owner`, {
    method: "POST",
    body: { subject: "ws-editor" },
  });
  assert.equal(moved.status, 200);

  const members = await request(`/projects/${project.id}/members`, { token: EDITOR });
  const roles = Object.fromEntries(members.body.members.map((m) => [m.subject, m.role]));
  assert.equal(roles["ws-editor"], "owner");
  assert.equal(roles["ws-owner"], "manager");

  // The old owner can no longer delete it; the new owner can.
  const denied = await request(`/projects/${project.id}`, { method: "DELETE" });
  assert.equal(denied.status, 403);
  const deleted = await request(`/projects/${project.id}`, {
    method: "DELETE",
    token: EDITOR,
  });
  assert.equal(deleted.status, 200);
  const list = await request("/projects", { token: EDITOR });
  assert.equal(list.body.projects.length, 0);
});

test("removing someone ends their access and reaches every device", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);

  const before = await request("/changes?since=0");
  assert.ok(before.body.changes.some((change) => change.kind === "member"));

  const removed = await request(`/projects/${project.id}/members/ws-editor`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);

  const denied = await request(`/projects/${project.id}/boards`, { token: EDITOR });
  assert.equal(denied.status, 403);

  // Everyone who still belongs to the project is told the member left; the
  // person removed simply stops receiving anything for that project.
  const after = await request(`/changes?since=${before.body.cursor}`);
  const member = after.body.changes.find(
    (change) => change.kind === "member" && change.subject === "ws-editor",
  );
  assert.ok(member, "the removal is a tombstone in the feed");
  assert.equal(member.deleted, true);
});

test("tasks keep their board's typed columns, and comments record who really wrote them", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const columns = board.body.board.columns;
  const status = columns.find((column) => column.type === "status");
  assert.equal(status.options.length, 3);

  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: {
      title: "Write the brief",
      description: "One page",
      status: status.options[1].id,
      assignee: "ws-editor",
    },
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.task.status, status.options[1].id);

  const badStatus = await request(`/tasks/${task.body.task.id}`, {
    method: "PATCH",
    body: { status: "opt_nope" },
  });
  assert.equal(badStatus.status, 400);

  const agentComment = await request(`/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    body: {
      body: "I filed this from the conversation.",
      authorKind: "agent",
      viaChatId: "chat-123",
    },
  });
  assert.equal(agentComment.status, 201);
  assert.equal(agentComment.body.comment.author, "ws-owner");
  assert.equal(agentComment.body.comment.authorKind, "agent");
  assert.equal(agentComment.body.comment.viaChatId, "chat-123");

  const plain = await request(`/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    body: { body: "A person wrote this." },
  });
  assert.equal(plain.body.comment.authorKind, "user");

  const detail = await request(`/tasks/${task.body.task.id}`, { token: EDITOR });
  assert.equal(detail.body.comments.length, 2);
});

test("a stale document write is refused and the current copy comes back", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const created = await request(`/projects/${project.id}/documents`, {
    method: "POST",
    body: { title: "Roadmap", markdown: "# Roadmap\n" },
  });
  assert.equal(created.status, 201);
  const document = created.body.document;

  const first = await request(`/documents/${document.id}`, {
    method: "PATCH",
    body: { markdown: "# Roadmap\n\n- Ship\n", baseRev: document.rev },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.document.rev, document.rev + 1);

  // The editor on another device still holds the old revision.
  const stale = await request(`/documents/${document.id}`, {
    method: "PATCH",
    token: EDITOR,
    body: { markdown: "# Roadmap\n\n- Something else\n", baseRev: document.rev },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "stale_revision");
  assert.match(stale.body.document.markdown, /Ship/);

  // A listing does not carry the body.
  const list = await request(`/projects/${project.id}/documents`);
  assert.equal(list.body.documents[0].markdown, undefined);
  assert.ok(list.body.documents[0].bytes > 0);
});

test("the changes feed is one cursor, filtered by membership, tombstones included", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });

  const pull = await request("/changes?since=0");
  assert.equal(pull.status, 200);
  assert.ok(pull.body.cursor > 0);
  const kinds = new Set(pull.body.changes.map((change) => change.kind));
  for (const kind of ["project", "member", "board"]) {
    assert.ok(kinds.has(kind), `missing ${kind}`);
  }

  // The project row carries the reader's role: the window cannot decide what
  // it may write from a row that does not say.
  const feedProject = pull.body.changes.find((change) => change.kind === "project");
  assert.equal(feedProject.role, "owner");
  assert.equal(feedProject.mine, true);

  // A member row carries the account's profile, not just its subject: the
  // window shows people, not account numbers.
  const feedMember = pull.body.changes.find((change) => change.kind === "member");
  assert.equal(feedMember.email, "owner@example.test");

  // Someone who is not a member of anything sees nothing and keeps the cursor.
  const outsider = await request("/changes?since=0", { token: OUTSIDER });
  assert.equal(outsider.body.changes.length, 0);
  assert.equal(outsider.body.cursor, 0);

  // A delete is a tombstone, not a disappearance.
  await request(`/boards/${board.body.board.id}`, { method: "DELETE" });
  const after = await request(`/changes?since=${pull.body.cursor}`);
  const tombstone = after.body.changes.find(
    (change) => change.kind === "board" && change.id === board.body.board.id,
  );
  assert.equal(tombstone.deleted, true);
});

test("deleting a folder deletes everything inside it", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const outer = await request(`/projects/${project.id}/folders`, {
    method: "POST",
    body: { name: "Outer" },
  });
  const inner = await request(`/projects/${project.id}/folders`, {
    method: "POST",
    body: { name: "Inner", parentId: outer.body.folder.id },
  });
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Inside", folderId: inner.body.folder.id },
  });
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: { title: "A task in the folder" },
  });
  const document = await request(`/projects/${project.id}/documents`, {
    method: "POST",
    body: { title: "Inside too", folderId: inner.body.folder.id },
  });

  const before = await request("/changes?since=0");
  const deleted = await request(`/folders/${inner.body.folder.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);

  // The folder, the board it held and the document are all gone; the parent
  // folder is untouched.
  const folders = await request(`/projects/${project.id}/folders`);
  assert.deepEqual(
    folders.body.folders.map((folder) => folder.name),
    ["Outer"],
  );
  const boards = await request(`/projects/${project.id}/boards`);
  assert.equal(boards.body.boards.length, 0);
  const documents = await request(`/projects/${project.id}/documents`);
  assert.equal(documents.body.documents.length, 0);
  const gone = await request(`/tasks/${task.body.task.id}`);
  assert.equal(gone.status, 404);

  // The feed carries a tombstone for each of them, not just the folder.
  const after = await request(`/changes?since=${before.body.cursor}&limit=200`);
  const deletedKinds = new Set(
    after.body.changes.filter((item) => item.deleted).map((item) => item.kind),
  );
  for (const kind of ["folder", "board", "task", "document"]) {
    assert.ok(deletedKinds.has(kind), `the feed must carry the ${kind} tombstone`);
  }
});

test("deleting the account removes its projects and its memberships elsewhere", async (t) => {
  const { request } = await setup(t);
  const mine = await sharedProject(request);

  // A project owned by someone else, where this account is only a member.
  const theirs = await request("/projects", {
    method: "POST",
    token: OUTSIDER,
    body: { name: "Someone else's project" },
  });
  await request(`/projects/${theirs.body.project.id}/invites`, {
    method: "POST",
    token: OUTSIDER,
    body: { email: "owner@example.test", role: "viewer" },
  });
  const inbox = await request("/invites");
  await request(`/invites/${inbox.body.invites[0].id}/accept`, { method: "POST" });

  const deleted = await request("/api/sync/account", { method: "DELETE" });
  assert.equal(deleted.status, 200);

  const after = await request("/projects", { token: OWNER });
  assert.equal(after.body.projects.length, 0);

  // The other owner keeps the project, minus this member.
  const members = await request(`/projects/${theirs.body.project.id}/members`, {
    token: OUTSIDER,
  });
  assert.equal(members.status, 200);
  assert.deepEqual(
    members.body.members.map((member) => member.email),
    ["outsider@example.test"],
  );

  const feed = await request("/changes?since=0", { token: OWNER });
  assert.equal(feed.body.changes.length, 0);
});

test("folders organize boards and documents, and deleting one keeps its contents", async (t) => {
  const { request } = await setup(t);
  const { body: created } = await request("/projects", {
    method: "POST",
    body: { name: "Filed" },
  });
  const project = created.project;

  const design = await request(`/projects/${project.id}/folders`, {
    method: "POST",
    body: { name: "Design" },
  });
  assert.equal(design.status, 201);
  // A folder can hold a folder.
  const nested = await request(`/projects/${project.id}/folders`, {
    method: "POST",
    body: { name: "Screens", parentId: design.body.folder.id },
  });
  assert.equal(nested.status, 201);
  assert.equal(nested.body.folder.parentId, design.body.folder.id);

  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint", folderId: design.body.folder.id },
  });
  assert.equal(board.body.board.folderId, design.body.folder.id);
  const document = await request(`/projects/${project.id}/documents`, {
    method: "POST",
    body: { title: "Brief", folderId: nested.body.folder.id },
  });
  assert.equal(document.body.document.folderId, nested.body.folder.id);

  const renamed = await request(`/folders/${design.body.folder.id}`, {
    method: "PATCH",
    body: { name: "Brand" },
  });
  assert.equal(renamed.body.folder.name, "Brand");

  // Moving out is a PATCH with a null folder, which is different from omitting it.
  const moved = await request(`/boards/${board.body.board.id}`, {
    method: "PATCH",
    body: { folderId: null },
  });
  assert.equal(moved.body.board.folderId, null);

  // Deleting the folder takes its contents: the nested folder and the document
  // that lived in it.
  await request(`/folders/${design.body.folder.id}`, { method: "DELETE" });
  const folders = await request(`/projects/${project.id}/folders`);
  assert.deepEqual(
    folders.body.folders.map((folder) => folder.name),
    [],
  );
  const documents = await request(`/projects/${project.id}/documents`);
  assert.deepEqual(
    documents.body.documents.map((entry) => entry.title),
    [],
  );

  const changes = await request("/changes?since=0&limit=200");
  const tombstone = changes.body.changes.find(
    (change) => change.kind === "folder" && change.deleted && change.id === design.body.folder.id,
  );
  assert.ok(tombstone, "the changes feed must carry the folder deletion");
});
