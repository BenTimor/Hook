/**
 * A document on its way to a PDF.
 *
 * The page that gets written is the page the browser prints, so the export has
 * three steps and each one exists because skipping it writes a bad file:
 *
 * 1. the document is drawn once, on its own, into `.ws-print` — the editor's
 *    own buffer cannot be printed, because CodeMirror only has the lines it is
 *    showing on screen (`App.tsx` mounts it, `index.css` hides the window and
 *    shows only that element in the print media);
 * 2. that copy has to be laid out and its pictures decoded, or the PDF gets a
 *    heading with nothing under it;
 * 3. the window writes the file (`bridge.ts::exportPdf`). A platform with no
 *    silent writer falls back to the print dialog, where "Save as PDF" is the
 *    operating system's own choice.
 */

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
