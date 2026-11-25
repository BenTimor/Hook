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
import { rewriteLegacyMarkup } from "./document-markup.mjs";
import { can, createWorkspaceRouter } from "./workspace.mjs";

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
  assert.equal(inbox.body.invites[0].inviterEmail, "owner@example.test");
  assert.equal(inbox.body.invites[0].inviterName, null);

  const accepted = await request(`/invites/${inbox.body.invites[0].id}/accept`, {
    method: "POST",
    token: EDITOR,
  });
  assert.equal(accepted.status, 200);
  return project;
}

test("an inbox invitation includes the inviter's readable profile", async (t) => {
  const { request, directory } = await setup(t);
  const db = new DatabaseSync(join(directory, "signups.sqlite"));
  db.prepare("UPDATE waitlist_signups SET name = ? WHERE google_subject = ?").run("Alex Morgan", "ws-owner");
  db.close();
  const created = await request("/projects", { method: "POST", body: { name: "Launch planning" } });
  await request(`/projects/${created.body.project.id}/invites`, {
    method: "POST", body: { email: "editor@example.test", role: "editor" },
  });
  const inbox = await request("/invites", { token: EDITOR });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.invites[0].inviterName, "Alex Morgan");
  assert.equal(inbox.body.invites[0].inviterEmail, "owner@example.test");
  assert.equal(inbox.body.invites[0].projectName, "Launch planning");
});

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

test("a task is assigned to an invitation by address until it is accepted", async (t) => {
  const { request } = await setup(t);
  const created = await request("/projects", {
    method: "POST",
    body: { name: "Website redesign" },
  });
  const project = created.body.project;
  await request(`/projects/${project.id}/invites`, {
    method: "POST",
    body: { email: "editor@example.test", role: "editor" },
  });
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });

  // Until they accept, the address is the only handle there is — normalised,
  // because that is how the invitation is addressed.
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: { title: "Wire the sign-up form", assignee: "Editor@Example.test" },
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.task.assignee, "editor@example.test");

  const members = await request(`/projects/${project.id}/members`);
  assert.deepEqual(
    members.body.pending.map((invite) => [invite.email, invite.role]),
    [["editor@example.test", "editor"]],
  );

  // Invitation addresses are for the people who can invite, not for everyone.
  await request(`/projects/${project.id}/invites`, {
    method: "POST",
    body: { email: "outsider@example.test", role: "viewer" },
  });
  const inbox = await request("/invites", { token: OUTSIDER });
  await request(`/invites/${inbox.body.invites[0].id}/accept`, {
    method: "POST",
    token: OUTSIDER,
  });
  const asViewer = await request(`/projects/${project.id}/members`, { token: OUTSIDER });
  assert.deepEqual(asViewer.body.pending, []);
  assert.equal(asViewer.body.members.length, 2);
});

test("accepting an invitation hands every task assigned to the address to the account", async (t) => {
  const { request } = await setup(t);
  const created = await request("/projects", {
    method: "POST",
    body: { name: "Website redesign" },
  });
  const project = created.body.project;
  await request(`/projects/${project.id}/invites`, {
    method: "POST",
    body: { email: "editor@example.test", role: "editor" },
  });
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: { title: "Wire the sign-up form", assignee: "editor@example.test" },
  });

  const before = await request("/changes");
  const inbox = await request("/invites", { token: EDITOR });
  await request(`/invites/${inbox.body.invites[0].id}/accept`, {
    method: "POST",
    token: EDITOR,
  });

  const after = await request(`/tasks/${task.body.task.id}`);
  assert.equal(after.body.task.assignee, "ws-editor");

  // The owner's window learns about it from the feed, without reloading.
  const changes = await request(`/changes?since=${before.body.cursor}`);
  const row = changes.body.changes.find(
    (change) => change.kind === "task" && change.id === task.body.task.id,
  );
  assert.equal(row.assignee, "ws-editor");

  const members = await request(`/projects/${project.id}/members`);
  assert.deepEqual(members.body.pending, []);

  // From now on an address that already belongs to the project stores the
  // account, whoever wrote it.
  const byEmail = await request(`/tasks/${task.body.task.id}`, {
    method: "PATCH",
    body: { assignee: "EDITOR@example.test" },
  });
  assert.equal(byEmail.body.task.assignee, "ws-editor");
});

test("a task left on an address is repaired when the service starts", async (t) => {
  const { request, directory } = await setup(t);
  const project = await sharedProject(request);
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: { title: "Filed before the invitation was answered" },
  });

  // The row a task had when it was written before acceptances were adopted.
  const db = new DatabaseSync(join(directory, "signups.sqlite"));
  db.prepare("UPDATE ws_tasks SET assignee = ? WHERE id = ?").run(
    "editor@example.test",
    task.body.task.id,
  );
  // A deploy restarts the service on the same database.
  createWorkspaceRouter({ db });
  db.close();

  const after = await request(`/tasks/${task.body.task.id}`);
  assert.equal(after.body.task.assignee, "ws-editor");
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

test("a board's statuses can be extended without replacing the board", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const created = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const board = created.body.board;
  const status = board.columns.find((column) => column.type === "status");
  const columns = board.columns.map((column) =>
    column.type === "status"
      ? {
          ...column,
          options: [...column.options, { id: "opt_blocked", label: "Blocked by Dev", color: "red" }],
        }
      : column,
  );

  const updated = await request(`/boards/${board.id}`, {
    method: "PATCH",
    body: { columns },
  });
  assert.equal(updated.status, 200);
  const updatedStatus = updated.body.board.columns.find((column) => column.type === "status");
  assert.deepEqual(
    updatedStatus.options.map((option) => [option.id, option.label]),
    [...status.options.map((option) => [option.id, option.label]), ["opt_blocked", "Blocked by Dev"]],
  );
  assert.equal(updatedStatus.options.find((option) => option.id === "opt_blocked").color, "red");

  const task = await request(`/boards/${board.id}/tasks`, {
    method: "POST",
    body: { title: "Waiting for the backend", status: "opt_blocked" },
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.task.status, "opt_blocked");
});

test("flexible properties persist their types, options, hidden state and view", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const created = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: {
      name: "Flexible board",
      view: "board",
      columns: [
        {
          name: "Stage",
          type: "status",
          options: [{ id: "opt_todo", label: "To do" }, { id: "opt_done", label: "Done" }],
        },
        {
          name: "Tags",
          type: "multiselect",
          options: [{ id: "opt_design", label: "Design" }, { id: "opt_be", label: "Backend" }],
        },
        { name: "Done", type: "checkbox" },
        { name: "Timeline", type: "daterange" },
        { name: "Notes", type: "longtext", hidden: true },
      ],
    },
  });
  assert.equal(created.status, 201);
  const board = created.body.board;
  assert.equal(board.view, "board");
  const tags = board.columns.find((column) => column.name === "Tags");
  const checkbox = board.columns.find((column) => column.name === "Done");
  const timeline = board.columns.find((column) => column.name === "Timeline");
  assert.equal(tags.type, "multiselect");
  assert.equal(board.columns.find((column) => column.name === "Notes").hidden, true);

  const task = await request(`/boards/${board.id}/tasks`, {
    method: "POST",
    body: {
      title: "Ship the flexible board",
      status: "opt_todo",
      fields: {
        [tags.id]: ["opt_design", "opt_be"],
        [checkbox.id]: true,
        [timeline.id]: { start: "2026-06-01", end: "2026-06-15" },
      },
    },
  });
  assert.equal(task.status, 201);
  assert.deepEqual(task.body.task.fields[tags.id], ["opt_design", "opt_be"]);
  assert.equal(task.body.task.fields[checkbox.id], true);
  assert.deepEqual(task.body.task.fields[timeline.id], {
    start: "2026-06-01",
    end: "2026-06-15",
  });

  const patched = await request(`/tasks/${task.body.task.id}`, {
    method: "PATCH",
    body: { fields: { ...task.body.task.fields, [checkbox.id]: false } },
  });
  assert.equal(patched.body.task.fields[checkbox.id], false);

  // Removing a property leaves an old value behind; the next task edit should
  // ignore it instead of failing validation.
  await request(`/boards/${board.id}`, {
    method: "PATCH",
    body: { columns: board.columns.filter((column) => column.id !== checkbox.id) },
  });
  const afterRemoval = await request(`/tasks/${task.body.task.id}`, {
    method: "PATCH",
    body: { fields: { ...patched.body.task.fields, [timeline.id]: { start: "2026-06-02", end: "2026-06-20" } } },
  });
  assert.equal(afterRemoval.status, 200);
  assert.equal(afterRemoval.body.task.fields[checkbox.id], undefined);
  assert.deepEqual(afterRemoval.body.task.fields[timeline.id], {
    start: "2026-06-02",
    end: "2026-06-20",
  });
});

test("a template-shaped Project tracker board creates all its properties", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const created = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: {
      name: "Project tracker",
      description: "Keep projects, owners, budgets and progress together.",
      view: "table",
      columns: [
        {
          name: "Status",
          type: "status",
          options: [
            { label: "Not started" },
            { label: "In progress" },
            { label: "Blocked" },
            { label: "Done" },
          ],
        },
        { name: "Owner", type: "person" },
        { name: "Due", type: "date" },
        { name: "Budget", type: "number" },
        { name: "Progress", type: "progress" },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    created.body.board.columns.map((column) => [column.name, column.type]),
    [
      ["Status", "status"],
      ["Owner", "person"],
      ["Due", "date"],
      ["Budget", "number"],
      ["Progress", "progress"],
    ],
  );
});

test("comments are edited and deleted by their author or a manager", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: { title: "Review the brief" },
  });

  const ownersComment = await request(`/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    body: { body: "First draft." },
  });
  const commentId = ownersComment.body.comment.id;

  // A different editor cannot rewrite someone else's comment.
  const refused = await request(`/comments/${commentId}`, {
    method: "PATCH",
    token: EDITOR,
    body: { body: "Hijacked." },
  });
  assert.equal(refused.status, 403);

  const edited = await request(`/comments/${commentId}`, {
    method: "PATCH",
    body: { body: "Second draft." },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.comment.body, "Second draft.");
  assert.ok(edited.body.comment.updatedAt >= edited.body.comment.createdAt);

  const editorsComment = await request(`/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    token: EDITOR,
    body: { body: "Looks good to me." },
  });
  const ownEdit = await request(`/comments/${editorsComment.body.comment.id}`, {
    method: "PATCH",
    token: EDITOR,
    body: { body: "Looks good to me now." },
  });
  assert.equal(ownEdit.status, 200);
  assert.equal(ownEdit.body.comment.body, "Looks good to me now.");

  // A manager may remove another person's comment; an editor may not.
  const editorRemoval = await request(`/comments/${commentId}`, {
    method: "DELETE",
    token: EDITOR,
  });
  assert.equal(editorRemoval.status, 403);
  const removed = await request(`/comments/${commentId}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const remaining = await request(`/tasks/${task.body.task.id}/comments`);
  assert.deepEqual(remaining.body.comments.map((comment) => comment.id), [editorsComment.body.comment.id]);
});

test("a task keeps several assignees, de-duplicated, with the first mirrored for older clients", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const boardId = board.body.board.id;

  const created = await request(`/boards/${boardId}/tasks`, {
    method: "POST",
    body: {
      title: "Pair on the sign-up form",
      assignees: ["ws-owner", "ws-editor", "EDITOR@example.test"],
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.task.assignees, ["ws-owner", "ws-editor"]);
  assert.equal(created.body.task.assignee, "ws-owner");

  const replaced = await request(`/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { assignees: ["ws-editor", "editor@example.test", "ws-owner"] },
  });
  assert.deepEqual(replaced.body.task.assignees, ["ws-editor", "ws-owner"]);
  assert.equal(replaced.body.task.assignee, "ws-editor");

  // The legacy single-assignee write still works and clears the rest.
  const legacy = await request(`/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { assignee: "ws-owner" },
  });
  assert.deepEqual(legacy.body.task.assignees, ["ws-owner"]);
  assert.equal(legacy.body.task.assignee, "ws-owner");

  const cleared = await request(`/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { assignees: [] },
  });
  assert.deepEqual(cleared.body.task.assignees, []);
  assert.equal(cleared.body.task.assignee, null);

  const malformed = await request(`/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { assignees: "ws-owner" },
  });
  assert.equal(malformed.status, 400);
});

test("accepting an invitation rewrites its address inside a multi-assignee task", async (t) => {
  const { request } = await setup(t);
  const createdProject = await request("/projects", {
    method: "POST",
    body: { name: "Website redesign" },
  });
  const project = createdProject.body.project;
  await request(`/projects/${project.id}/invites`, {
    method: "POST",
    body: { email: "editor@example.test", role: "editor" },
  });
  const board = await request(`/projects/${project.id}/boards`, {
    method: "POST",
    body: { name: "Sprint 1" },
  });
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: {
      title: "Wire the sign-up form",
      assignees: ["ws-owner", "editor@example.test"],
    },
  });
  assert.deepEqual(task.body.task.assignees, ["ws-owner", "editor@example.test"]);

  const before = await request("/changes");
  const inbox = await request("/invites", { token: EDITOR });
  await request(`/invites/${inbox.body.invites[0].id}/accept`, {
    method: "POST",
    token: EDITOR,
  });

  const after = await request(`/tasks/${task.body.task.id}`);
  assert.deepEqual(after.body.task.assignees, ["ws-owner", "ws-editor"]);
  assert.equal(after.body.task.assignee, "ws-owner");

  const changes = await request(`/changes?since=${before.body.cursor}`);
  const row = changes.body.changes.find(
    (change) => change.kind === "task" && change.id === task.body.task.id,
  );
  assert.deepEqual(row.assignees, ["ws-owner", "ws-editor"]);
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

test("a document's direction is its Markdown, not a column", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);
  // Direction lives in the document's own `::meta{direction=rtl}` line, so a
  // stray field is neither stored nor echoed: the text is the whole story.
  const created = await request(`/projects/${project.id}/documents`, {
    method: "POST",
    body: {
      title: "מימין לשמאל",
      markdown: "::meta{direction=rtl}\n# שלום\n",
      direction: "rtl",
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.document.direction, undefined);
  assert.match(created.body.document.markdown, /::meta\{direction=rtl\}/);

  const documentId = created.body.document.id;
  const list = await request(`/projects/${project.id}/documents`);
  assert.equal(list.body.documents[0].direction, undefined);

  const changed = await request(`/documents/${documentId}`, {
    method: "PATCH",
    body: { direction: "sideways" },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.document.direction, undefined);
});

test("roadmaps hold milestones with their date, status and description", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);

  const created = await request(`/projects/${project.id}/roadmaps`, {
    method: "POST",
    body: { name: "Release roadmap", description: "The path to launch." },
  });
  assert.equal(created.status, 201);
  const roadmap = created.body.roadmap;
  assert.equal(roadmap.name, "Release roadmap");
  assert.equal(roadmap.description, "The path to launch.");

  const later = await request(`/roadmaps/${roadmap.id}/milestones`, {
    method: "POST",
    body: {
      title: "Public beta",
      description: "Ship it.",
      dueDate: "2026-12-01",
      status: "active",
    },
  });
  assert.equal(later.status, 201);
  assert.equal(later.body.milestone.roadmapId, roadmap.id);
  assert.equal(later.body.milestone.dueDate, "2026-12-01");
  assert.equal(later.body.milestone.status, "active");

  const sooner = await request(`/roadmaps/${roadmap.id}/milestones`, {
    method: "POST",
    body: { title: "Design freeze", dueDate: "2026-10-01" },
  });
  assert.equal(sooner.status, 201);
  assert.equal(sooner.body.milestone.status, "planned");

  const list = await request(`/roadmaps/${roadmap.id}/milestones`);
  assert.deepEqual(
    list.body.milestones.map((milestone) => milestone.title),
    ["Design freeze", "Public beta"],
  );

  const updated = await request(`/milestones/${later.body.milestone.id}`, {
    method: "PATCH",
    body: { status: "done", dueDate: null },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.milestone.status, "done");
  assert.equal(updated.body.milestone.dueDate, null);

  const invalid = await request(`/roadmaps/${roadmap.id}/milestones`, {
    method: "POST",
    body: { title: "Nope", status: "someday" },
  });
  assert.equal(invalid.status, 400);

  const changes = await request("/changes?since=0&limit=200");
  assert.ok(changes.body.changes.some((change) => change.kind === "roadmap"));
  assert.ok(changes.body.changes.some((change) => change.kind === "milestone"));
});

test("brainstorms hold ideas and travel through the changes feed", async (t) => {
  const { request } = await setup(t);
  const project = await sharedProject(request);

  const created = await request(`/projects/${project.id}/brainstorms`, {
    method: "POST",
    body: { name: "Naming", description: "What is it called?" },
  });
  assert.equal(created.status, 201);
  const brainstorm = created.body.brainstorm;
  assert.equal(brainstorm.name, "Naming");

  const first = await request(`/brainstorms/${brainstorm.id}/ideas`, {
    method: "POST",
    body: { text: "Something short" },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.idea.brainstormId, brainstorm.id);
  const second = await request(`/brainstorms/${brainstorm.id}/ideas`, {
    method: "POST",
    body: { text: "Something plain" },
  });
  assert.equal(second.status, 201);

  const list = await request(`/projects/${project.id}/brainstorm-ideas`);
  assert.deepEqual(
    list.body.ideas.map((idea) => idea.text),
    ["Something short", "Something plain"],
  );

  const single = await request(`/brainstorms/${brainstorm.id}`);
  assert.equal(single.body.brainstorm.id, brainstorm.id);
  const ideas = await request(`/brainstorms/${brainstorm.id}/ideas`);
  assert.equal(ideas.body.ideas.length, 2);

  const renamed = await request(`/brainstorms/${brainstorm.id}`, {
    method: "PATCH",
    body: { name: "The name" },
  });
  assert.equal(renamed.body.brainstorm.name, "The name");

  const removed = await request(`/ideas/${first.body.idea.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const remaining = await request(`/brainstorms/${brainstorm.id}/ideas`);
  assert.deepEqual(
    remaining.body.ideas.map((idea) => idea.text),
    ["Something plain"],
  );

  const changes = await request("/changes?since=0&limit=300");
  assert.ok(changes.body.changes.some((change) => change.kind === "brainstorm"));
  assert.ok(changes.body.changes.some((change) => change.kind === "brainstorm_idea"));
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

test("deleting a folder removes its roadmaps, milestones, brainstorms and ideas", async (t) => {
  const { request } = await setup(t);
  const { body: created } = await request("/projects", {
    method: "POST",
    body: { name: "Roadmap folders" },
  });
  const project = created.project;
  const folder = await request(`/projects/${project.id}/folders`, {
    method: "POST",
    body: { name: "Release" },
  });
  const roadmap = await request(`/projects/${project.id}/roadmaps`, {
    method: "POST",
    body: { name: "Launch roadmap", folderId: folder.body.folder.id },
  });
  assert.equal(roadmap.status, 201);
  const milestone = await request(`/roadmaps/${roadmap.body.roadmap.id}/milestones`, {
    method: "POST",
    body: { title: "Launch" },
  });
  assert.equal(milestone.status, 201);
  const brainstorm = await request(`/projects/${project.id}/brainstorms`, {
    method: "POST",
    body: { name: "Launch names", folderId: folder.body.folder.id },
  });
  assert.equal(brainstorm.status, 201);
  const idea = await request(`/brainstorms/${brainstorm.body.brainstorm.id}/ideas`, {
    method: "POST",
    body: { text: "A short name" },
  });
  assert.equal(idea.status, 201);

  await request(`/folders/${folder.body.folder.id}`, { method: "DELETE" });
  const roadmaps = await request(`/projects/${project.id}/roadmaps`);
  assert.deepEqual(roadmaps.body.roadmaps, []);
  const list = await request(`/projects/${project.id}/milestones`);
  assert.deepEqual(list.body.milestones, []);
  const brainstorms = await request(`/projects/${project.id}/brainstorms`);
  assert.deepEqual(brainstorms.body.brainstorms, []);
  const ideas = await request(`/projects/${project.id}/brainstorm-ideas`);
  assert.deepEqual(ideas.body.ideas, []);
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

test("the old toolbar's inline HTML is rewritten, and nothing else is", () => {
  assert.equal(
    rewriteLegacyMarkup('<span class="hook-color-red">red</span> plain'),
    ":red[red] plain",
  );
  assert.equal(rewriteLegacyMarkup("<mark>mark</mark> and <u>under</u>"), ":mark[mark] and :underline[under]");
  assert.equal(
    rewriteLegacyMarkup('<span class="hook-color-blue">a <mark>b</mark></span>'),
    ":blue[a :mark[b]]",
  );
  // a bracket inside a label would end it, so it becomes an entity
  assert.equal(rewriteLegacyMarkup("<u>see [1]</u>"), ":underline[see [1&#93;]");
});

test("a sample of HTML inside code is not a formatting run", () => {
  const fenced = "```html\n<mark>hi</mark>\n```";
  assert.equal(rewriteLegacyMarkup(fenced), fenced);
  const tilde = "~~~\n<u>hi</u>\n~~~";
  assert.equal(rewriteLegacyMarkup(tilde), tilde);
  assert.equal(rewriteLegacyMarkup("use `<mark>` for that"), "use `<mark>` for that");
});

test("the rewrite is idempotent and leaves other HTML alone", () => {
  const once = rewriteLegacyMarkup("<mark>x</mark>");
  assert.equal(rewriteLegacyMarkup(once), once);
  assert.equal(rewriteLegacyMarkup("<div>x</div> <br>"), "<div>x</div> <br>");
});

test("stored documents are rewritten when the service starts", async (t) => {
  const { request, directory } = await setup(t);
  const project = await sharedProject(request);
  const created = await request(`/projects/${project.id}/documents`, {
    method: "POST",
    body: { title: "Old branding", markdown: "placeholder" },
  });
  const document = created.body.document;

  const db = new DatabaseSync(join(directory, "signups.sqlite"));
  db.prepare("UPDATE ws_documents SET markdown = ?, rev = 3 WHERE id = ?").run(
    '<span class="hook-color-green">quiet</span> and <mark>warm</mark>',
    document.id,
  );
  const before = db.prepare("SELECT seq FROM ws_documents WHERE id = ?").get(document.id);
  // A deploy restarts the service on the same database.
  createWorkspaceRouter({ db });
  const after = db.prepare("SELECT markdown, rev, seq FROM ws_documents WHERE id = ?").get(document.id);
  // A second boot finds nothing to do.
  createWorkspaceRouter({ db });
  const again = db.prepare("SELECT seq FROM ws_documents WHERE id = ?").get(document.id);
  db.close();

  assert.equal(after.markdown, ":green[quiet] and :mark[warm]");
  assert.equal(after.rev, 4);
  assert.ok(after.seq > before.seq, "devices must see the change");
  assert.equal(again.seq, after.seq, "the migration is idempotent");
});

test("a task description written with HTML is rewritten too", async (t) => {
  const { request, directory } = await setup(t);
  const project = await sharedProject(request);
  const board = await request(`/projects/${project.id}/boards`, { method: "POST", body: { name: "Sprint" } });
  const task = await request(`/boards/${board.body.board.id}/tasks`, {
    method: "POST",
    body: { title: "Old" },
  });
  const db = new DatabaseSync(join(directory, "signups.sqlite"));
  db.prepare("UPDATE ws_tasks SET description = ? WHERE id = ?").run(
    "<u>careful</u>",
    task.body.task.id,
  );
  createWorkspaceRouter({ db });
  const row = db.prepare("SELECT description FROM ws_tasks WHERE id = ?").get(task.body.task.id);
  db.close();
  assert.equal(row.description, ":underline[careful]");
});
