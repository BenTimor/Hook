//! Commands typed into the composer.
//!
//! A message that begins with `/` and names a registered command is not sent to
//! the model: [`run`] executes it and the chat behaves as if the message had
//! been sent (the window gets the same events either way). The registry here is
//! the single place a command is declared — the composer's menu is this list
//! over IPC, so a command the menu does not show cannot be smuggled in by
//! typing it, and a command that is added here is accepted by the backend the
//! moment it is listed.
//!
//! Commands are part of advanced mode. With it off the list is empty, the
//! composer offers no menu, and [`run`] refuses anyway — the window's gating is
//! cosmetic.
//!
//! Adding a command: one entry in [`COMMANDS`], then a match arm in [`run`].
//! Nothing else in the app has to learn about it.

use std::sync::Arc;

use serde::Serialize;

use crate::state::AppState;
use crate::store::Chat;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Scope {
    /// Every conversation.
    Any,
    /// Only a conversation with a coding agent.
    Coding,
}

struct Command {
    name: &'static str,
    /// One line, shown beside the name in the composer's menu.
    summary: &'static str,
    /// How it is typed, argument placeholder included.
    usage: &'static str,
    scope: Scope,
}

const COMMANDS: &[Command] = &[Command {
    name: "compact",
    summary: "Summarize the older turns and continue from the summary",
    usage: "/compact [what to keep]",
    scope: Scope::Any,
}];

/// A command as the window reads it. `scope` is `"any"` or `"coding"`; the phone
/// and the dock render the same list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandView {
    pub name: &'static str,
    pub summary: &'static str,
    pub usage: &'static str,
    pub scope: &'static str,
}

/// What the composer offers: nothing at all unless advanced mode is on.
pub fn list(advanced: bool) -> Vec<CommandView> {
    if !advanced {
        return Vec::new();
    }
    COMMANDS
        .iter()
        .map(|command| CommandView {
            name: command.name,
            summary: command.summary,
            usage: command.usage,
            scope: match command.scope {
                Scope::Any => "any",
                Scope::Coding => "coding",
            },
        })
        .collect()
}

/// A message the user typed as a command.
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    pub name: String,
    /// Everything after the command name, trimmed. Empty when there is none.
    pub args: String,
}

/// `Some` only for text that names a registered command, so a chat that starts
/// with a slash for any other reason still reaches the model.
pub fn parse(text: &str) -> Option<Invocation> {
    let rest = text.trim().strip_prefix('/')?;
    let (name, args) = match rest.split_once(char::is_whitespace) {
        Some((name, args)) => (name, args.trim()),
        None => (rest, ""),
    };
    let name = name.to_ascii_lowercase();
    COMMANDS.iter().find(|command| command.name == name)?;
    Some(Invocation {
        name,
        args: args.to_string(),
    })
}

/// Run one command for this chat. The caller returns the chat id, so a command
/// answers exactly like a message did.
pub async fn run(state: &Arc<AppState>, chat: &Chat, call: Invocation) -> Result<(), String> {
    if !state.settings.advanced_mode() {
        return Err("Commands are available in advanced mode.".into());
    }
    let Some(command) = COMMANDS.iter().find(|command| command.name == call.name) else {
        return Err(format!("/{} is not a command.", call.name));
    };
    let coding = crate::coding::is_coding(chat);
    if command.scope == Scope::Coding && !coding {
        return Err(format!(
            "/{} only works in a conversation with a coding agent.",
            call.name
        ));
    }

    match command.name {
        "compact" => compact(state, chat, &call.args).await,
        other => Err(format!("/{other} is not a command.")),
    }
}

async fn compact(state: &Arc<AppState>, chat: &Chat, args: &str) -> Result<(), String> {
    let instructions = Some(args.trim()).filter(|text| !text.is_empty());

    // A coding agent owns its transcript: pi does the folding, either through
    // the live process or by being started again on the same session. A cached
    // copy of someone else's chat sends the request to the machine that owns it.
    if crate::coding::is_coding(chat) {
        if chat.meta.remote {
            let device = chat
                .meta
                .device_id
                .clone()
                .ok_or("This conversation does not know which machine owns it.")?;
            crate::session::remote_rpc(
                state,
                &device,
                "coding.compact",
                serde_json::json!({
                    "chatId": chat.meta.id,
                    "instructions": instructions,
                }),
                std::time::Duration::from_secs(30),
            )
            .await?;
            return Ok(());
        }
        return crate::coding::compact(state, chat, instructions);
    }

    // The chat agent's compaction runs in the background, so a chat with nothing
    // to fold is refused here, where the window still has a message to show.
    let keep = crate::config::get()
        .map(|cfg| cfg.compact.keep_turns)
        .unwrap_or(3);
    if crate::compact::plan(chat, keep).is_none() {
        return Err("There is not enough conversation to compact yet.".into());
    }
    crate::turn::kick_compact(
        state.clone(),
        chat.meta.id.clone(),
        instructions.map(str::to_string),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_registered_command_is_a_command() {
        assert_eq!(
            parse("/compact").unwrap(),
            Invocation {
                name: "compact".into(),
                args: String::new()
            }
        );
        assert_eq!(parse("  /COMPACT  keep the paths \n").unwrap().args, "keep the paths");
        assert!(parse("/compactkeep").is_none());
        assert!(parse("/unknown").is_none());
        assert!(parse("hello /compact").is_none());
        assert!(parse("/").is_none());
    }

    #[test]
    fn the_menu_is_empty_without_advanced_mode() {
        assert!(list(false).is_empty());
        assert_eq!(list(true).len(), 1);
        assert_eq!(list(true)[0].name, "compact");
    }
}
