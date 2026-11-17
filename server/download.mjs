import { existsSync } from "node:fs";
import { join } from "node:path";

import { Router } from "express";
import {
  productIndexName,
  releaseDir,
  releaseFile,
  releaseIndex,
  releaseInfo,
} from "./releases.mjs";
import { approvedRequest } from "./tokens.mjs";

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
    const account = approvedRequest({ req, db, auth });
    if (!account.row) return refuse(res, account);
    res.json(releaseInfo(env));
  });

  // `?version=` pins an exact build; without it the newest one is served. The
  // version is resolved against the published index, so a request that names
  // a missing build fails instead of quietly installing a different one.
  router.get("/windows", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const account = approvedRequest({ req, db, auth });
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
export function publicReleaseInfo(env, product = "chat") {
  const name = productIndexName(product);
  if (!name) return null;
  // A product that has never shipped has no index: answer 404 rather than an
  // empty release list that would look like "no update available". The chat app
  // is the exception: its historical single-slot layout has no releases.json and
  // still has to answer.
  if (product !== "chat" && !existsSync(join(releaseDir(env), name))) return null;
  const index = releaseIndex(env, product);
  return {
    latest: index.latest,
    minimum: index.minimum,
    // The Microsoft Store channel has its own latest/floor because Store
    // certification lags behind direct builds.
    store: index.store,
    updatedAt: index.updatedAt,
    // The installer URL itself still requires an approved account; the version
    // list is public so the app can check for updates before signing in.
    releases: index.releases.map((release) => ({
      version: release.version,
      // The release tooling merges the published history back into a new
      // index; without the file name it cannot keep old installers.
      file: release.file,
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
