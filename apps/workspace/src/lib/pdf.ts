/**
 * A document on its way to a PDF.
 *
 * The page that gets written is the page the browser prints, so the export has
 * four steps and each one exists because skipping it writes a bad file:
 *
 * 1. the document is drawn once, on its own, into `.ws-print` — the editor's
 *    own buffer cannot be printed, because CodeMirror only has the lines it is
 *    showing on screen (`App.tsx` mounts it, `index.css` hides the window and
 *    shows only that element in the print media);
 * 2. that copy has to be laid out and its pictures decoded, or the PDF gets a
 *    heading with nothing under it;
 * 3. the same copy is laid out again at the width the page will give it, to
 *    learn how tall one page has to be to hold the whole document — the sheet
 *    leaves as one long page, the way it scrolls in Workspace, instead of a
 *    stack of sheets cut at the fold (`pageHeightIn`);
 * 4. the window writes the file (`bridge.ts::exportPdf`), at that height,
 *    which is one page's height in inches. A platform with no silent writer
 *    falls back to the print dialog, where "Save as PDF" is the operating
 *    system's own choice — and where the sheets are its own too, because a
 *    dialog cannot be told how tall a page is.
 */

/** CSS pixels in an inch: paper is measured in inches, a window in pixels. */
const PX_PER_INCH = 96;
const MM_PER_INCH = 25.4;

/**
 * The paper the writer draws, in the units paper comes in.
 *
 * One page, as tall as the document — so `widthIn` is the page's width and
 * nothing else is fixed. The margins are `@page`'s in
 * `apps/workspace/src/styles/index.css` (`margin: 18mm 16mm`), and the three
 * have to agree: the writer is told this width, the window measures the sheet
 * at this width minus the margins, and the page's height is the measurement
 * plus the margins back. `crates/hook-core/src/pdf.rs` keeps the same width and
 * its own limits on the height.
 */
export const SHEET = {
  widthIn: 8.5,
  marginBlockMm: 18,
  marginInlineMm: 16,
} as const;

/** Two frames: the print copy is in the page and has been laid out. */
export function laidOut(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

/**
 * Every picture in the print copy has finished loading.
 *
 * The copy is off the page until the print media applies, so its own `<img>`
 * elements have not been asked to paint; this fetches each one into the cache
 * the print is about to read from. A picture that never arrives is not worth
 * holding the export for — the document still goes out without it.
 */
export async function picturesReady(selector = ".ws-print img", timeout = 4000): Promise<void> {
  const sources = Array.from(document.querySelectorAll(selector))
    .map((image) => image.getAttribute("src") ?? "")
    .filter(Boolean);
  if (sources.length === 0) return;
  const loaded = sources.map(
    (source) =>
      new Promise<void>((resolve) => {
        const picture = new Image();
        picture.referrerPolicy = "no-referrer";
        picture.onload = () => resolve();
        picture.onerror = () => resolve();
        picture.src = source;
      }),
  );
  await Promise.race([
    Promise.all(loaded),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeout)),
  ]);
}

/** The column the sheet's words get on paper, in CSS pixels. */
function sheetContentWidth(): number {
  return (SHEET.widthIn - (2 * SHEET.marginInlineMm) / MM_PER_INCH) * PX_PER_INCH;
}

/**
 * The height of the one page that holds the whole sheet, in inches.
 *
 * Inches, because that is what the writer is told and what paper is measured
 * in (`pdf.rs::page_height`); the measurement itself is the only part that
 * knows about pixels, and the stylesheet's margins are the only part that
 * knows about millimetres.
 *
 * The copy is `display: none` on screen and a hidden box has no height, so it
 * is laid out off screen — `.ws-print[data-measure]` in the stylesheet — at
 * exactly the width the page will give it. That is the only layout that
 * measures what the writer is about to draw, which is why the print copy's own
 * rules (a picture's cap, a code sample's overflow) are not inside the print
 * media.
 *
 * `null` means "no single page": there was nothing on the sheet to measure, so
 * the writer keeps its sheets.
 */
export async function pageHeightIn(sheet: HTMLElement): Promise<number | null> {
  sheet.dataset.measure = "";
  sheet.style.width = `${sheetContentWidth()}px`;
  try {
    await laidOut();
    const content = Math.ceil(sheet.getBoundingClientRect().height);
    if (content <= 0) return null;
    // The page is the sheet plus the paper above and below it. A few pixels
    // spare: a page one rounding error too short becomes a second page holding
    // nothing, and trailing white is the cheaper mistake.
    return content / PX_PER_INCH + (2 * SHEET.marginBlockMm) / MM_PER_INCH + 4 / PX_PER_INCH;
  } finally {
    delete sheet.dataset.measure;
    sheet.style.removeProperty("width");
  }
}

/**
 * Open the system print dialog and resolve once it is done with the page.
 *
 * `afterprint` is the reliable half of Chromium's pair, but a runtime that
 * never fires it must not hold the print copy open for the rest of the
 * session, so the wait is bounded.
 */
export function printDialog(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("afterprint", done);
      resolve();
    };
    window.addEventListener("afterprint", done);
    window.setTimeout(done, 5000);
    window.print();
  });
}
