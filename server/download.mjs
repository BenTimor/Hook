import { existsSync } from "node:fs";
import { Router } from "express";
import { releaseFile, releaseInfo } from "./releases.mjs";
import { apiUser } from "./tokens.mjs";

function approvedAccount({ req, db, auth }) {
  // The website download uses the waitlist session cookie; the desktop app
  // can use its bearer token (for a future update check).
  const profile = auth.profileFor(req);
  if (profile) {
    return profile.waitlist_status === "approved"
      ? { row: profile }
      : {
          status: 403,
          code: "not_approved",
          message: "Hook is not enabled for this account yet.",
        };
  }
  return apiUser(db, req);
}

export function createDownloadRouter({ env, db, auth }) {
  const router = Router();

  router.get("/info", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const account = approvedAccount({ req, db, auth });
    if (!account.row)
      return res.status(account.status).json({
        error: {
          message: account.message,
          type: "invalid_request_error",
          code: account.code,
        },
      });
    res.json(releaseInfo(env));
  });

  router.get("/windows", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const account = approvedAccount({ req, db, auth });
    if (!account.row)
      return res.status(account.status).json({
        error: {
          message: account.message,
          type: "invalid_request_error",
          code: account.code,
        },
      });

    const file = releaseFile(env);
    if (!existsSync(file))
      return res.status(404).json({
        error: {
          message: "The Windows build is still being prepared. Try again shortly.",
          type: "invalid_request_error",
          code: "release_missing",
        },
      });

    // res.download handles Content-Length, ranges and HEAD for us.
    res.download(file, "Hook-setup.exe", {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return router;
}
