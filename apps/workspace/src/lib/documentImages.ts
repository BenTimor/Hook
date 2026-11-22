import { documentImageSource } from "@hook/markdown";

export { documentImageSource };

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EMBEDDED_BYTES = 180 * 1024;
const rasterType = /^image\/(?:png|jpeg|gif|webp)$/;

/** Keep images small enough to share through the existing Markdown sync. */
export async function embedDocumentImage(file: File): Promise<string> {
  if (!rasterType.test(file.type) || file.size > MAX_FILE_BYTES) {
    throw new Error("Choose a PNG, JPEG, GIF, or WebP image under 20 MB.");
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("This image could not be read.");
  });
  try {
    if (file.size <= MAX_EMBEDDED_BYTES) {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("This image could not be read."));
        reader.readAsDataURL(file);
      });
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This image could not be resized.");
    for (const maxSide of [1280, 960, 640, 480]) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/webp", 0.8);
      if (data.length <= MAX_EMBEDDED_BYTES * 4 / 3 && documentImageSource(data)) return data;
    }
    throw new Error("This image is too large to embed. Try a smaller file or use a link.");
  } finally {
    bitmap.close();
  }
}
