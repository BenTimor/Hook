import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repo = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("./waitlist", import.meta.url));

export default defineConfig(() => ({
  root,
  envDir: repo,
  publicDir: "../public",
  plugins: [
    react(),
    {
      name: "hook-waitlist-api",
      async configureServer(server) {
        const { default: express } = await import("express");
        const { createWaitlistApi } = await import("./server/api.mjs");
        const env = { ...loadEnv("waitlist", repo, ["GOOGLE_", "WAITLIST_"]), ...process.env };
        const api = createWaitlistApi(env);
        const app = express().disable("x-powered-by");
        app.use(api.router);
        server.middlewares.use("/api/waitlist", app);
        server.httpServer?.once("close", api.close);
      },
    },
  ],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    fs: { allow: [root, `${repo}src/components`, `${repo}node_modules`] },
  },
  define: {
    "import.meta.env.VITE_WAITLIST_CTA": JSON.stringify(
      loadEnv("waitlist", repo, "VITE_").VITE_WAITLIST_CTA ?? "hook",
    ),
  },
  build: { outDir: "../dist-waitlist", emptyOutDir: true },
}));
