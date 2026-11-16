import { Router } from "express";
import { releaseFile, releaseIndex, releaseInfo } from "./releases.mjs";
import { apiUser } from "./tokens.mjs";

function approvedAccount({ req, db, auth }) {
  // The website download uses the waitlist session cookie; the desktop app
  // uses its bearer token for the in-app update check and installer download.
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

function refuse(res, account) {
  return res.status(account.status).json({
    error: {
      message: account.message,
      type: "invalid_request_error",
      code: account.code,
    },
  });
}

export function createDownloadRouter({ env, db, auth }) {
  const router = Router();

  router.get("/info", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const account = approvedAccount({ req, db, auth });
    if (!account.row) return refuse(res, account);
    res.json(releaseInfo(env));
  });

  // `?version=` pins an exact build; without it the newest one is served. The
  // version is resolved against the published index, so a request that names
  // a missing build fails instead of quietly installing a different one.
  router.get("/windows", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const account = approvedAccount({ req, db, auth });
    if (!account.row) return refuse(res, account);

    const requested =
      typeof req.query.version === "string" ? req.query.version : null;
    const file = releaseFile(env, requested);
    if (!file) {
      return res.status(404).json({
        error: {
          message: requested
            ? `Hook ${requested} is not available for download.`
            : "The Windows build is still being prepared. Try again shortly.",
          type: "invalid_request_error",
          code: requested ? "unknown_version" : "release_missing",
        },
      });
    }

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

/** Public JSON: version history plus the oldest version still supported. */
export function publicReleaseInfo(env) {
  const index = releaseIndex(env);
  return {
    latest: index.latest,
    minimum: index.minimum,
    updatedAt: index.updatedAt,
    // The installer URL itself still requires an approved account; the version
    // list is public so the app can check for updates before signing in.
    releases: index.releases.map((release) => ({
      version: release.version,
      size: release.size,
      sha256: release.sha256,
      commit: release.commit,
      builtAt: release.builtAt,
      notes: release.notes,
      sourceHash: release.sourceHash,
      url: release.url,
    })),
  };
}
