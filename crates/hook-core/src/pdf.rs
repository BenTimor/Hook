//! "Export as PDF": the window writes the page it is showing to a file.
//!
//! Chromium does the drawing, in the print media, so the sheet carries what the
//! renderer drew instead of a second layout engine's guess: real text, the
//! pictures where they sit, the maths as vector outlines. Which parts of the
//! window are on the sheet is the product's print stylesheet — in
//! `apps/workspace` the document replaces the window for the length of the
//! export, so a page of prose does not arrive with a sidebar on it.
//!
//! WebView2 is the only runtime here with a silent writer:
//! `ICoreWebView2_7::PrintToPdf` takes a path and writes the file itself. On
//! every other platform [`DIRECT`] is false and the caller offers the print
//! dialog instead, which is where the operating system puts "Save as PDF".

use std::path::PathBuf;

/// What came back from asking the window to write itself out.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExport {
    /// The file that was written, when the person chose one.
    pub path: Option<String>,
    /// Whether this platform writes the PDF on its own. False means the window
    /// should fall back to the print dialog instead of asking for a path it
    /// could not fill.
    pub direct: bool,
}

/// Whether this build can write the file with no print dialog of its own.
pub const DIRECT: bool = cfg!(windows);

/// The longest stem to suggest, in bytes: a path has a limit and a title is not
/// usually one.
const MAX_STEM_BYTES: usize = 120;

/// The file name to suggest for a document: its title, without the characters
/// Windows refuses, ending in `.pdf`.
///
/// A title is a person's sentence, not a path: a `:` or a `?` in it must not
/// reach the save dialog as one, and a title with nothing usable left in it
/// still needs a name to save under.
pub fn file_name(title: &str) -> String {
    let cleaned: String = title
        .trim()
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    // Windows drops trailing dots and spaces from a name, and a stem of nothing
    // but them is not a name at all.
    let mut stem = cleaned.trim().trim_end_matches(['.', ' ']).trim().to_string();
    if stem.len() > MAX_STEM_BYTES {
        let mut cut = MAX_STEM_BYTES;
        while cut > 0 && !stem.is_char_boundary(cut) {
            cut -= 1;
        }
        stem.truncate(cut);
        stem = stem.trim_end().to_string();
    }
    if stem.to_lowercase().ends_with(".pdf") {
        stem
    } else if stem.is_empty() {
        "Document.pdf".to_string()
    } else {
        format!("{stem}.pdf")
    }
}

/// Draw the window into `target`.
///
/// Windows answers with WebView2's silent writer. Everywhere else there is no
/// window this can be asked of, and the answer says so; the caller never takes
/// that path because it checks [`DIRECT`] first.
#[cfg(windows)]
pub async fn write(webview: tauri::Webview, target: PathBuf) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let path = target.to_string_lossy().to_string();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let failure = tx.clone();
    webview
        .with_webview(move |platform| {
            if let Err(error) = start(platform, path, tx) {
                let _ = failure.send(Err(error));
            }
        })
        .map_err(|e| format!("Couldn't reach the window: {e}"))?;

    // The print runs on the window's own thread; this one waits for its answer
    // without holding up the event loop the answer arrives on.
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(60)))
        .await
        .map_err(|e| format!("The PDF export was interrupted: {e}"))?;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("The PDF export took too long and was abandoned.".into()),
    }
}

#[cfg(not(windows))]
pub async fn write(_webview: tauri::Webview, _target: PathBuf) -> Result<(), String> {
    Err("This platform cannot write a PDF without the print dialog.".into())
}

/// Hand the page to WebView2, which draws it and reports back on `done`.
///
/// Runs on the window's thread, like every WebView2 call.
#[cfg(windows)]
fn start(
    platform: tauri::webview::PlatformWebview,
    path: String,
    done: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| format!("No page to print: {e}"))?;
    let writer: ICoreWebView2_7 = core
        .cast()
        .map_err(|_| "This WebView2 runtime cannot write a PDF.".to_string())?;

    // Backgrounds on: a callout's wash and a table's heading are part of the
    // page. No header and footer: the sheet is the document, not a browser
    // printout with a URL under it.
    let environment: ICoreWebView2Environment6 = platform
        .environment()
        .cast()
        .map_err(|_| "This WebView2 runtime cannot describe a page.".to_string())?;
    let settings = unsafe { environment.CreatePrintSettings() }
        .map_err(|e| format!("Couldn't set up the page: {e}"))?;
    unsafe {
        let _ = settings.SetShouldPrintBackgrounds(true);
        let _ = settings.SetShouldPrintHeaderAndFooter(false);
    }

    let handler = PrintToPdfCompletedHandler::create(Box::new(
        move |status: windows_core::Result<()>, written: bool| -> windows_core::Result<()> {
            let answer = match status {
                Ok(()) if written => Ok(()),
                Ok(()) => Err("The PDF was not written.".to_string()),
                Err(error) => Err(format!("Couldn't write the PDF: {error}")),
            };
            let _ = done.send(answer);
            Ok(())
        },
    ));
    unsafe { writer.PrintToPdf(&HSTRING::from(path), &settings, &handler) }
        .map_err(|e| format!("Couldn't start the PDF: {e}"))
}

#[cfg(test)]
mod tests {
    use super::file_name;

    #[test]
    fn a_title_becomes_a_file_name() {
        assert_eq!(file_name("Q3 plan"), "Q3 plan.pdf");
        assert_eq!(file_name("  Roadmap 2026  "), "Roadmap 2026.pdf");
        // The characters a path cannot hold become dashes; the rest is the
        // author's words, spaces and all.
        assert_eq!(file_name("Q3: plan?"), "Q3- plan-.pdf");
        assert_eq!(file_name("a/b\\c"), "a-b-c.pdf");
        // A title that already names a PDF is not given a second extension.
        assert_eq!(file_name("Invoice.pdf"), "Invoice.pdf");
        assert_eq!(file_name("Invoice.PDF"), "Invoice.PDF");
        // Nothing usable left: the document still needs a name.
        assert_eq!(file_name(""), "Document.pdf");
        assert_eq!(file_name("   "), "Document.pdf");
        assert_eq!(file_name("..."), "Document.pdf");
        assert_eq!(file_name("?!"), "-!.pdf");
    }

    #[test]
    fn a_long_title_is_cut_where_a_character_ends() {
        // 200 letters of two bytes each: the cut lands on 120 bytes of them, not
        // in the middle of one.
        let name = file_name(&"ק".repeat(200));
        assert!(name.ends_with(".pdf"));
        assert_eq!(name.trim_end_matches(".pdf").len(), 120);
        assert!(name.trim_end_matches(".pdf").chars().all(|c| c == 'ק'));

        let ascii = file_name(&"a".repeat(400));
        assert_eq!(ascii.trim_end_matches(".pdf").len(), 120);
    }
}
