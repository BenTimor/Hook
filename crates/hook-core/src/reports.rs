//! Reporting inappropriate AI output.
//!
//! Microsoft Store policy 11.16 requires a way for users to flag content that a
//! generative model produced. The renderer builds the report; this module sends
//! it with the signed-in token, so the renderer never sees the account token.
//! The full conversation is opt-in — the user decides whether to include it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::HarnessConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    pub chat_id: String,
    pub message_id: String,
    pub reason: String,
    #[serde(default)]
    pub note: Option<String>,
    pub content: String,
    #[serde(default)]
    pub transcript: Option<Vec<ReportMessage>>,
    /// Filled by the command; the renderer does not send it.
    #[serde(default)]
    pub app_version: String,
}

/// What a preview was showing when it was reported.
///
/// A task's comments and a document are written by people, so the report has to
/// say *what* was flagged, not only in which chat it appeared. It shares the
/// transport with AI-output reports: one review queue is the point.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTarget {
    /// "task", "document" or "board".
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentReportRequest {
    pub chat_id: String,
    pub target: ReportTarget,
    pub reason: String,
    #[serde(default)]
    pub note: Option<String>,
    /// The words being reported: a comment, a document, the title of a task.
    pub content: String,
    #[serde(default)]
    pub app_version: String,
}

/// Send a report to `/api/reports`. Returns a message the UI can show.
///
/// Generic over the body because the same queue takes two shapes: a model reply
/// with an optional transcript, and a piece of user-generated content with a
/// target. The endpoint validates both; this side only carries them.
pub async fn submit<T: Serialize>(
    cfg: &HarnessConfig,
    token: &str,
    payload: &T,
) -> Result<(), String> {
    let url = format!("{}/api/reports", cfg.auth.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("Could not prepare the report: {error}"))?;

    let response = client
        .post(&url)
        .bearer_auth(token)
        .json(payload)
        .send()
        .await
        .map_err(|error| format!("Could not send the report: {error}"))?;

    if response.status().is_success() {
        return Ok(());
    }
    Err(match response.status().as_u16() {
        401 | 403 => "This session cannot send reports. Sign in again.".into(),
        413 => "That conversation is too large to report. Try reporting the reply only.".into(),
        429 => "Too many reports were sent in the last hour. Try again later.".into(),
        status => format!("The report was not accepted (HTTP {status})."),
    })
}
