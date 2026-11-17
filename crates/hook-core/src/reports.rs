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

/// Send a report to `/api/reports`. Returns a message the UI can show.
pub async fn submit(
    cfg: &HarnessConfig,
    token: &str,
    payload: &ReportRequest,
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
