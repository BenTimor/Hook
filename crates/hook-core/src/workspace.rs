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

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

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
            "Tasks on a board: title, Markdown description, status, assignee and custom column values. Create several in one turn when the user asks for a list of work.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "board": { "type": "string", "description": "Board id, for list and create." },
                    "task": { "type": "string", "description": "Task id (tk_…)." },
                    "title": { "type": "string" },
                    "description": { "type": "string", "description": "Markdown." },
                    "status": { "type": "string", "description": "One of the board's status option ids." },
                    "assignee": { "type": "string", "description": "Account subject of a project member, or null." },
                    "fields": { "type": "object", "description": "Values keyed by column id." },
                    "position": { "type": "integer" }
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
            "Markdown documents in a project. The Markdown is the document: pass it exactly as it should be stored. An update carries the revision you read; a stale one is refused with the current copy so you can re-apply the change.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "project": { "type": "string" },
                    "document": { "type": "string", "description": "Document id (dc_…)." },
                    "title": { "type": "string" },
                    "markdown": { "type": "string" },
                    "folder": { "type": "string" },
                    "baseRev": { "type": "integer", "description": "The revision you read, for update." }
                },
                "required": ["action"]
            }),
        ),
        tool(
            "workspace_members",
            "The people in a project and their roles: viewer (read only), editor (create and edit boards, tasks, documents), manager (editor plus inviting viewers and editors), owner (everything, including deleting the project and transferring ownership). You can invite, change roles and remove people, but never transfer ownership.",
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
            "Show a task, board or document in the user's preview panel. Use it when you changed or read something worth looking at; the user can then read it beside the chat.",
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

/// Run one `workspace_*` tool call. The return value is the JSON the model sees.
pub async fn execute(
    client: &WorkspaceClient,
    chat_id: &str,
    name: &str,
    args: &Value,
) -> String {
    let result = match name {
        "workspace_projects" => projects(client, args).await,
        "workspace_folders" => folders(client, args).await,
        "workspace_boards" => boards(client, args).await,
        "workspace_tasks" => tasks(client, args).await,
        "workspace_comments" => comments(client, chat_id, args).await,
        "workspace_documents" => documents(client, args).await,
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
            if let Some(fields) = args.get("fields").filter(|value| value.is_object()) {
                body["fields"] = fields.clone();
            }
            if let Some(position) = args.get("position").and_then(Value::as_i64) {
                body["position"] = json!(position);
            }
            client.patch(&format!("/tasks/{task}"), body).await
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
        "get" => client.get(&format!("/documents/{}", required(args, "document")?)).await,
        "create" => {
            let project = required(args, "project")?;
            let mut body = json!({ "title": string(args, "title").unwrap_or_else(|| "Untitled".into()) });
            if let Some(markdown) = args.get("markdown").and_then(Value::as_str) {
                body["markdown"] = json!(markdown);
            }
            if let Some(folder) = string(args, "folder") {
                body["folderId"] = json!(folder);
            }
            client.post(&format!("/projects/{project}/documents"), body).await
        }
        "update" => {
            let document = required(args, "document")?;
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
            if let Some(base) = args.get("baseRev").and_then(Value::as_i64) {
                body["baseRev"] = json!(base);
            }
            client.patch(&format!("/documents/{document}"), body).await
        }
        "delete" => client.delete(&format!("/documents/{}", required(args, "document")?)).await,
        other => Err(format!("Unknown action: {other}")),
    }
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
    const KNOWN: [&str; 11] = [
        "list", "get", "create", "update", "delete", "invite", "set_role", "remove", "accept",
        "decline", "revoke",
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
            "workspace_members",
            "workspace_invites",
            "workspace_preview",
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
    fn unknown_actions_are_rejected_before_a_request_is_made() {
        assert!(action(&json!({ "action": "nope" })).is_err());
        assert!(action(&json!({})).is_err());
        assert_eq!(action(&json!({ "action": "list" })).unwrap(), "list");
        assert_eq!(action(&json!({ "action": "set_role" })).unwrap(), "set_role");
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
