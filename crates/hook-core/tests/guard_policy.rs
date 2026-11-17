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

#[test]
fn guard_blocks_bash_calls_without_a_sane_timeout() {
    if !node_available() {
        eprintln!("node not installed — skipping the guard policy test");
        return;
    }

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let guard = root.join("resources").join("hook-guard.mjs");
    let harness = root.join("tests").join("fixtures").join("guard-harness.mjs");

    let output = Command::new("node")
        .arg(&harness)
        .arg(&guard)
        .output()
        .expect("node should run");
    assert!(
        output.status.success(),
        "harness failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let raw = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(&raw).expect("harness prints JSON");

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

    // The preview panel: the tool is offered, the guidance says it is optional,
    // and a page is only accepted inside the project and as HTML.
    let preview = &value["preview"];
    assert_eq!(preview["toolsRegistered"], true, "show_preview must be offered");
    assert_eq!(
        preview["guidanceExplainsOptional"], true,
        "the coding agent must be told the preview is optional"
    );
    assert_eq!(preview["resultOk"], true);
    assert_eq!(preview["outsideRejected"], true, "../evil.html must be refused");
    assert_eq!(preview["nonHtmlRejected"], true, "a .tsx file must be refused");
    assert_eq!(preview["written"]["file"], "preview.html");
    assert_eq!(preview["written"]["title"], "Insights");
}
