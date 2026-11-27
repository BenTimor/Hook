#!/usr/bin/env node
/**
 * What a product is, and which files decide what ships in its installer.
 *
 * Hook is an ecosystem of desktop products that share one account, one design
 * system and one backend crate. Each product has its own installer, its own
 * version and its own release slot, so every build/release script takes a
 * product id instead of assuming the chat app is the only app in the repo.
 *
 *   node scripts/app-source-hash.mjs                 # the chat app (default)
 *   node scripts/app-source-hash.mjs --product workspace
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Products that produce an installer. Keys are the ids used on the CLI. */
export const PRODUCTS = {
  chat: {
    id: "chat",
    /** Directory holding package.json, index.html and src-tauri. */
    dir: "apps/chat",
    /** Human name, used in logs and the installer filename. */
    name: "Hook",
    /** Executable name inside target/release. */
    binary: "Hook",
    /** Tauri bundle identifier — also the %APPDATA% folder name. */
    identifier: "app.hook.chat",
    /** MSIX partner-centre folder. */
    msix: "msix/chat",
    /** How this product reaches a user. */
    kind: "desktop",
  },
  workspace: {
    id: "workspace",
    dir: "apps/workspace",
    name: "Hook Workspace",
    binary: "Hook Workspace",
    identifier: "app.hook.workspace",
    msix: "msix/workspace",
    kind: "desktop",
  },
  /**
   * Hook on a phone. It is a Hook product in the business sense — same
   * account, same conversations, same Workspace — but not a desktop installer:
   * App Store Connect and the Play Console distribute it, and
   * `scripts/release.sh` deliberately leaves it out of its default product
   * list. The source hash still covers it, so a shared-package change that
   * would alter a phone build is visible in the same place as the rest.
   */
  mobile: {
    id: "mobile",
    dir: "apps/mobile",
    name: "Hook",
    binary: "Hook",
    identifier: "app.hook.mobile",
    kind: "mobile",
  },
};

/** Resolve `--product <id>` (default: chat) and return its descriptor. */
export function productFromArgs(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--product");
  const id = index >= 0 ? argv[index + 1] : "chat";
  const product = PRODUCTS[id];
  if (!product) {
    throw new Error(
      `unknown product "${id}" — expected one of: ${Object.keys(PRODUCTS).join(", ")}`,
    );
  }
  return product;
}

/**
 * Everything that changes the bytes of this product's installer, relative to
 * the repo root. Shared packages and the shared backend crate appear in every
 * product: a change there changes every app that links it.
 */
export function appInputs(product) {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "harness.config.ci.toml",
    "public/favicon.svg",
    "crates/hook-core",
    "packages/ui",
    "packages/chat",
    `${product.dir}/index.html`,
    `${product.dir}/vite.config.ts`,
    `${product.dir}/tsconfig.json`,
    `${product.dir}/package.json`,
    `${product.dir}/src`,
    `${product.dir}/src-tauri/Cargo.toml`,
    `${product.dir}/src-tauri/build.rs`,
    `${product.dir}/src-tauri/tauri.conf.json`,
    // The chat app's platform configs override the base one (bundle targets, the
    // macOS window and the Windows-only git resource), so a change there changes
    // the build. Other products do not have them yet.
    ...(product.id === "chat"
      ? [
          `${product.dir}/src-tauri/tauri.windows.conf.json`,
          `${product.dir}/src-tauri/tauri.macos.conf.json`,
        ]
      : []),
    `${product.dir}/src-tauri/capabilities`,
    `${product.dir}/src-tauri/icons`,
    `${product.dir}/src-tauri/src`,    "scripts/app-source-hash.mjs",
    "scripts/fetch-git.mjs",
    "scripts/fetch-pi-runtime.mjs",
    "scripts/products.mjs",
  ];
}

/**
 * Paths inside `appInputs` that are not part of the shipped bytes. Tests run in
 * CI but never enter an executable or an installer, so editing one must not
 * demand a version bump and a rebuild of every product that links the crate.
 */
export function appExcludes() {
  return ["crates/hook-core/tests"];
}

/** Absolute path inside a product directory. */
export function productPath(product, ...parts) {
  return resolve(root, product.dir, ...parts);
}

/** Cargo target directory (one workspace at the repo root). */
export const targetDir = resolve(root, "target");
