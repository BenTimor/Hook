import { Router } from "express";
import { createWaitlistApi } from "./api.mjs";
import { createAuthRouter } from "./auth.mjs";
import { createProxyRouter } from "./deepseek.mjs";
import { createDownloadRouter, publicReleaseInfo } from "./download.mjs";
import { createEventsRouter } from "./events.mjs";
import { createGitRouter } from "./git.mjs";
import { createReportsRouter } from "./reports.mjs";
import { createSyncRouter } from "./sync.mjs";
import { createWorkspaceRouter } from "./workspace.mjs";

/**
 * The whole hookcode.io API: waitlist routes, desktop device login, private git
 * for coding agents, conversation sync, the approval-gated Windows download and
 * the DeepSeek proxy. Everything is mounted under `/api` so Caddy has one
 * upstream rule.
 *
 * `options.verifyGoogle` replaces the real ID-token check. Only tests use it:
 * verifying a token means fetching Google's certificates, which a test suite
 * must not do.
 */
export function createPlatform(env, { verifyGoogle } = {}) {
  const waitlist = createWaitlistApi(env, { verifyGoogle });
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

  // Version history is public: the desktop app checks it before it has a
  // session, and the installer it then asks for still needs an approved
  // account. Keeping it outside the OAuth branch means a database-less local
  // preview can still answer honestly (`releases: []`).
  router.get("/releases", (_req, res) => {
    res.json(publicReleaseInfo(env));
  });

  // One index per product: a product with no published build answers 404, which
  // the release gate reads as "release everything".
  router.get("/releases/:product", (req, res) => {
    const info = publicReleaseInfo(env, req.params.product);
    if (!info) {
      return res.status(404).json({ error: "unknown_product" });
    }
    res.json(info);
  });

  if (!waitlist.db) {
    // Local development without Google credentials keeps the landing page
    // browsable; the model/login surface is simply unavailable.
    const unavailable = (_req, res) => res.status(503).json({ error: "unavailable" });
    router.use("/auth", unavailable);
    router.use("/download", unavailable);
    router.use("/git", unavailable);
    router.use("/sync", unavailable);
    router.use("/v1", unavailable);
  } else {
    router.use(
      "/auth",
      createAuthRouter({ db: waitlist.db, auth: waitlist.auth }),
    );
    // Git is mounted before any JSON body parser: pushes are binary streams.
    router.use("/git", createGitRouter({ env, db: waitlist.db }));
    router.use(
      "/sync",
      createSyncRouter({ env, db: waitlist.db }),
    );
    // Hook Workspace: projects, boards, tasks, documents and their people. The
    // chat agent talks to the same routes, so the product works without this
    // app installed.
    router.use(
      "/ws",
      createWorkspaceRouter({ env, db: waitlist.db }).router,
    );
    router.use(
      "/download",
      createDownloadRouter({ env, db: waitlist.db, auth: waitlist.auth }),
    );
    router.use(
      "/v1",
      createProxyRouter({ env, db: waitlist.db }),
    );
    router.use(
      "/reports",
      createReportsRouter({ db: waitlist.db, auth: waitlist.auth }),
    );
    // The facts the proxy cannot see: personal-endpoint turns, the free limit
    // refusing one, and the account's cloud-sync switch.
    router.use("/events", createEventsRouter({ db: waitlist.db }));
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
