//! Policy test for the embedded guard extension: the bash timeout rule must
//! block what it should block and leave everything else alone.

use std::path::PathBuf;
use std::process::Command;

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Load the guard the way pi does, in one of its two shapes, and collect what
/// the harness observed. `"direct"` runs the guard for a conversation the user
/// drives; an empty mode is an agent the chat agent relays.
fn run_harness(mode: &str) -> serde_json::Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let guard = root.join("resources").join("hook-guard.mjs");
    let harness = root.join("tests").join("fixtures").join("guard-harness.mjs");

    let output = Command::new("node")
        .arg(&harness)
        .arg(&guard)
        .arg(mode)
        .output()
        .expect("node should run");
    assert!(
        output.status.success(),
        "harness failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let raw = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&raw).expect("harness prints JSON")
}

#[test]
fn guard_blocks_bash_calls_without_a_sane_timeout() {
    if !node_available() {
        eprintln!("node not installed — skipping the guard policy test");
        return;
    }

    let value = run_harness("");
    assert_eq!(value["direct"], false, "this is the relayed shape");

    assert_eq!(
        value["hooks"],
        serde_json::json!(["before_agent_start", "tool_call", "tool_result"])
    );
    assert_eq!(value["guidelineAppended"], true);

    for blocked in ["missing", "zero", "huge", "negative", "wrongType"] {
        assert_eq!(value[blocked]["block"], true, "{blocked} should be blocked");
        let reason = value[blocked]["reason"].as_str().unwrap_or_default();
        assert!(
            reason.contains("BLOCKED by Hook guard"),
            "{blocked} reason was {reason:?}"
        );
    }

    assert!(
        value["missing"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("missing a `timeout`"),
        "the model must be told what is wrong"
    );
    assert!(
        value["huge"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("hard cap"),
        "oversized timeouts explain the cap"
    );

    // Allowed calls must not return a block verdict.
    assert_eq!(value["ok"].is_null(), true, "a valid timeout should pass");
    assert_eq!(value["nonBash"].is_null(), true, "other tools are untouched");

    // A shared project must never lose another computer's history.
    for blocked in ["forcePush", "forcePushLease", "deleteBranch"] {
        assert_eq!(value[blocked]["block"], true, "{blocked} should be blocked");
        assert!(
            value[blocked]["reason"]
                .as_str()
                .unwrap_or_default()
                .contains("BLOCKED by Hook guard"),
            "{blocked} must explain itself"
        );
    }
    assert_eq!(
        value["normalPush"].is_null(),
        true,
        "an ordinary push is left alone"
    );

    // The sync tools exist exactly when Hook gave the agent a managed git
    // config, and the prompt tells it to pull first and save at the end.
    assert_eq!(value["sync"]["toolsRegistered"], true);
    assert_eq!(value["sync"]["guidanceExplainsPull"], true);
    assert_eq!(value["sync"]["guidanceExplainsSave"], true);

    // The checklist the user watches: the tool is offered, it writes a plan
    // Hook can harvest, and the coding agent is told the plain-language rule.
    let plan = &value["plan"];
    assert_eq!(plan["toolsRegistered"], true, "update_plan must be offered");
    assert_eq!(plan["guidanceIncludesSeed"], true, "the seeded plan reaches the prompt");
    assert_eq!(plan["guidanceExplainsPlainLanguage"], true);
    assert_eq!(plan["resultOk"], true);
    assert_eq!(plan["emptyPlanRejected"], true, "an empty plan must not blank the board");
    assert_eq!(
        plan["written"].as_array().map(|steps| steps.len()),
        Some(2),
        "blank steps and unknown statuses are dropped"
    );
    assert_eq!(plan["written"][0]["status"], "done");
    assert_eq!(plan["written"][1]["status"], "active");

    // The agent knows it is a coding agent running inside Hook, not a terminal
    // session the user is watching.
    assert_eq!(
        value["guidance"]["identity"], true,
        "the prompt must say where the agent is running"
    );

    // Git in a folder that is not a Hook project: a folder inside one of the
    // user's own repositories reads their config (so their credentials work),
    // and a folder outside any repository says so instead of failing at a push.
    assert_eq!(
        value["git"]["userRepo"], true,
        "the user's own repository must be described as theirs"
    );
    assert_eq!(value["git"]["userRepoKeepsConfig"], true);
    assert_eq!(
        value["git"]["noCredentials"], true,
        "a folder with no repository must say git cannot authenticate there"
    );

    // The preview panel: the tool is offered, the guidance says it is optional,
    // and any HTML page on the machine is accepted while a non-HTML file is
    // still refused. The guard records an absolute path now; the panel serves
    // the page's own folder.
    let preview = &value["preview"];
    assert_eq!(preview["toolsRegistered"], true, "show_preview must be offered");
    assert_eq!(
        preview["guidanceExplainsOptional"], true,
        "the coding agent must be told the preview is optional"
    );
    assert_eq!(preview["resultOk"], true);
    assert_eq!(
        preview["outsideNonHtmlRejected"], true,
        "../evil.tsx must be refused because it is not HTML"
    );
    assert_eq!(preview["nonHtmlRejected"], true, "a .tsx file must be refused");
    let written = preview["written"]["file"].as_str().unwrap_or("");
    assert_eq!(
        std::path::Path::new(written)
            .file_name()
            .and_then(|name| name.to_str()),
        Some("preview.html")
    );
    assert_eq!(preview["written"]["title"], "Insights");

    // Pictures: the engine can only hand the model an image when its model card
    // says so, and the guard must not promise what the card did not.
    let pictures = &value["pictures"];
    assert_eq!(
        pictures["promisedWithVision"], true,
        "a model that sees images must be told `read` opens them"
    );
    assert_eq!(
        pictures["silentWithoutVision"], true,
        "a text-only model must not be told it can look at a picture"
    );
    assert_eq!(pictures["absentByDefault"], true);
}

#[test]
fn guard_offers_the_checklist_to_a_directly_driven_agent() {
    if !node_available() {
        eprintln!("node not installed — skipping the guard policy test");
        return;
    }

    let value = run_harness("direct");
    assert_eq!(value["direct"], true);

    // The user talks to the engine directly, so the task board above their
    // composer is fed only by what this agent writes: without the tool it sat
    // under an empty "Getting started…" until the run settled.
    let plan = &value["plan"];
    assert_eq!(
        plan["toolsRegistered"], true,
        "a direct agent must be able to write its own checklist"
    );
    assert_eq!(plan["guidanceExplainsPlainLanguage"], true);
    assert_eq!(plan["resultOk"], true);
    assert_eq!(
        plan["emptyPlanRejected"], true,
        "an empty plan must not blank the board"
    );
    assert_eq!(
        plan["written"].as_array().map(|steps| steps.len()),
        Some(2),
        "the plan it wrote reaches the mailbox Hook harvests"
    );
    assert_eq!(plan["written"][1]["status"], "active");

    // What a direct conversation shows is the same board and the same panel.
    assert_eq!(value["guidance"]["checklist"], true);
    assert_eq!(value["preview"]["toolsRegistered"], true);
    assert_eq!(value["preview"]["resultOk"], true);

    // Progress notes have nobody to relay them, so that tool stays out.
    assert_eq!(value["relayOnly"]["reportProgress"], false);
}
