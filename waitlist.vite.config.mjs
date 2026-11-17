import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repo = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("./waitlist", import.meta.url));
const ui = fileURLToPath(new URL("./packages/ui/src", import.meta.url));

export default defineConfig(({ command }) => {
  const env = {
    ...loadEnv("waitlist", repo, ["GOOGLE_", "WAITLIST_"]),
    ...process.env,
  };
  const developmentPreview =
    command === "serve" && env.WAITLIST_DEV_MODE === "true";
  return {
    root,
    envDir: repo,
    publicDir: "../public",
    resolve: {
      // The landing page shares the mark with the desktop apps.
      alias: { "@hook/ui": `${ui}/index.ts` },
    },
    plugins: [
      react(),
      {
        name: "hook-waitlist-api",
        async configureServer(server) {
          if (developmentPreview) {
            // Do not even open the signup database while previewing locally.
            server.middlewares.use("/api", (_req, res) => {
              res.statusCode = 503;
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ error: "dev_preview_no_persistence" }));
            });
            return;
          }
          const { default: express } = await import("express");
          const { createPlatform } = await import("./server/platform.mjs");
          const api = createPlatform(env);
          const app = express().disable("x-powered-by");
          app.use(api.router);
          server.middlewares.use("/api", app);
          server.httpServer?.once("close", api.close);
        },
      },
    ],
    server: {
      host: "localhost",
      port: 5173,
      strictPort: true,
      fs: { allow: [root, ui, `${repo}node_modules`] },
    },
    define: {
      "import.meta.env.VITE_WAITLIST_DEV_MODE":
        JSON.stringify(developmentPreview),
      "import.meta.env.VITE_WAITLIST_UNLIMITED_USAGE": JSON.stringify(
        loadEnv("waitlist", repo, "VITE_").VITE_WAITLIST_UNLIMITED_USAGE ??
          "false",
      ),
    },
    build: { outDir: "../dist-waitlist", emptyOutDir: true },
  };
});
