#!/usr/bin/env node
/**
 * Write the AppList icon set Windows uses for the taskbar, Start, search and
 * Alt-Tab.
 *
 * `tauri icon` produces the manifest's base icons but not the per-size
 * `targetsize-*` variants. Without them Windows draws the base icon on a
 * square "plate" filled with `uap:VisualElements/@BackgroundColor` — or the
 * user's accent colour when that is `transparent`. Hook's mark is a rounded
 * square, so the plate showed through its four transparent corners as a ring
 * in the accent colour (which is red on some machines).
 *
 * The variants are rendered from the same 512px master `tauri icon` uses, in
 * the three theme flavours the manifest's asset name owns:
 *
 *   Square44x44Logo.targetsize-<n>.png                    plated fallback
 *   Square44x44Logo.targetsize-<n>_altform-unplated.png   dark taskbar/Start
 *   Square44x44Logo.targetsize-<n>_altform-lightunplated.png  light taskbar/Start
 *
 * The names follow the `Square44x44Logo` attribute in `msix/<product>/AppxManifest.xml`;
 * rename that attribute and these must be renamed with it.
 *
 *   node scripts/msix-icons.mjs                  # every product
 *   node scripts/msix-icons.mjs --product chat
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { PRODUCTS, productFromArgs, root } from "./products.mjs";

const run = promisify(execFile);

/** Sizes Windows requests for the AppList icon (see Construct your app's icon). */
const SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];

/** Default, dark theme, light theme. The mark looks the same on both themes. */
const FORMS = ["", "_altform-unplated", "_altform-lightunplated"];

if (process.platform !== "win32") {
  throw new Error("MSIX icons are generated on Windows (System.Drawing); the MSIX is only built there.");
}

// `--product` is optional here: the default is every product, because both apps
// share the mark and a Store submission may be prepared for either.
const products =
  process.argv.includes("--product")
    ? [productFromArgs()]
    : Object.values(PRODUCTS);

/**
 * Resize in one PowerShell process rather than 42 per product. `SourceCopy`
 * keeps the alpha channel instead of compositing onto a white background, and
 * the bitmap is created as 32bpp ARGB so the rounded corners stay transparent.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$master = [System.Drawing.Image]::FromFile($env:MSIX_ICON_MASTER)
try {
  foreach ($size in ${SIZES.join(",")}) {
    $bitmap = [System.Drawing.Bitmap]::new(
      $size,
      $size,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($master, 0, 0, $size, $size)
    } finally {
      $graphics.Dispose()
    }
    foreach ($form in @(${FORMS.map((form) => `'${form}'`).join(",")})) {
      $name = "Square44x44Logo.targetsize-$size$form.png"
      $bitmap.Save(
        (Join-Path $env:MSIX_ICON_ASSETS $name),
        [System.Drawing.Imaging.ImageFormat]::Png
      )
    }
    $bitmap.Dispose()
  }
} finally {
  $master.Dispose()
}
`;

for (const product of products) {
  const icons = join(root, product.dir, "src-tauri", "icons");
  const master = join(icons, "icon.png");
  if (!existsSync(master)) {
    throw new Error(`${master} is missing from the Tauri icon set.`);
  }

  await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
    {
      windowsHide: true,
      env: {
        ...process.env,
        MSIX_ICON_MASTER: master,
        MSIX_ICON_ASSETS: icons,
      },
    },
  );
  console.log(
    `${product.name}: ${SIZES.length * FORMS.length} AppList icons in ${icons}`,
  );
}
