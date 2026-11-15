import { Router } from "express";
import { createWaitlistApi } from "./api.mjs";
import { createAuthRouter } from "./auth.mjs";
import { createProxyRouter } from "./deepseek.mjs";
import { createDownloadRouter } from "./download.mjs";

/**
 * The whole hookcode.io API: existing waitlist routes, desktop device login,
 * the approval-gated Windows download, and the DeepSeek proxy. Everything is
 * mounted under `/api` so Caddy has one upstream rule.
 */
export function createPlatform(env) {
  const waitlist = createWaitlistApi(env);
  const router = Router();

  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });

  router.use("/waitlist", waitlist.router);

  if (!waitlist.db) {
    // Local development without Google credentials keeps the landing page
    // browsable; the model/login surface is simply unavailable.
    const unavailable = (_req, res) => res.status(503).json({ error: "unavailable" });
    router.use("/auth", unavailable);
    router.use("/download", unavailable);
    router.use("/v1", unavailable);
  } else {
    router.use(
      "/auth",
      createAuthRouter({ db: waitlist.db, auth: waitlist.auth }),
    );
    router.use(
      "/download",
      createDownloadRouter({ env, db: waitlist.db, auth: waitlist.auth }),
    );
    router.use(
      "/v1",
      createProxyRouter({ env, db: waitlist.db }),
    );
  }

  router.use((_req, res) => res.status(404).json({ error: "not_found" }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid_json" });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "too_large" });
    console.error("Hook API: request failed.", error.message);
    res.status(500).json({ error: "failed" });
  });

  return { router, close: waitlist.close };
}
