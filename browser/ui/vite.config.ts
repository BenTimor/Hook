/**
 * Builds the Hook chat panel into the overlay's resources.
 *
 * The output is a pair of static files (`panel.mjs`, `panel.css`) that
 * `browser/overlay/src/hook/resources/BUILD.gn` packs into `hook_resources.pak`,
 * because Chromium's WebUI build compiles Lit and TypeScript, not React, and a
 * prebuilt bundle is the one way to ship the same React surface the desktop apps
 * use.
 *
 * One bundle, two mounts: `panel.mjs` exports the dock's mount and the sign-in
 * card's. A second entry would make Vite split the shared React runtime into a
 * chunk file the pak would have to carry too; one file with both mounts keeps
 * `chrome://hook` addressable by a stable path, which is what a WebUI resource
 * needs.
 *
 * Run it from the repository root: `pnpm browser:ui`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fold the extracted stylesheet back into the module.
 *
 * Chromium's WebUI build lints every `.css` file it packs against its own
 * stylelint config; our tokens and the dock's stylesheet are hand-authored in
 * this repository and have no reason to pass it, and 1977 lint errors are not a
 * useful gate on a prebuilt bundle. Inlining the CSS keeps each `.mjs` the only
 * file the pak has to carry, and the styles land before React mounts because the
 * snippet runs first.
 */
function inlineCss(): Plugin {
  return {
    name: "hook-inline-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      let css = "";
      for (const [name, output] of Object.entries(bundle)) {
        if (output.type === "asset" && output.fileName.endsWith(".css")) {
          css += String(output.source);
          delete bundle[name];
        }
      }
      if (!css) return;
      const inject =
        `(() => {\n  const style = document.createElement("style");\n` +
        `  style.textContent = ${JSON.stringify(css)};\n` +
        `  document.head.append(style);\n})();\n`;
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && output.isEntry) {
          output.code = inject + output.code;
        }
      }
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), inlineCss()],
  // Library mode does not substitute `process.env.NODE_ENV` the way an app
  // build does, and React reads it: without this the bundle throws
  // "process is not defined" the moment it loads in a WebUI (there is no
  // Node `process` in the browser). Production, because a dev build of the
  // fork has no use for React's development warnings.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    // The workspace packages are not dependencies of a package in this
    // directory, so point Vite at the sources the apps compile too. Anchored
    // regexes, because `@hook/ui` would otherwise swallow
    // `@hook/ui/tokens.css` and ask for `index.ts/tokens.css`.
    alias: [
      {
        find: /^@hook\/ui\/tokens\.css$/,
        replacement: resolve(here, "../../packages/ui/src/tokens.css"),
      },
      { find: /^@hook\/chat$/, replacement: resolve(here, "../../packages/chat/src/index.ts") },
      {
        find: /^@hook\/markdown$/,
        replacement: resolve(here, "../../packages/markdown/src/index.ts"),
      },
      { find: /^@hook\/ui$/, replacement: resolve(here, "../../packages/ui/src/index.ts") },
      // See shiki-stub.ts: the web bundle would ship every grammar and theme as
      // its own chunk file inside our pak.
      { find: /^shiki\/bundle\/web$/, replacement: resolve(here, "shiki-stub.ts") },
      // `packages/ui` and `packages/chat` import Tauri lazily; there is no Tauri
      // in a browser process, and a stub keeps a second copy out of the pak.
      { find: /^@tauri-apps\/api\/core$/, replacement: resolve(here, "tauri-stub.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: resolve(here, "tauri-stub.ts") },
    ],
  },
  build: {
    // The build's GN action passes a path: the bundle is generated, not committed
    // (see `browser/tools/bundle.mjs`). Running `pnpm browser:ui` by hand still
    // lands it in the overlay, for a dev tree that wants to look at it.
    outDir:
      process.env.HOOK_BUNDLE_OUT ?? resolve(here, "../overlay/src/hook/resources"),
    emptyOutDir: false,
    cssCodeSplit: false,
    // Minified: the bundle is committed, so its size is a repository cost.
    // Unminified it is 2.7 MB, ten times the largest file in the repo.
    minify: true,
    lib: {
      entry: resolve(here, "panel.tsx"),
      formats: ["es"],
      fileName: () => "panel.mjs",
    },
    rollupOptions: {
      output: {
        assetFileNames: "panel.[ext]",
        // One file, always: a dynamic import that Vite resolves locally would
        // otherwise emit a chunk, and the pak carries exactly one script. The
        // page's own runtime import of `hook.mojom-webui.js` is left alone by
        // `@vite-ignore`, so it is not code-split.
        inlineDynamicImports: true,
      },
    },
  },
});
