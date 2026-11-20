import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRODUCTS, root } from "./products.mjs";

/**
 * MSIX never services a package that is in use. Without `defer`, a Store update
 * that finds the app running fails with ERROR_PACKAGES_IN_USE (0x80073D02) and
 * the Store only offers "try again" — the bug `pnpm app:msix` was shipped with.
 * The element lives in `<Properties>`, and the namespace has to be ignorable so
 * Windows versions that predate it (before Windows 11 24H2) still parse the
 * manifest.
 */
const UAP17 = "http://schemas.microsoft.com/appx/manifest/uap/windows10/17";

function manifestFor(product) {
  return readFileSync(join(root, product.msix, "AppxManifest.xml"), "utf8");
}

function propertiesOf(xml) {
  const match = xml.match(/<Properties>[\s\S]*?<\/Properties>/);
  assert.ok(match, "AppxManifest.xml has no <Properties> block");
  return match[0];
}

// Only a desktop product is packaged as MSIX. A phone build has no Partner
// Center identity and no `msix/<id>/` folder; the stores own that pipeline.
const products = Object.values(PRODUCTS).filter((product) => product.kind === "desktop");

test("every product defers Store updates while the app is in use", () => {
  for (const product of products) {
    const xml = manifestFor(product);
    assert.match(
      xml,
      new RegExp(`xmlns:uap17="${UAP17}"`),
      `${product.msix} does not declare the uap17 namespace`,
    );
    const ignorable =
      xml.match(/IgnorableNamespaces="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    assert.ok(
      ignorable.includes("uap17"),
      `${product.msix} does not list uap17 in IgnorableNamespaces`,
    );
    assert.match(
      propertiesOf(xml),
      /<uap17:UpdateWhileInUse>defer<\/uap17:UpdateWhileInUse>/,
      `${product.msix} does not defer updates while in use`,
    );
  }
});

test("every placeholder in a template is one the packager fills", () => {
  const script = readFileSync(join(root, "scripts/build-msix.mjs"), "utf8");
  const filled = new Set(
    [...script.matchAll(/replaceAll\("\{\{(\w+)\}\}"/g)].map((match) => match[1]),
  );
  for (const product of products) {
    const used = new Set(
      [...manifestFor(product).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]),
    );
    const unfilled = [...used].filter((name) => !filled.has(name));
    assert.deepEqual(
      unfilled,
      [],
      `${product.msix} has placeholders build-msix.mjs never replaces`,
    );
  }
});

/**
 * A packaged app's taskbar/Start icon is drawn on a square "plate" filled with
 * uap:VisualElements/@BackgroundColor unless the package carries per-size,
 * unplated AppList variants. "transparent" resolves to the user's accent
 * colour, and because Hook's mark is a rounded square the plate showed through
 * its corners — a red ring on a red-accent machine. Keep both halves of the
 * fix: a real colour in the manifest and the generated asset set next to the
 * icon the manifest points at.
 */
const APPS_LIST_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const APPS_LIST_FORMS = ["", "_altform-unplated", "_altform-lightunplated"];

function pngSize(path) {
  const bytes = readFileSync(path);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${path} is not a PNG`,
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the taskbar icon never sits on an accent-coloured plate", () => {
  for (const product of products) {
    const xml = manifestFor(product);
    const background = xml.match(/BackgroundColor="([^"]+)"/)?.[1];
    assert.ok(background, `${product.msix} has no VisualElements BackgroundColor`);
    assert.notEqual(
      background.toLowerCase(),
      "transparent",
      `${product.msix} lets the user's accent colour plate the taskbar icon`,
    );

    const base = xml.match(/Square44x44Logo="Assets\\([^"]+)\.png"/)?.[1];
    assert.ok(base, `${product.msix} does not name Square44x44Logo under Assets\\`);
    for (const size of APPS_LIST_SIZES) {
      for (const form of APPS_LIST_FORMS) {
        const icon = join(
          root,
          product.dir,
          "src-tauri/icons",
          `${base}.targetsize-${size}${form}.png`,
        );
        assert.ok(
          existsSync(icon),
          `${product.dir} is missing ${base}.targetsize-${size}${form}.png; run \`pnpm msix:icons\``,
        );
        const { width, height } = pngSize(icon);
        assert.deepEqual(
          { width, height },
          { width: size, height: size },
          `${icon} is not ${size}x${size}`,
        );
      }
    }
  }
});
