//! Hook Workspace, seen from the chat.
//!
//! The chat agent is a first-class client of the workspace service: projects,
//! folders, boards, tasks, comments, documents, members and invitations are all
//! reached over the account API with the user's own token. Nothing here needs
//! Hook Workspace to be installed — the product's data lives on the server, and
//! the app is a rich client of the same endpoints.
//!
//! The server enforces the signed-in user's role. These tools act *as the user*:
//! an editor cannot invite, a manager cannot mint another manager, and ownership
//! never transfers from here.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::auth::AuthStore;
use crate::config::HarnessConfig;
use crate::markdown_edit;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// The document dialect, written for the model and for a person alike. It is
/// embedded so a `document_markdown` call never needs the network, and it lives
/// in `docs/` so the repository and the tool describe one syntax.
/// `packages/markdown/src/reference.test.ts` fails if a registered rule is
/// missing from it.
const MARKDOWN_REFERENCE: &str = include_str!("../../../docs/document-markdown.md");

pub struct WorkspaceClient {
    http: reqwest::Client,
    base: String,
    auth: Arc<AuthStore>,
}

impl WorkspaceClient {
    pub fn new(cfg: &HarnessConfig, auth: Arc<AuthStore>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(HTTP_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            base: format!("{}/api/ws", cfg.auth.base_url.trim_end_matches('/')),
            auth,
        }
    }

    /// The HTTP status and the decoded body. Only transport failures are errors:
    /// the workspace window needs the status (409 means "someone else edited
    /// this"), while the tools only need the message.
    pub async fn raw(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        let token = self
            .auth
            .token()
            .ok_or_else(|| "Sign in to use Hook Workspace.".to_string())?;
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(token)
            .header("accept", "application/json");
        if let Some(payload) = &body {
            request = request.json(payload);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("Could not reach the workspace service: {e}"))?;
        let status = response.status().as_u16();
        let value = response
            .json::<Value>()
            .await
            .unwrap_or_else(|_| json!({}));
        Ok((status, value))
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let (status, value) = self.raw(method, path, body).await?;
        if (200..300).contains(&status) {
            return Ok(value);
        }
        // The server's message is written for a person; hand it to the model
        // unchanged so it can tell the user what went wrong.
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The workspace service refused that request.");
        Err(message.to_string())
    }

    pub async fn get(&self, path: &str) -> Result<Value, String> {
        self.call(reqwest::Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> Result<Value, String> {
        self.call(reqwest::Method::PATCH, path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> Result<Value, String> {
        self.call(reqwest::Method::DELETE, path, None).await
    }
}

/// The tool schemas the chat agent sees when Workspace is available.
///
/// One tool per noun with an `action`, rather than 30 verbs: the prompt stays
/// small and the model only has to learn the shape of four ideas — project,
/// board, task, document — plus the people in them.
pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "workspace_projects",
            "Hook Workspace projects: the containers that hold boards, documents and people. List them first when a request names a project you have not seen; the ids come from here.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "project": { "type": "string", "description": "Project id (wp_…)." },
                    "name": { "type": "string", "description": "Project name, 80 characters at most." },
                    "description": { "type": "string" }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_folders",
            "Folders inside a project. They only organize things for the user; nothing depends on them.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "update", "delete"] },
                    "project": { "type": "string" },
                    "folder": { "type": "string", "description": "Folder id (fd_…)." },
                    "name": { "type": "string" },
                    "parent": { "type": "string", "description": "Parent folder id, or omit for the project root." },
                    "position": { "type": "integer" }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_boards",
            "Boards hold the tasks. A board has typed columns: exactly one `status` column (whose options are the columns of the board view) and any of text, number, date, select, person. Read a board before adding tasks so you use its real column ids.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "update", "delete"] },
                    "project": { "type": "string" },
                    "board": { "type": "string", "description": "Board id (bd_…)." },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "folder": { "type": "string" },
                    "columns": {
                        "type": "array",
                        "description": "The board's columns. Each is {name, type, options?}. One type may be \"status\"; its options become the kanban columns.",
                        "items": { "type": "object" }
                    }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_tasks",
            "Tasks on a board: title, Markdown description, status, assignees and custom column values. Create several in one turn when the user asks for a list of work.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "board": { "type": "string", "description": "Board id, for list and create." },
                    "task": { "type": "string", "description": "Task id (tk_…)." },
                    "title": { "type": "string" },
                    "description": { "type": "string", "description": "Markdown." },
                    "status": { "type": "string", "description": "One of the board's status option ids." },
                    "assignee": { "type": "string", "description": "One account subject of a project member. Prefer `assignees` when a task should have several people. For someone invited who has not accepted yet, the email address: workspace_members lists those under pending, and the assignment becomes their name when they accept." },
                    "assignees": { "type": "array", "items": { "type": "string" }, "description": "One or more account subjects (or pending invitation email addresses). Each is resolved to the person's account when they accept." },
                    "fields": { "type": "object", "description": "Values keyed by column id." },
                    "position": { "type": "integer" },
                    "edits": { "type": "array", "items": { "type": "object" }, "description": "For update: change the description by the piece instead of sending it again. The same operations as `workspace_documents` (`replace`, `replace_section`, `insert_after_section`, `insert_before_section`, `delete_section`, `append`), applied to the stored description. Do not send `description` as well." }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_comments",
            "Comments on a task. You write them in the user's name, marked as written by their Hook agent so nobody mistakes it for something they typed. Say which conversation it came from only if it helps.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "delete"] },
                    "task": { "type": "string" },
                    "comment": { "type": "string", "description": "Comment id (cm_…), to delete." },
                    "body": { "type": "string", "description": "Markdown, 16 KB at most." }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_documents",
            "Markdown documents in a project. The Markdown is the document. To change part of one, use `edit`: it names a section or an exact run of text and rewrites only that, so a long document never has to be retyped. `outline` lists the headings, and `get` with a `section` returns just that part. `update` replaces the whole body and carries the revision you read; a stale one is refused with the current copy so you can re-apply the change. Hook's own formatting — colour, highlight, underline, keys and the callout boxes — is a directive syntax on top of Markdown and never inline HTML: read `document_markdown` before you style anything.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "outline", "get", "create", "update", "edit", "delete"] },
                    "project": { "type": "string" },
                    "document": { "type": "string", "description": "Document id (dc_…)." },
                    "title": { "type": "string" },
                    "markdown": { "type": "string", "description": "A body in full, for create and update. For one section, use `edit` instead." },
                    "folder": { "type": "string" },
                    "baseRev": { "type": "integer", "description": "For update: the revision you read. `edit` reads and writes in one call, so it does not need one." },
                    "section": { "type": "string", "description": "For get: one section instead of the whole document. A heading (`Pricing`) or a path (`Pricing > Cards`), case-insensitive." },
                    "occurrence": { "type": "integer", "minimum": 1, "description": "Which heading, when several share the name. 1 by default, for get." },
                    "edits": { "type": "array", "items": { "type": "object" }, "description": "For edit: operations applied in order, written back as one revision. Each names an `op` — `{op:\"replace\", find:\"exact text\", replace:\"new\", all?:false}` rewrites text that appears exactly once (or every time, with all); `{op:\"replace_section\", section:\"Pricing > Cards\", markdown:\"…\"}` replaces the lines under that heading and keeps the heading, so the Markdown may carry its own subheadings; `{op:\"insert_after_section\"|\"insert_before_section\", section:\"…\", markdown:\"…\"}` adds a block beside it; `{op:\"delete_section\", section:\"…\"}` removes the heading and its body; `{op:\"append\", markdown:\"…\"}` adds at the end. `occurrence` in an op (1 by default) picks between headings that share a name. A refusal says what is there instead, so the next call is a correction." }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_roadmaps",
            "Roadmaps are project items like documents and boards: a horizontal timeline that holds milestones. Create the roadmap first, then add milestones to it.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "project": { "type": "string" },
                    "roadmap": { "type": "string", "description": "Roadmap id (rm_…)." },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "folder": { "type": "string" }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_milestones",
            "Milestones inside a roadmap: a title, a target date (YYYY-MM-DD), a status (planned, active or done) and a description. Use workspace_roadmaps first when the roadmap does not exist yet.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "project": { "type": "string" },
                    "roadmap": { "type": "string", "description": "Roadmap id (rm_…), required to create and useful to list." },
                    "milestone": { "type": "string", "description": "Milestone id (ms_…)." },
                    "title": { "type": "string" },
                    "dueDate": { "type": "string", "description": "YYYY-MM-DD, or null to clear." },
                    "status": { "type": "string", "enum": ["planned", "active", "done"] },
                    "description": { "type": "string" }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "document_markdown",
            "The exact syntax of Hook's document Markdown, on demand: the colour, highlight, underline and key directives, the callout blocks and how they nest, where each is allowed, what stays literal, the traps, the document direction (`::meta{direction=rtl}` and the `:::rtl` block), and the one document option that is not Markdown (title). Call it before you style a document, a task description or a comment, or when you are not sure whether something is allowed. Plain Markdown and plain prose need no lookup.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "workspace_members",
            "The people in a project and their roles: viewer (read only), editor (create and edit boards, tasks, documents), manager (editor plus inviting viewers and editors), owner (everything, including deleting the project and transferring ownership). `pending` holds the people who were invited but have not accepted: only their email is known, and that is the address a task is assigned to. You can invite, change roles and remove people, but never transfer ownership.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "invite", "set_role", "remove"] },
                    "project": { "type": "string" },
                    "email": { "type": "string", "description": "For invite." },
                    "subject": { "type": "string", "description": "Account subject of a member, for set_role and remove." },
                    "role": { "type": "string", "enum": ["viewer", "editor", "manager"] }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_invites",
            "Invitations: the ones waiting for the user, and revoking one the user sent. Accepting an invitation on the user's behalf is allowed when they asked for it.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "accept", "decline", "revoke"] },
                    "invite": { "type": "string", "description": "Invite id (iv_…)." }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_preview",
            "Show a task, board or document in the user's preview panel. Call it as soon as you know what to show and before you write the reply: the tool result has to be followed by another message, so previewing after the answer turns that message into a redundant confirmation. The user can read it beside the chat; do not say that it is open.",
            json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["task", "document", "board"] },
                    "id": { "type": "string" }
                },
                "required": ["kind", "id"]
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": parameters }
    })
}

fn string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required(args: &Value, key: &str) -> Result<String, String> {
    string(args, key).ok_or_else(|| format!("Missing \"{key}\"."))
}

/// Which of several headings that share a name. 1 by default, so an absent
/// `occurrence` means "the first one" rather than "guess".
fn occurrence(args: &Value) -> usize {
    args.get("occurrence")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
        .unwrap_or(1)
}

/// True for the tool names [`execute`] answers. The turn and the tool bridge use
/// it to route a call to the store that owns it, so a tool advertised here and
/// not routed here is dead: `document_markdown` is the one whose name does not
/// carry the family's prefix.
pub fn handles(name: &str) -> bool {
    name.starts_with("workspace_") || name == "document_markdown"
}

/// Run one `workspace_*` tool call. The return value is the JSON the model sees.
pub async fn execute(
    client: &WorkspaceClient,
    chat_id: &str,
    name: &str,
    args: &Value,
) -> String {
    // The reference is text in this binary: no account, no network, and the
    // answer is the document itself rather than a JSON-escaped copy of it.
    if name == "document_markdown" {
        return MARKDOWN_REFERENCE.to_string();
    }
    let result = match name {
        "workspace_projects" => projects(client, args).await,
        "workspace_folders" => folders(client, args).await,
        "workspace_boards" => boards(client, args).await,
        "workspace_tasks" => tasks(client, args).await,
        "workspace_comments" => comments(client, chat_id, args).await,
        "workspace_documents" => documents(client, args).await,
        "workspace_roadmaps" => roadmaps(client, args).await,
        "workspace_milestones" => milestones(client, args).await,
        "workspace_members" => members(client, args).await,
        "workspace_invites" => invites(client, args).await,
        "workspace_preview" => preview(client, args).await,
        other => Err(format!("Unknown workspace tool: {other}")),
    };
    match result {
        Ok(value) => value.to_string(),
        Err(message) => json!({ "error": message }).to_string(),
    }
}

type ToolResult = Result<Value, String>;

async fn projects(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get("/projects").await,
        "get" => client.get(&format!("/projects/{}", required(args, "project")?)).await,
        "create" => {
            let mut body = json!({ "name": required(args, "name")? });
            if let Some(description) = string(args, "description") {
                body["description"] = json!(description);
            }
            client.post("/projects", body).await
        }
        "update" => {
            let project = required(args, "project")?;
            let mut body = json!({});
            for (key, field) in [("name", "name"), ("description", "description")] {
                if let Some(value) = string(args, key) {
                    body[field] = json!(value);
                }
            }
            client.patch(&format!("/projects/{project}"), body).await
        }
        "delete" => client.delete(&format!("/projects/{}", required(args, "project")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn folders(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/projects/{}/folders", required(args, "project")?)).await,
        "create" => {
            let project = required(args, "project")?;
            let mut body = json!({ "name": required(args, "name")? });
            if let Some(parent) = string(args, "parent") {
                body["parentId"] = json!(parent);
            }
            if let Some(position) = args.get("position").and_then(Value::as_i64) {
                body["position"] = json!(position);
            }
            client.post(&format!("/projects/{project}/folders"), body).await
        }
        "update" => {
            let folder = required(args, "folder")?;
            let mut body = json!({});
            if let Some(value) = string(args, "name") {
                body["name"] = json!(value);
            }
            if let Some(parent) = string(args, "parent") {
                body["parentId"] = json!(parent);
            }
            if let Some(position) = args.get("position").and_then(Value::as_i64) {
                body["position"] = json!(position);
            }
            client.patch(&format!("/folders/{folder}"), body).await
        }
        "delete" => client.delete(&format!("/folders/{}", required(args, "folder")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn boards(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/projects/{}/boards", required(args, "project")?)).await,
        "create" => {
            let project = required(args, "project")?;
            let mut body = json!({ "name": required(args, "name")? });
            if let Some(description) = string(args, "description") {
                body["description"] = json!(description);
            }
            if let Some(folder) = string(args, "folder") {
                body["folderId"] = json!(folder);
            }
            if let Some(columns) = args.get("columns").filter(|value| value.is_array()) {
                body["columns"] = columns.clone();
            }
            client.post(&format!("/projects/{project}/boards"), body).await
        }
        "update" => {
            let board = required(args, "board")?;
            let mut body = json!({});
            for (key, field) in [
                ("name", "name"),
                ("description", "description"),
                ("folder", "folderId"),
            ] {
                if let Some(value) = string(args, key) {
                    body[field] = json!(value);
                }
            }
            if let Some(columns) = args.get("columns").filter(|value| value.is_array()) {
                body["columns"] = columns.clone();
            }
            client.patch(&format!("/boards/{board}"), body).await
        }
        "delete" => client.delete(&format!("/boards/{}", required(args, "board")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn tasks(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/boards/{}/tasks", required(args, "board")?)).await,
        "get" => client.get(&format!("/tasks/{}", required(args, "task")?)).await,
        "create" => {
            let board = required(args, "board")?;
            let mut body = json!({ "title": required(args, "title")? });
            for key in ["description", "status", "assignee"] {
                if let Some(value) = string(args, key) {
                    body[key] = json!(value);
                }
            }
            if let Some(assignees) = args.get("assignees").filter(|value| value.is_array()) {
                body["assignees"] = assignees.clone();
            }
            if let Some(fields) = args.get("fields").filter(|value| value.is_object()) {
                body["fields"] = fields.clone();
            }
            if let Some(position) = args.get("position").and_then(Value::as_i64) {
                body["position"] = json!(position);
            }
            client.post(&format!("/boards/{board}/tasks"), body).await
        }
        "update" => {
            let task = required(args, "task")?;
            let mut body = json!({});
            for key in ["title", "description", "status", "assignee"] {
                if let Some(value) = string(args, key) {
                    body[key] = json!(value);
                }
            }
            if let Some(assignees) = args.get("assignees").filter(|value| value.is_array()) {
                body["assignees"] = assignees.clone();
            }
            if let Some(fields) = args.get("fields").filter(|value| value.is_object()) {
                body["fields"] = fields.clone();
            }
            if let Some(position) = args.get("position").and_then(Value::as_i64) {
                body["position"] = json!(position);
            }
            // A description is Markdown, so the surgery that changes one
            // document changes one task without retyping the rest of it.
            let mut applied = None;
            if let Some(edits) = args.get("edits").and_then(Value::as_array) {
                if body.get("description").is_some() {
                    return Err("Send either \"description\" or \"edits\", not both: edits change the description that is already stored.".into());
                }
                let current = client.get(&format!("/tasks/{task}")).await?;
                let description = current["task"]["description"].as_str().unwrap_or_default();
                let (updated, summaries) = markdown_edit::apply_all(description, edits)?;
                body["description"] = json!(updated);
                applied = Some(summaries);
            }
            let mut value = client.patch(&format!("/tasks/{task}"), body).await?;
            if let Some(applied) = applied {
                value["applied"] = json!(applied);
            }
            Ok(value)
        }
        "delete" => client.delete(&format!("/tasks/{}", required(args, "task")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn comments(client: &WorkspaceClient, chat_id: &str, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/tasks/{}/comments", required(args, "task")?)).await,
        "create" => {
            let task = required(args, "task")?;
            let body = json!({
                "body": required(args, "body")?,
                // The user is the author; the marker says how it was written.
                "authorKind": "agent",
                "viaChatId": chat_id,
            });
            client.post(&format!("/tasks/{task}/comments"), body).await
        }
        "delete" => {
            client.delete(&format!("/comments/{}", required(args, "comment")?)).await
        }
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn documents(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/projects/{}/documents", required(args, "project")?)).await,
        "outline" => {
            let (id, document) = read_document(client, args).await?;
            let markdown = document["markdown"].as_str().unwrap_or_default();
            let found = markdown_edit::sections(markdown);
            let mut out = json!({
                "document": id,
                "title": document["title"],
                "rev": document["rev"],
                "lines": markdown.lines().count(),
                "sections": outline(&found, markdown),
            });
            // The outline is the map, not the document: a heading per row, and
            // a bound so a generated document cannot flood the conversation.
            if found.len() > OUTLINE_CAP {
                out["omittedSections"] = json!(found.len() - OUTLINE_CAP);
            }
            Ok(out)
        }
        "get" => {
            let (id, document) = read_document(client, args).await?;
            let Some(spec) = string(args, "section") else {
                return Ok(json!({ "document": document }));
            };
            let markdown = document["markdown"].as_str().unwrap_or_default();
            let found = markdown_edit::sections(markdown);
            let index = markdown_edit::resolve(&found, &spec, occurrence(args))?;
            let section = &found[index];
            Ok(json!({
                "document": id,
                "title": document["title"],
                "rev": document["rev"],
                "section": section.path,
                "line": section.line,
                "markdown": section.whole(markdown),
            }))
        }
        "create" => {
            let project = required(args, "project")?;
            let mut body = document_fields(args);
            if body.get("title").is_none() {
                body["title"] = json!("Untitled");
            }
            client.post(&format!("/projects/{project}/documents"), body).await
        }
        "update" => {
            let document = required(args, "document")?;
            let mut body = document_fields(args);
            if let Some(base) = args.get("baseRev").and_then(Value::as_i64) {
                body["baseRev"] = json!(base);
            }
            client.patch(&format!("/documents/{document}"), body).await
        }
        "edit" => edit_document(client, args).await,
        "delete" => client.delete(&format!("/documents/{}", required(args, "document")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

/// How many headings `outline` returns. Reached only by a generated document;
/// the count of what was left out is always reported.
const OUTLINE_CAP: usize = 200;

/// The document behind an id, and the id itself. `get` hands back the shape the
/// server sent; every other reader wants the row.
async fn read_document(client: &WorkspaceClient, args: &Value) -> Result<(String, Value), String> {
    let id = required(args, "document")?;
    let value = client.get(&format!("/documents/{id}")).await?;
    let document = value.get("document").cloned().unwrap_or(value);
    Ok((id, document))
}

/// One row per heading, addressed the way an edit addresses it.
fn outline(found: &[markdown_edit::Section], markdown: &str) -> Value {
    Value::Array(
        found
            .iter()
            .take(OUTLINE_CAP)
            .map(|section| {
                json!({
                    "path": section.path,
                    "level": section.level,
                    "line": section.line,
                    "lines": section.whole(markdown).lines().count(),
                })
            })
            .collect(),
    )
}

/// The heading names, flat. What a refused write hands back: enough to re-aim
/// the edit without sending the document.
fn section_titles(markdown: &str) -> Vec<String> {
    markdown_edit::sections(markdown)
        .iter()
        .take(OUTLINE_CAP)
        .map(|section| section.path.clone())
        .collect()
}

/// Change a document by the piece.
///
/// The read and the write are one call: the revision the edit is based on is
/// the one this request just read, so there is no window for the model to lose
/// the document between the two. A model that names `baseRev` explicitly is
/// saying "apply this on the version I read earlier", and the server refuses it
/// if that is no longer the current one.
async fn edit_document(client: &WorkspaceClient, args: &Value) -> ToolResult {
    let id = required(args, "document")?;
    let edits = args
        .get("edits")
        .and_then(Value::as_array)
        .filter(|edits| !edits.is_empty())
        .ok_or_else(|| "Send \"edits\": the operations to apply, in order.".to_string())?;
    let (_, document) = read_document(client, args).await?;
    let markdown = document["markdown"].as_str().unwrap_or_default();
    let (updated, applied) = markdown_edit::apply_all(markdown, edits)?;
    let rev = args
        .get("baseRev")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| document["rev"].as_i64().unwrap_or(0));

    let (status, value) = client
        .raw(
            reqwest::Method::PATCH,
            &format!("/documents/{id}"),
            Some(json!({ "markdown": updated, "baseRev": rev })),
        )
        .await?;
    if status == 409 {
        // Someone wrote between this call's read and its write. Nothing was
        // saved, and the headings of the current copy are what the model needs
        // to re-aim the same change — not the whole document again.
        let current = value.get("document").cloned().unwrap_or_else(|| json!({}));
        let current_markdown = current["markdown"].as_str().unwrap_or_default();
        return Ok(json!({
            "error": "The document changed while this edit was being written, so nothing was saved. Its headings are below: re-read the section you are changing and apply the edit again to the current revision.",
            "document": id,
            "rev": current["rev"],
            "sections": section_titles(current_markdown),
            "droppedEdits": applied,
        }));
    }
    if !(200..300).contains(&status) {
        return Err(value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The workspace service refused that request.")
            .to_string());
    }
    Ok(json!({
        "document": id,
        "title": value["document"]["title"],
        "rev": value["document"]["rev"],
        "applied": applied,
        "lines": {
            "before": markdown.lines().count(),
            "after": updated.lines().count(),
        },
    }))
}

/// The fields one document write carries. Only what the call named: to the
/// server an absent field means "leave it alone", so an update that changes the
/// text cannot reset the title by omission.
fn document_fields(args: &Value) -> Value {
    let mut body = json!({});
    if let Some(title) = string(args, "title") {
        body["title"] = json!(title);
    }
    if let Some(markdown) = args.get("markdown").and_then(Value::as_str) {
        body["markdown"] = json!(markdown);
    }
    if let Some(folder) = string(args, "folder") {
        body["folderId"] = json!(folder);
    }
    body
}

async fn roadmaps(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/projects/{}/roadmaps", required(args, "project")?)).await,
        "get" => client.get(&format!("/roadmaps/{}", required(args, "roadmap")?)).await,
        "create" => {
            let project = required(args, "project")?;
            let mut body = roadmap_fields(args);
            if body.get("name").is_none() {
                body["name"] = json!("Roadmap");
            }
            client.post(&format!("/projects/{project}/roadmaps"), body).await
        }
        "update" => {
            let roadmap = required(args, "roadmap")?;
            client.patch(&format!("/roadmaps/{roadmap}"), roadmap_fields(args)).await
        }
        "delete" => client.delete(&format!("/roadmaps/{}", required(args, "roadmap")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

/// Only the roadmap fields the call named; an absent field is left unchanged.
fn roadmap_fields(args: &Value) -> Value {
    let mut body = json!({});
    for (key, field) in [("name", "name"), ("description", "description")] {
        if let Some(value) = string(args, key) {
            body[field] = json!(value);
        }
    }
    if let Some(folder) = string(args, "folder") {
        body["folderId"] = json!(folder);
    }
    body
}

async fn milestones(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => {
            if let Some(roadmap) = string(args, "roadmap") {
                client.get(&format!("/roadmaps/{roadmap}/milestones")).await
            } else {
                client.get(&format!("/projects/{}/milestones", required(args, "project")?)).await
            }
        }
        "get" => client.get(&format!("/milestones/{}", required(args, "milestone")?)).await,
        "create" => {
            let roadmap = required(args, "roadmap")?;
            let mut body = milestone_fields(args);
            if body.get("title").is_none() {
                body["title"] = json!("Milestone");
            }
            client.post(&format!("/roadmaps/{roadmap}/milestones"), body).await
        }
        "update" => {
            let milestone = required(args, "milestone")?;
            client.patch(&format!("/milestones/{milestone}"), milestone_fields(args)).await
        }
        "delete" => client.delete(&format!("/milestones/{}", required(args, "milestone")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

/// Only the milestone fields the call named; an absent field is left unchanged.
fn milestone_fields(args: &Value) -> Value {
    let mut body = json!({});
    for (key, field) in [
        ("title", "title"),
        ("description", "description"),
        ("status", "status"),
    ] {
        if let Some(value) = string(args, key) {
            body[field] = json!(value);
        }
    }
    if let Some(due) = args.get("dueDate") {
        if due.is_null() || due.is_string() {
            body["dueDate"] = due.clone();
        }
    }
    body
}

async fn members(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get(&format!("/projects/{}/members", required(args, "project")?)).await,
        "invite" => {
            let project = required(args, "project")?;
            let body = json!({
                "email": required(args, "email")?,
                "role": string(args, "role").unwrap_or_else(|| "editor".into()),
            });
            client.post(&format!("/projects/{project}/invites"), body).await
        }
        "set_role" => {
            let project = required(args, "project")?;
            let subject = required(args, "subject")?;
            let body = json!({ "role": required(args, "role")? });
            client
                .patch(&format!("/projects/{project}/members/{subject}"), body)
                .await
        }
        "remove" => {
            let project = required(args, "project")?;
            let subject = required(args, "subject")?;
            client
                .delete(&format!("/projects/{project}/members/{subject}"))
                .await
        }
        other => Err(format!("Unknown action: {other}")),
    }
}

async fn invites(client: &WorkspaceClient, args: &Value) -> ToolResult {
    match action(args)?.as_str() {
        "list" => client.get("/invites").await,
        "accept" => {
            let invite = required(args, "invite")?;
            client.post(&format!("/invites/{invite}/accept"), json!({})).await
        }
        "decline" => {
            let invite = required(args, "invite")?;
            client.post(&format!("/invites/{invite}/decline"), json!({})).await
        }
        "revoke" => client.delete(&format!("/invites/{}", required(args, "invite")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
}

/// Fetch the entity and hand it back in the shape the preview panel renders.
/// The panel itself lives in the chat product; the call is answered here so the
/// tool works the same from an embedded chat that has no panel.
async fn preview(client: &WorkspaceClient, args: &Value) -> ToolResult {
    let kind = required(args, "kind")?;
    let id = required(args, "id")?;
    match kind.as_str() {
        "document" => {
            let document = client.get(&format!("/documents/{id}")).await?;
            Ok(json!({
                "preview": { "kind": "document", "document": document["document"] }
            }))
        }
        "task" => {
            let task = client.get(&format!("/tasks/{id}")).await?;
            Ok(json!({
                "preview": { "kind": "task", "task": task["task"], "comments": task["comments"] }
            }))
        }
        "board" => {
            // The board plus its tasks: the panel renders the kanban columns so
            // the user sees the shape of the work at a glance.
            let board = client.get(&format!("/boards/{id}")).await?;
            let tasks = client.get(&format!("/boards/{id}/tasks")).await?;
            Ok(json!({
                "preview": {
                    "kind": "board",
                    "board": board["board"],
                    "tasks": tasks["tasks"],
                }
            }))
        }
        other => Err(format!("Unknown preview kind: {other}")),
    }
}

fn action(args: &Value) -> Result<String, String> {
    let value = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing \"action\".".to_string())?;
    const KNOWN: [&str; 13] = [
        "list", "outline", "get", "create", "update", "edit", "delete", "invite",
        "set_role", "remove", "accept", "decline", "revoke",
    ];
    if KNOWN.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Unknown action: {value}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_workspace_tool_is_advertised_with_a_schema() {
        let definitions = definitions();
        let names: Vec<&str> = definitions
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        for expected in [
            "workspace_projects",
            "workspace_folders",
            "workspace_boards",
            "workspace_tasks",
            "workspace_comments",
            "workspace_documents",
            "workspace_roadmaps",
            "workspace_milestones",
            "workspace_members",
            "workspace_invites",
            "workspace_preview",
            "document_markdown",
        ] {
            assert!(names.contains(&expected), "missing {expected}");
        }
        for tool in &definitions {
            assert_eq!(tool["type"], "function");
            assert!(
                tool["function"]["parameters"]["properties"].is_object(),
                "{} has no properties",
                tool["function"]["name"]
            );
        }
    }

    #[test]
    fn every_advertised_tool_is_routed_back_to_this_module() {
        for tool in definitions() {
            let name = tool["function"]["name"].as_str().unwrap_or("");
            assert!(handles(name), "{name} is advertised but never routed here");
        }
        assert!(!handles("web_search"));
        assert!(!handles("workspace"));
    }

    #[test]
    fn a_document_write_carries_only_what_it_was_given() {
        let body = document_fields(&json!({ "title": "Release", "markdown": "# x" }));
        assert_eq!(body["title"], "Release");
        assert_eq!(body["markdown"], "# x");
        // Direction is the document's own `::meta` line, never a field.
        assert!(document_fields(&json!({ "direction": "rtl" })).get("direction").is_none());
        // An update that only replaces the text must not touch the title.
        assert!(document_fields(&json!({ "markdown": "y" })).get("title").is_none());
        // An empty markdown is a write, not an omission.
        assert_eq!(document_fields(&json!({ "markdown": "" }))["markdown"], "");
    }

    #[test]
    fn the_document_reference_answers_without_the_network() {
        // The tool is text in the binary: no account, no request. The syntax a
        // person can read in `docs/document-markdown.md` is the syntax the model
        // is handed.
        assert!(MARKDOWN_REFERENCE.contains(":::note["));
        assert!(MARKDOWN_REFERENCE.contains(":red["));
        assert!(MARKDOWN_REFERENCE.contains(":mark["));
        assert!(MARKDOWN_REFERENCE.contains("rtl"), "the document direction is documented");
    }

    #[test]
    fn unknown_actions_are_rejected_before_a_request_is_made() {
        assert!(action(&json!({ "action": "nope" })).is_err());
        assert!(action(&json!({})).is_err());
        assert_eq!(action(&json!({ "action": "list" })).unwrap(), "list");
        assert_eq!(action(&json!({ "action": "set_role" })).unwrap(), "set_role");
        // The surgical edit and its map of the document.
        assert_eq!(action(&json!({ "action": "edit" })).unwrap(), "edit");
        assert_eq!(action(&json!({ "action": "outline" })).unwrap(), "outline");
    }

    #[test]
    fn the_edit_tools_are_advertised_where_the_model_looks() {
        // The schema is the only documentation a model gets for the ops, so a
        // missing action or a missing `edits` is a tool that cannot be used.
        let documents = definitions()
            .into_iter()
            .find(|tool| tool["function"]["name"] == "workspace_documents")
            .expect("workspace_documents is advertised");
        let properties = &documents["function"]["parameters"]["properties"];
        let actions = properties["action"]["enum"].to_string();
        for expected in ["\"edit\"", "\"outline\""] {
            assert!(actions.contains(expected), "{expected} is not an action");
        }
        assert!(properties["edits"].is_object());
        assert!(properties["section"].is_object());
        let description = properties["edits"]["description"].as_str().unwrap_or_default();
        for op in [
            "replace",
            "replace_section",
            "insert_after_section",
            "insert_before_section",
            "delete_section",
            "append",
        ] {
            assert!(description.contains(op), "{op} is not described");
        }
        // A task description is Markdown too, and takes the same operations.
        let tasks = definitions()
            .into_iter()
            .find(|tool| tool["function"]["name"] == "workspace_tasks")
            .expect("workspace_tasks is advertised");
        assert!(tasks["function"]["parameters"]["properties"]["edits"].is_object());
    }

    #[test]
    fn an_occurrence_is_one_unless_it_is_asked_for() {
        assert_eq!(occurrence(&json!({})), 1);
        assert_eq!(occurrence(&json!({ "occurrence": 0 })), 1);
        assert_eq!(occurrence(&json!({ "occurrence": 3 })), 3);
    }

    #[test]
    fn the_outline_addresses_a_section_the_way_an_edit_does() {
        let markdown = "# Release\n\n## Pricing\n\nk\n\n### Cards\n\nv\n";
        let found = markdown_edit::sections(markdown);
        let outline = outline(&found, markdown);
        let paths: Vec<&str> = outline
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["Release", "Release > Pricing", "Release > Pricing > Cards"]);
        assert_eq!(outline[2]["level"], 3);
        assert_eq!(outline[2]["line"], 7);
        assert_eq!(section_titles(markdown), paths);
    }

    #[test]
    fn the_agent_can_never_transfer_ownership() {
        // There is no tool and no action for it: ownership moves only in the
        // Workspace window, where the permanent warning lives.
        let definitions = definitions();
        for tool in definitions {
            let text = tool.to_string();
            assert!(!text.contains("\"transfer\""));
        }
    }
}
