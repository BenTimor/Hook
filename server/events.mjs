import { json, Router } from "express";
import { planOf } from "./plans.mjs";
import { requireApiUser } from "./tokens.mjs";

/**
 * What the app did that the model proxy cannot see.
 *
 * `usage_events` records every request that comes through hookcode.io. A user
 * who brings their own endpoint never appears there, and neither does the free
 * limit refusing a turn or the cloud-sync switch being flipped. Those are the
 * facts product decisions depend on, so the app reports them as one of a small,
 * fixed set of kinds.
 *
 * The rule for this endpoint is that nothing about the user's words, files or
 * credentials is sent: the kind, the product, the app version and the plan in
 * force. Anything else is refused, and the client treats a failure as silence.
 */
const KINDS = new Set([
  // A personal OpenAI-compatible endpoint was saved or removed in this product.
  "byok_saved",
  "byok_removed",
  // A user message was answered by that endpoint rather than by Hook.
  "byok_turn",
  // The model list was fetched from a personal endpoint (whether or not it
  // returned anything; the app also records failures as this kind).
  "byok_models_loaded",
  // A free account was stopped by the 24-hour message limit.
  "quota_blocked",
  // A free account tried a coding agent without a personal endpoint.
  "coding_blocked_free",
  // The account-level cloud-sync switch.
  "sync_enabled",
  "sync_disabled",
]);

const PRODUCTS = new Set(["chat", "workspace", "mobile"]);

export function createEventsRouter({ db }) {
  const router = Router();
  router.use(json({ limit: "8kb" }));

  router.post("/", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const row = requireApiUser(db, req, res);
    if (!row) return;

    const kind = typeof req.body?.kind === "string" ? req.body.kind.trim() : "";
    if (!KINDS.has(kind))
      return res.status(400).json({ error: "invalid_kind" });
    const product = PRODUCTS.has(req.body?.product)
      ? req.body.product
      : "unknown";
    const version = req.get("x-hook-app-version");
    db.prepare(
      `INSERT INTO client_events (google_subject, kind, plan, product, app_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      row.google_subject,
      kind,
      planOf(row),
      product,
      typeof version === "string" ? version.trim().slice(0, 32) || null : null,
    );
    res.status(204).end();
  });

  return router;
}
