import { randomBytes } from "node:crypto";
import { Router, json } from "express";
import { remoteRefusal } from "./plans.mjs";
import { apiUser } from "./tokens.mjs";

/**
 * Remote previews: the account service is the middleman between a viewer and
 * the machine that serves the page.
 *
 * A preview is a page from the host's loopback server. The host cannot accept
 * an inbound connection (home NAT, corporate Wi-Fi, cloud NAT), so it asks for
 * nothing: it already holds an outbound WebSocket to the relay. This module
 * mints a short-lived ticket on a per-session subdomain and tunnels each HTTP
 * request over that socket.
 *
 * Why a subdomain: a page that uses `/assets/app.js` must resolve that path at
 * the preview root, and the page must not share hookcode.io's origin. A path
 * prefix breaks absolute URLs and puts untrusted HTML on the site's origin.
 *
 * The ticket is bound to (account, machine, chat). It is random, expires, and
 * only grants access to the host's *active* preview for that chat.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY = 4 * 1024 * 1024;
const HOST_SUFFIX = ".preview.hookcode.io";
const TICKET = /^[a-f0-9]{32}$/;

function refuse(res, status, code, message) {
  res.status(status).json({
    error: { message, type: "invalid_request_error", code },
  });
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createPreviewTunnel({ db, presence }) {
  /** ticket -> { subject, deviceId, chatId, expires } */
  const tickets = new Map();
  /** request id -> { res, timer, method } */
  const waiting = new Map();

  function prune() {
    const now = Date.now();
    for (const [ticket, entry] of tickets) {
      if (entry.expires <= now) tickets.delete(ticket);
    }
  }

  const router = Router();
  router.use(json({ limit: "8kb" }));

  router.post("/ticket", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const result = apiUser(db, req);
    if (!result.row)
      return refuse(res, result.status, result.code, result.message);
    const refusal = remoteRefusal(result.row);
    if (refusal) return refuse(res, 403, refusal.code, refusal.message);

    const deviceId = clean(req.body?.deviceId, 64);
    const chatId = clean(req.body?.chatId, 160);
    const file = clean(req.body?.file, 400);
    if (!deviceId || !chatId || !file)
      return refuse(
        res,
        400,
        "bad_ticket",
        "A preview ticket needs a machine, a chat and a file.",
      );
    if (file.startsWith("/") || file.split("/").includes(".."))
      return refuse(res, 400, "bad_ticket", "That preview path is not valid.");

    const device = db
      .prepare(
        "SELECT can_host, remote_allowed FROM devices WHERE google_subject = ? AND device_id = ?",
      )
      .get(result.row.google_subject, deviceId);
    if (!device || !device.can_host)
      return refuse(res, 404, "unknown_device", "That machine cannot show a preview.");
    if (!device.remote_allowed)
      return refuse(
        res,
        403,
        "remote_disabled",
        "That machine does not accept remote work.",
      );
    const host = presence.host(result.row.google_subject, deviceId);
    if (!host)
      return refuse(
        res,
        409,
        "device_offline",
        "That machine is not running Hook right now.",
      );

    prune();
    const ticket = randomBytes(16).toString("hex");
    const expires = Date.now() + TTL_MS;
    tickets.set(ticket, {
      subject: result.row.google_subject,
      deviceId,
      chatId,
      expires,
    });

    const path = file.split("/").map(encodeURIComponent).join("/");
    const url = `https://${ticket}${HOST_SUFFIX}/${path}`;
    res.json({ url, expiresAt: new Date(expires).toISOString() });
  });

  /**
   * Every request on a `*.preview.hookcode.io` host. Mounted before the site's
   * static handler; a request for any other host falls through untouched.
   */
  function middleware(req, res, next) {
    const hostName = String(req.headers.host ?? "").toLowerCase();
    if (!hostName.endsWith(HOST_SUFFIX)) return next();
    const ticket = hostName.slice(0, -HOST_SUFFIX.length);
    if (!TICKET.test(ticket)) return res.status(404).end("Not found");
    const entry = tickets.get(ticket);
    if (!entry || entry.expires <= Date.now())
      return res.status(410).end("This preview link has expired.");
    if (req.method !== "GET" && req.method !== "HEAD")
      return res.status(405).end("Method not allowed");

    const host = presence.host(entry.subject, entry.deviceId);
    if (!host)
      return res.status(503).end("That machine is not connected right now.");

    const id = randomBytes(12).toString("hex");
    const timer = setTimeout(() => {
      waiting.delete(id);
      if (!res.headersSent) res.status(504).end("The machine did not answer.");
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    waiting.set(id, { res, timer, method: req.method });
    const path = String(req.url ?? "/").split("?")[0] || "/";
    host.send({
      kind: "previewRequest",
      id,
      chatId: entry.chatId,
      method: req.method,
      path,
    });
  }

  /** A host answered a preview request. Returns false for an unknown id. */
  function accept(_conn, frame) {
    const entry = waiting.get(frame.id);
    if (!entry) return false;
    waiting.delete(frame.id);
    clearTimeout(entry.timer);
    const { res } = entry;
    if (res.headersSent) return true;

    const body = Buffer.from(
      typeof frame.body === "string" ? frame.body : "",
      "base64",
    );
    if (body.length > MAX_BODY) {
      res.status(413).end("That preview file is too large.");
      return true;
    }
    const status =
      Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599
        ? frame.status
        : 200;
    res.status(status);
    res.set("Content-Type", frame.contentType || "application/octet-stream");
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    if (entry.method === "HEAD") res.end();
    else res.end(body);
    return true;
  }

  function close() {
    for (const entry of waiting.values()) clearTimeout(entry.timer);
    waiting.clear();
    tickets.clear();
  }

  return { router, middleware, accept, close };
}
