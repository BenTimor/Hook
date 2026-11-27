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
//!
//! A document leaves as one page as tall as the sheet, not as a stack of sheets
//! cut at the fold: the window measures the printed copy and hands its height
//! over ([`page_height`]), so the PDF reads the way the document scrolls in
//! Workspace. A sheet that cannot be one page of paper — an empty one, or one
//! longer than a PDF page can be — keeps the ordinary sheets.
//!
//! The page is white and nothing else: the window paints a background colour
//! behind its page and WebView2 paints it onto the paper too, so the bands
//! around the text used to arrive in Hook's warm canvas.

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

/// The width of the page a document is drawn on, in inches.
///
/// Ours rather than the runtime's, because the window measured the sheet at
/// this width (`apps/workspace/src/lib/pdf.ts`, `SHEET`): a page of another
/// width would be measured from a layout nobody will read.
#[cfg(windows)]
const PAGE_WIDTH_IN: f64 = 8.5;

/// The shortest page the writer is asked for, in inches.
///
/// A page shorter than this is not a sheet, it is a bug: the document would be
/// cut into thousands of slices, and Chromium's renderer gives up on that (the
/// window shows "This page is having a problem", `STATUS_BREAKPOINT`). It is a
/// floor rather than a clip so that a wrong number fails as ordinary pages
/// instead of a dead window — the same reason the ceiling is a refusal.
const MIN_PAGE_HEIGHT_IN: f64 = 1.0;

/// The tallest page a PDF can hold, in inches; the format's own limit is 200.
/// Past it the file would not open, so a sheet that long is paginated instead.
const MAX_PAGE_HEIGHT_IN: f64 = 200.0;

/// The height of the one page a sheet is drawn on, in inches.
///
/// `sheet` is what the window measured: the whole page, its margins included,
/// in inches — the unit the print settings speak. `None` means the writer
/// keeps its own sheets: there was nothing to measure, or the number is not a
/// page, and ordinary pages are always better than a dead renderer.
pub fn page_height(sheet: Option<f64>) -> Option<f64> {
    let inches = sheet.filter(|inches| inches.is_finite())?;
    (MIN_PAGE_HEIGHT_IN..=MAX_PAGE_HEIGHT_IN)
        .contains(&inches)
        .then_some(inches)
}

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

/// Draw the window into `target`, on one page `sheet` inches tall.
///
/// `sheet` is the height the window measured, margins included, in inches (see
/// [`page_height`]); `None` leaves the pages as the runtime makes them.
///
/// Windows answers with WebView2's silent writer. Everywhere else there is no
/// window this can be asked of, and the answer says so; the caller never takes
/// that path because it checks [`DIRECT`] first.
#[cfg(windows)]
pub async fn write(
    webview: tauri::Webview,
    target: PathBuf,
    sheet: Option<f64>,
) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let page = page_height(sheet);
    let path = target.to_string_lossy().to_string();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let failure = tx.clone();
    webview
        .with_webview(move |platform| {
            if let Err(error) = start(platform, path, page, tx) {
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
pub async fn write(
    _webview: tauri::Webview,
    _target: PathBuf,
    _sheet: Option<f64>,
) -> Result<(), String> {
    Err("This platform cannot write a PDF without the print dialog.".into())
}

/// Hand the page to WebView2, which draws it and reports back on `done`.
///
/// Runs on the window's thread, like every WebView2 call.
#[cfg(windows)]
fn start(
    platform: tauri::webview::PlatformWebview,
    path: String,
    page: Option<f64>,
    done: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_COLOR,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| format!("No page to print: {e}"))?;
    let writer: ICoreWebView2_7 = core
        .cast()
        .map_err(|_| "This WebView2 runtime cannot write a PDF.".to_string())?;

    // Backgrounds on: a callout's wash and a table's heading are part of the
    // page. No header and footer: the sheet is the document, not a browser
    // printout with a URL under it. The width is ours for the reason
    // `PAGE_WIDTH_IN` gives, and the height is the sheet the window measured —
    // one page for the whole document, unless it was handed `None`.
    let environment: ICoreWebView2Environment6 = platform
        .environment()
        .cast()
        .map_err(|_| "This WebView2 runtime cannot describe a page.".to_string())?;
    let settings = unsafe { environment.CreatePrintSettings() }
        .map_err(|e| format!("Couldn't set up the page: {e}"))?;
    unsafe {
        let _ = settings.SetShouldPrintBackgrounds(true);
        let _ = settings.SetShouldPrintHeaderAndFooter(false);
        let _ = settings.SetPageWidth(PAGE_WIDTH_IN);
        if let Some(height) = page {
            let _ = settings.SetPageHeight(height);
        }
    }

    // The window paints a colour behind its page, and WebView2 paints that
    // colour onto the paper as well: the bands around the text — the print
    // page's own margins — arrived in Hook's warm canvas instead of the white
    // a sheet is. It is painted over for the print and put back when the print
    // is done, so the window a person is looking at is untouched. Best effort:
    // a runtime too old to have the colour is not a reason to refuse the file.
    let paper = COREWEBVIEW2_COLOR { A: 255, R: 255, G: 255, B: 255 };
    let window = controller.cast::<ICoreWebView2Controller2>().ok();
    let previous = window.and_then(|window| {
        let mut previous = COREWEBVIEW2_COLOR::default();
        unsafe {
            window.DefaultBackgroundColor(&mut previous).ok()?;
            window.SetDefaultBackgroundColor(paper).ok()?;
        }
        Some((window, previous))
    });

    let handler = PrintToPdfCompletedHandler::create(Box::new({
        let previous = previous.clone();
        move |status: windows_core::Result<()>, written: bool| -> windows_core::Result<()> {
            if let Some((window, colour)) = previous {
                unsafe {
                    let _ = window.SetDefaultBackgroundColor(colour);
                }
            }
            let answer = match status {
                Ok(()) if written => Ok(()),
                Ok(()) => Err("The PDF was not written.".to_string()),
                Err(error) => Err(format!("Couldn't write the PDF: {error}")),
            };
            let _ = done.send(answer);
            Ok(())
        }
    }));
    let started = unsafe { writer.PrintToPdf(&HSTRING::from(path), &settings, &handler) };
    if started.is_err() {
        // No completion handler runs for a print that never started.
        if let Some((window, colour)) = previous {
            unsafe {
                let _ = window.SetDefaultBackgroundColor(colour);
            }
        }
    }
    started.map_err(|e| format!("Couldn't start the PDF: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{file_name, page_height};

    #[test]
    fn a_sheet_is_one_page_as_tall_as_it_is() {
        // Inches all the way through: the window measures the page in inches
        // (its margins are the stylesheet's millimetres) and the writer sets
        // them as they are.
        assert_eq!(page_height(Some(10.0)), Some(10.0));
        assert_eq!(page_height(Some(57.875656167979)), Some(57.875656167979));
    }

    #[test]
    fn the_page_keeps_its_sheets_when_it_cannot_be_one() {
        // Nothing to measure, or a number that is not one.
        assert_eq!(page_height(None), None);
        assert_eq!(page_height(Some(f64::NAN)), None);
        assert_eq!(page_height(Some(f64::INFINITY)), None);
        // A height measured in the wrong unit lands here — a 58-inch page sent
        // as 0.6 — and ordinary pages are the answer, never a renderer that
        // dies of ten thousand slices.
        assert_eq!(page_height(Some(0.6)), None);
        assert_eq!(page_height(Some(0.0)), None);
        assert_eq!(page_height(Some(-5.0)), None);
        // 200 inches is the longest page a PDF holds; a mile of it is not a
        // sheet anyone can read, so the writer paginates instead.
        assert_eq!(page_height(Some(200.0)), Some(200.0));
        assert_eq!(page_height(Some(200.001)), None);
    }

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
