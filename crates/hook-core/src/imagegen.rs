//! Making pictures, and putting the ones already on this computer into a chat.
//!
//! Hook does not draw images itself, and it does not hold the key that could:
//! a picture is an account request, made the way a message is. This module
//! posts `{ prompt, aspect_ratio, n }` to `POST {account}/api/v1/images` with
//! the account's own token and gets `{ data: [{ b64_json, media_type }] }`
//! back; the service holds the endpoint key, the plan rule and the daily
//! window (`server/images.mjs`).
//!
//! What comes back is then an ordinary attachment — stored in the chat's own
//! image folder (`store::Store::save_image`), synced like a screenshot, drawn
//! by the same strip and opened by the same lightbox.
//!
//! A picture can also be written to a folder the user names, which is what a
//! coding agent gets and all it gets: a run started by the chat agent has no
//! conversation to put a picture into.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::store::{base64_decode, image_size};

/// Where a picture is made: the account service, and the token every other
/// account call uses. The image endpoint's key never leaves the server.
pub struct Target {
    pub base_url: String,
    pub token: String,
}

impl Target {
    /// `None` for the token means "not signed in", which is the one case worth
    /// its own sentence: everything else would be a server error.
    pub fn new(base_url: &str, token: Option<String>) -> Result<Self, String> {
        let token = token
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| "Sign in to Hook to make pictures.".to_string())?;
        Ok(Self {
            base_url: base_url.trim().trim_end_matches('/').to_string(),
            token,
        })
    }

    pub fn url(&self) -> String {
        format!("{}/api/v1/images", self.base_url)
    }
}

/// One picture that came back from the endpoint, decoded.
pub struct Generated {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

impl Generated {
    /// "1024x1024 png": what a model can say about a picture it cannot see.
    pub fn describe(&self) -> String {
        let format = self.mime.trim_start_matches("image/");
        if self.width > 0 && self.height > 0 {
            format!("{}x{} {format}", self.width, self.height)
        } else {
            format.to_string()
        }
    }
}

/// What to ask for. `count` is already clamped to the build's ceiling.
pub struct Request<'a> {
    pub prompt: &'a str,
    pub aspect_ratio: Option<&'a str>,
    pub count: u8,
}

/// The endpoint's own idea of an aspect ratio: `16:9`, `2.35:1`, `9:19.5`.
/// Anything else is dropped rather than sent and refused.
fn clean_ratio(value: &str) -> Option<String> {
    let value = value.trim();
    let (left, right) = value.split_once(':')?;
    let numeric = |part: &str| {
        !part.is_empty()
            && part.len() <= 4
            && part
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.')
    };
    if numeric(left) && numeric(right) {
        Some(value.to_string())
    } else {
        None
    }
}

/// Ask the endpoint for pictures. Every byte that comes back is decoded here, so
/// a caller only ever deals with files.
pub async fn generate(
    target: &Target,
    request: &Request<'_>,
) -> Result<Vec<Generated>, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("generate_image needs a prompt describing the picture.".into());
    }
    if prompt.chars().count() > 4000 {
        return Err("That prompt is too long; describe the picture in a paragraph.".into());
    }

    let mut body = json!({
        "prompt": prompt,
        "n": request.count.max(1),
    });
    if let Some(ratio) = request.aspect_ratio.and_then(clean_ratio) {
        body["aspect_ratio"] = json!(ratio);
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        // A picture is a minute of work upstream, and the service gives it 180
        // seconds before it gives up: this budget outlives the service's.
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|error| format!("Could not prepare the picture request: {error}"))?;

    let response = client
        .post(target.url())
        .header("Authorization", format!("Bearer {}", target.token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("The picture service did not answer: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("The picture service answered unreadably: {error}"))?;
    let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        // The service writes its refusals for a person - the daily window, a
        // prompt that is too long, a plan that has none - and the model repeats
        // them. Nothing about the endpoint's own credential is in here.
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .unwrap_or("The picture service refused the request.");
        return Err(message.to_string());
    }

    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return Err("The picture service returned no picture.".into());
    }

    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let declared = entry
            .get("media_type")
            .and_then(Value::as_str)
            .map(str::to_string);
        // Bytes only: the service asks its own endpoint for `b64_json` and
        // hands on nothing else, so this never fetches a URL a response named.
        let Some(encoded) = entry.get("b64_json").and_then(Value::as_str) else {
            continue;
        };
        let bytes = base64_decode(encoded)?;
        if bytes.is_empty() {
            continue;
        }
        let mime = mime_of(&bytes, declared.as_deref());
        let (width, height) = image_size(&bytes).unwrap_or((0, 0));
        out.push(Generated {
            bytes,
            mime,
            width,
            height,
        });
    }
    if out.is_empty() {
        return Err("The picture service returned no picture Hook could read.".into());
    }
    Ok(out)
}

/// What the bytes actually are, trusting the header over the service's label.
fn mime_of(bytes: &[u8], declared: Option<&str>) -> String {
    if bytes.starts_with(b"\x89PNG") {
        return "image/png".into();
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return "image/jpeg".into();
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp".into();
    }
    if bytes.starts_with(b"GIF8") {
        return "image/gif".into();
    }
    match declared.map(str::trim) {
        Some("image/png") => "image/png".into(),
        Some("image/jpeg") | Some("image/jpg") => "image/jpeg".into(),
        Some("image/webp") => "image/webp".into(),
        Some("image/gif") => "image/gif".into(),
        // Hook stores and draws four formats; anything else is kept as a PNG
        // name and refused by the store with its own message.
        _ => "image/png".into(),
    }
}

/// The folder a picture goes to when the caller did not name one:
/// `Pictures/Hook`, so generated pictures sit with the rest of the user's.
pub fn default_folder() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default();
    let base = PathBuf::from(home);
    if base.as_os_str().is_empty() {
        return std::env::temp_dir().join("Hook");
    }
    base.join("Pictures").join("Hook")
}

/// "A red panda astronaut, studio lighting" → "a-red-panda-astronaut".
/// Short on purpose: the file name is a reminder, not the prompt.
pub fn slug(prompt: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in prompt.chars() {
        if c.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('-');
            }
            gap = false;
            for lower in c.to_lowercase() {
                out.push(lower);
            }
            if out.chars().count() >= 42 {
                break;
            }
        } else {
            gap = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "picture".into()
    } else {
        trimmed
    }
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn is_image_name(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("webp") | Some("gif")
    )
}

/// Write one picture where the model asked for it. `target` is either a folder
/// (the picture is named after the prompt) or a file. An existing file is never
/// overwritten: the copy becomes `name-2.png`, and so on.
pub fn save_copy(
    target: &Path,
    image: &Generated,
    prompt: &str,
    index: usize,
) -> Result<PathBuf, String> {
    let extension = extension_for(&image.mime);
    let (folder, stem) = if is_image_name(target) {
        let stem = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("picture")
            .to_string();
        (target.parent().map(Path::to_path_buf), stem)
    } else {
        let suffix = if index > 0 {
            format!("-{}", index + 1)
        } else {
            String::new()
        };
        (
            Some(target.to_path_buf()),
            format!("{}{suffix}.{extension}", slug(prompt)),
        )
    };
    let folder = folder.filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(default_folder);
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not create {}: {error}", folder.display()))?;

    let mut path = folder.join(&stem);
    if path.exists() {
        let base = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("picture")
            .to_string();
        let extension = path
            .extension()
            .and_then(|name| name.to_str())
            .unwrap_or(extension)
            .to_string();
        for attempt in 2..1000 {
            let candidate = folder.join(format!("{base}-{attempt}.{extension}"));
            if !candidate.exists() {
                path = candidate;
                break;
            }
        }
    }
    std::fs::write(&path, &image.bytes)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::now_ms;

    fn png_bytes() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 13]);
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&640u32.to_be_bytes());
        bytes.extend_from_slice(&480u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn a_ratio_is_only_sent_when_it_is_one() {
        assert_eq!(clean_ratio(" 16:9 "), Some("16:9".to_string()));
        assert_eq!(clean_ratio("2.35:1"), Some("2.35:1".to_string()));
        assert_eq!(clean_ratio("wide"), None);
        assert_eq!(clean_ratio("16:9; drop table"), None);
        assert_eq!(clean_ratio(":"), None);
    }

    #[test]
    fn the_bytes_decide_the_format() {
        assert_eq!(mime_of(&png_bytes(), Some("image/webp")), "image/png");
        assert_eq!(mime_of(b"GIF89a....", None), "image/gif");
        assert_eq!(mime_of(&[1, 2, 3], Some("image/jpeg")), "image/jpeg");
        assert_eq!(mime_of(&[1, 2, 3], None), "image/png");
    }

    #[test]
    fn a_name_comes_from_the_prompt_and_never_collides() {
        let dir = std::env::temp_dir().join(format!("hook-imagegen-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = Generated {
            bytes: png_bytes(),
            mime: "image/png".into(),
            width: 640,
            height: 480,
        };
        let first = save_copy(&dir, &image, "A red panda, in space", 0).unwrap();
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            "a-red-panda-in-space.png"
        );
        let second = save_copy(&dir, &image, "A red panda, in space", 0).unwrap();
        assert_eq!(
            second.file_name().unwrap().to_string_lossy(),
            "a-red-panda-in-space-2.png"
        );
        // Two pictures from one call never land on the same name.
        let named = save_copy(&dir, &image, "A red panda, in space", 1).unwrap();
        assert_eq!(
            named.file_name().unwrap().to_string_lossy(),
            "a-red-panda-in-space-2-2.png"
        );
        assert_eq!(image.describe(), "640x480 png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_target_keeps_its_own_name() {
        let dir = std::env::temp_dir().join(format!("hook-imagegen-file-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = Generated {
            bytes: png_bytes(),
            mime: "image/png".into(),
            width: 640,
            height: 480,
        };
        let target = dir.join("cover.png");
        let saved = save_copy(&target, &image, "anything", 0).unwrap();
        assert_eq!(saved, target);
        assert!(saved.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_account_service_is_the_only_place_a_picture_is_made() {
        let target = Target::new("https://hookcode.io/", Some("hk_token".into())).unwrap();
        assert_eq!(target.url(), "https://hookcode.io/api/v1/images");
        assert_eq!(target.token, "hk_token");
        // Not signed in is its own sentence, not a server error.
        assert!(Target::new("https://hookcode.io", None).is_err());
        assert!(Target::new("https://hookcode.io", Some("  ".into())).is_err());
    }
}
