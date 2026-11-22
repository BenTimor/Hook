/**
 * Only an absolute web address or an embedded raster image is a document image.
 * The read view and the editor both go through here, so a document cannot make
 * the window load anything else.
 */
export function documentImageSource(source: string): string | undefined {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(source)) return source;
  try {
    const url = new URL(source);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // Only absolute web URLs and embedded raster images are supported.
  }
  return undefined;
}
