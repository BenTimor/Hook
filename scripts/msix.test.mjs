import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const products = Object.values(PRODUCTS);

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
