import { WebSocket, WebSocketServer } from "ws";
import { remoteRefusal } from "./plans.mjs";
import { apiUser, deviceId } from "./tokens.mjs";
import { deviceViews } from "./devices.mjs";

/**
 * The account's live half: presence, commands and chat fan-out.
 *
 * One WebSocket per running product. A machine has exactly one `host`
 * connection (Hook or `hookd`); every other connection is a controller
 * (Hook Workspace, HookCode). Commands addressed to a machine go to its host
 * connection, so a Workspace window on the same computer cannot execute them
 * itself and two products cannot both claim the same run.
 *
 * The hub keeps no conversation content and writes no message to disk. Live
 * frames are best-effort; a viewer that falls behind reloads from sync. The
 * only durable thing here is the device row, which is a name and a last-seen
 * time.
 */

const MAX_FRAME = 8 * 1024 * 1024;
// A controller asks questions every now and then. A host also streams the turn
// it is running — deltas, steps and RPC answers — which is far more traffic from
// a connection that is already trusted to run agents on the account's machines.
// A host that outruns this is cut off, and the frames it lost are never resent.
const MAX_FRAMES_PER_MINUTE = 240;
const MAX_HOST_FRAMES_PER_MINUTE = 1200;
const MAX_PENDING_PER_CONNECTION = 32;
const MAX_SUBSCRIPTIONS = 100;
const RPC_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 25_000;
const PRESENCE_DEBOUNCE_MS = 250;
const TOUCH_MS = 5 * 60_000;

/**
 * Every product that may hold a relay connection. `browser` is here and not in
 * HOST_PRODUCTS: Hook Browser's host can be asked for a tab, which is work, but
 * it runs no engine and takes no agent commands.
 */
const PRODUCTS = new Set(["chat", "workspace", "mobile", "headless", "browser"]);
const KINDS = new Set(["desktop", "headless", "mobile"]);
const HOST_PRODUCTS = new Set(["chat", "headless"]);

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function reject(socket, status, code, message) {
  const reasons = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    429: "Too Many Requests",
  };
  const body = JSON.stringify({
    error: { message, type: "invalid_request_error", code },
  });
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reasons[status] ?? "Error"}\r\n` +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body,
    );
  } finally {
    socket.destroy();
  }
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** A boolean out of a stored JSON column (`capabilities`), or false. */
function storedFlag(column, key) {
  if (typeof column !== "string") return false;
  try {
    const parsed = JSON.parse(column);
    return Boolean(parsed && typeof parsed === "object" && parsed[key] === true);
  } catch {
    return false;
  }
}

function jsonObject(value, max = 4096) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text.length > max) return null;
  return text;
}

function frameError(conn, code, message, id) {
  conn.send({ kind: "error", code, message, ...(id ? { id } : {}) });
}

export function createRelay({ server, db, presence, previewTunnel }) {
  if (!db || !server) return { close() {} };

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const connections = new Set();
  const bySubject = new Map();
  /** rpc id -> { caller, host, timer } */
  const pending = new Map();
  const presenceTimers = new Map();
  let closed = false;

  function subjectConnections(subject) {
    let set = bySubject.get(subject);
    if (!set) bySubject.set(subject, (set = new Set()));
    return set;
  }

  function send(conn, frame) {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function schedulePresence(subject) {
    if (closed) return;
    if (presenceTimers.has(subject)) return;
    const timer = setTimeout(() => {
      presenceTimers.delete(subject);
      const devices = deviceViews(db, presence, subject);
      for (const conn of subjectConnections(subject)) {
        if (conn.hello) send(conn, { kind: "presence", devices });
      }
    }, PRESENCE_DEBOUNCE_MS);
    timer.unref?.();
    presenceTimers.set(subject, timer);
  }

  const offPresence = presence.subscribe((subject) => schedulePresence(subject));

  function onUpgrade(req, socket, head) {
    let path = "/";
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (path !== "/api/relay") {
      socket.destroy();
      return;
    }

    const result = apiUser(db, req);
    if (!result.row) {
      reject(socket, result.status, result.code, result.message);
      return;
    }
    const refusal = remoteRefusal(result.row);
    if (refusal) {
      reject(socket, 403, refusal.code, refusal.message);
      return;
    }
    const headerDevice = deviceId(req);
    const tokenDevice = result.row.token_device_id ?? null;
    if (tokenDevice && headerDevice && headerDevice !== tokenDevice) {
      reject(
        socket,
        401,
        "device_mismatch",
        "This session belongs to a different device. Sign in again.",
      );
      return;
    }
    const targetDevice = tokenDevice ?? headerDevice;
    if (!targetDevice) {
      reject(socket, 400, "missing_device", "Hook needs this device's id.");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (closed) {
        ws.close(1001, "The relay is restarting.");
        return;
      }
      const conn = {
        ws,
        subject: result.row.google_subject,
        deviceId: targetDevice,
        hello: false,
        role: "controller",
        device: null,
        subscribed: new Set(),
        frames: 0,
        windowStart: Date.now(),
        alive: true,
        lastTouch: 0,
        send: (frame) => send(conn, frame),
        close: (code, reason) => ws.close(code, reason),
      };
      connections.add(conn);
      subjectConnections(conn.subject).add(conn);

      ws.on("pong", () => {
        conn.alive = true;
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          frameError(conn, "bad_frame", "The relay expects JSON text.");
          return;
        }
        const now = Date.now();
        if (now - conn.windowStart >= 60_000) {
          conn.windowStart = now;
          conn.frames = 0;
        }
        conn.frames += 1;
        if (conn.frames > frameBudget(conn)) {
          ws.close(1008, "Too many frames.");
          return;
        }
        let frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          frameError(conn, "bad_frame", "That frame is not JSON.");
          return;
        }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          frameError(conn, "bad_frame", "That frame is not an object.");
          return;
        }
        handle(conn, frame);
      });
      ws.on("close", () => cleanup(conn));
      ws.on("error", () => cleanup(conn));
    });
  }

  function frameBudget(conn) {
    return conn.role === "host" ? MAX_HOST_FRAMES_PER_MINUTE : MAX_FRAMES_PER_MINUTE;
  }

  function handle(conn, frame) {
    if (!conn.hello && frame.kind !== "hello") {
      frameError(conn, "hello_required", "Send hello first.");
      return;
    }
    if (frame.kind === "previewResult") {
      if (previewTunnel?.accept(conn, frame)) return;
      frameError(
        conn,
        "unknown_preview",
        "That preview request is no longer waiting.",
      );
      return;
    }
    switch (frame.kind) {
      case "hello":
        return hello(conn, frame);
      case "subscribe":
        return subscribe(conn, frame);
      case "unsubscribe":
        return unsubscribe(conn, frame);
      case "publish":
        return publish(conn, frame);
      case "rpc":
        return rpc(conn, frame);
      case "rpcResult":
        return rpcResult(conn, frame);
      default:
        frameError(conn, "unknown_kind", "Unknown frame kind.");
    }
  }

  function hello(conn, frame) {
    if (conn.hello) {
      frameError(conn, "already_hello", "This connection already has a hello.");
      return;
    }
    if (frame.v !== 1) {
      frameError(conn, "unsupported_version", "This relay speaks version 1.");
      return;
    }
    const device = frame.device;
    if (!device || typeof device !== "object") {
      frameError(conn, "bad_hello", "hello needs a device object.");
      return;
    }
    if (device.id !== conn.deviceId) {
      frameError(conn, "device_mismatch", "hello names a different device.");
      return;
    }
    const name = cleanName(device.name);
    if (!name) {
      frameError(conn, "bad_hello", "A machine needs a name of 1-60 characters.");
      return;
    }
    if (!KINDS.has(device.kind)) {
      frameError(conn, "bad_hello", "Unknown machine kind.");
      return;
    }
    if (!PRODUCTS.has(device.product)) {
      frameError(conn, "bad_hello", "Unknown product.");
      return;
    }
    const capabilities = jsonObject(device.capabilities);
    const specs = jsonObject(device.specs);
    const wantsHost = device.role === "host" && HOST_PRODUCTS.has(device.product);
    const role = wantsHost ? "host" : "controller";
    const canHost = wantsHost || Boolean(device.canHost && HOST_PRODUCTS.has(device.product));

    db.prepare(
      `INSERT INTO devices
         (google_subject, device_id, name, kind, platform, arch, app_version,
          product, can_host, capabilities, specs, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowSql})
       ON CONFLICT(google_subject, device_id) DO UPDATE SET
         kind = excluded.kind,
         platform = excluded.platform,
         arch = excluded.arch,
         app_version = excluded.app_version,
         product = excluded.product,
         can_host = MAX(devices.can_host, excluded.can_host),
         capabilities = excluded.capabilities,
         specs = excluded.specs,
         last_seen_at = ${nowSql}`,
    ).run(
      conn.subject,
      conn.deviceId,
      name,
      device.kind,
      typeof device.platform === "string" ? device.platform.slice(0, 40) : null,
      typeof device.arch === "string" ? device.arch.slice(0, 40) : null,
      typeof device.appVersion === "string"
        ? device.appVersion.slice(0, 40)
        : null,
      device.product,
      canHost ? 1 : 0,
      capabilities,
      specs,
    );

    conn.hello = true;
    conn.role = role;
    conn.device = { ...device, name, role };
    conn.lastTouch = Date.now();
    presence.add(conn);
    const view = deviceViews(db, presence, conn.subject).find(
      (entry) => entry.id === conn.deviceId,
    );
    send(conn, { kind: "ready", device: view ?? null });
    schedulePresence(conn.subject);
  }

  function subscribe(conn, frame) {
    const chatId = typeof frame.chatId === "string" ? frame.chatId.trim() : "";
    if (!chatId || chatId.length > 160) {
      frameError(conn, "bad_subscription", "A chat id of 1-160 characters is required.");
      return;
    }
    if (conn.subscribed.size >= MAX_SUBSCRIPTIONS && !conn.subscribed.has(chatId)) {
      frameError(conn, "too_many_subscriptions", "Too many live chats on one connection.");
      return;
    }
    conn.subscribed.add(chatId);
  }

  function unsubscribe(conn, frame) {
    if (typeof frame.chatId === "string") conn.subscribed.delete(frame.chatId.trim());
  }

  function publish(conn, frame) {
    if (conn.role !== "host") {
      frameError(conn, "not_a_host", "Only a machine can publish live events.");
      return;
    }
    const chatId = typeof frame.chatId === "string" ? frame.chatId.trim() : "";
    if (!chatId || chatId.length > 160) {
      frameError(conn, "bad_event", "An event needs a chat id.");
      return;
    }
    const payload = frame.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      frameError(conn, "bad_event", "An event needs a payload object.");
      return;
    }
    // Fan out only to this account's subscribers of this chat. The publisher's
    // own UI already has the event, so it is excluded.
    for (const other of subjectConnections(conn.subject)) {
      if (other === conn || !other.hello || !other.subscribed.has(chatId)) continue;
      send(other, { kind: "event", chatId, payload });
    }
  }

  function rpcError(conn, id, code, message) {
    send(conn, { kind: "rpcResult", id, ok: false, error: { code, message } });
  }

  function rpc(conn, frame) {
    const id = typeof frame.id === "string" ? frame.id.trim() : "";
    if (!id || id.length > 80) {
      frameError(conn, "bad_rpc", "An RPC needs an id.");
      return;
    }
    const to = typeof frame.to === "string" && frame.to.trim()
      ? frame.to.trim()
      : conn.deviceId;
    const method = typeof frame.method === "string" ? frame.method.trim() : "";
    if (!method || method.length > 80) {
      rpcError(conn, id, "bad_rpc", "An RPC needs a method.");
      return;
    }
    if (frame.params !== undefined && (typeof frame.params !== "object" || frame.params === null || Array.isArray(frame.params))) {
      rpcError(conn, id, "bad_rpc", "RPC params must be an object.");
      return;
    }
    const targetRow = db
      .prepare(
        "SELECT can_host, remote_allowed, capabilities FROM devices WHERE google_subject = ? AND device_id = ?",
      )
      .get(conn.subject, to);
    if (!targetRow)
      return rpcError(conn, id, "unknown_device", "That machine is not on this account.");
    // `can_host` means "can run agent work". A page read is work of a different
    // kind: it goes to a machine with a browser, which is a controller and
    // would fail that test. The family names its own target rule instead.
    //
    // A machine's products share one device row (one account file, one device
    // id), and they may be connected at the same time — Hook in the tray and
    // Hook Browser both. So the connection is chosen by what the method needs,
    // not by the row: an agent call wants the host socket, a page read wants the
    // browser's. The stored capabilities are only a fallback, because they hold
    // whichever product connected last.
    const open = presence
      .connections(conn.subject, to)
      .filter((candidate) => candidate.ws.readyState === WebSocket.OPEN);
    const browserHere = open.some(
      (candidate) => candidate.device?.product === "browser",
    );
    const readsAPage =
      method.startsWith("browser.") &&
      (browserHere || storedFlag(targetRow.capabilities, "browser"));
    if (!targetRow.can_host && !readsAPage)
      return rpcError(conn, id, "not_a_host", "That device cannot run agent work.");
    if (!targetRow.remote_allowed)
      return rpcError(conn, id, "remote_disabled", "That machine does not accept remote work.");
    const target = readsAPage
      ? open.find((candidate) => candidate.device?.product === "browser")
      : open.find((candidate) => candidate.role === "host");
    if (!target)
      return rpcError(
        conn,
        id,
        "device_offline",
        readsAPage
          ? "Hook Browser is not running on that machine right now."
          : "That machine is not running Hook right now.",
      );
    if (target === conn) return rpcError(conn, id, "self_target", "A machine cannot call itself.");

    const existing = pending.get(id);
    if (existing) return rpcError(conn, id, "duplicate_rpc", "That RPC id is already in flight.");
    let mine = 0;
    for (const entry of pending.values()) if (entry.caller === conn) mine += 1;
    if (mine >= MAX_PENDING_PER_CONNECTION)
      return rpcError(conn, id, "too_many_rpcs", "Too many requests are in flight.");

    const timer = setTimeout(() => {
      pending.delete(id);
      rpcError(conn, id, "rpc_timeout", "The machine did not answer in time.");
    }, RPC_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { caller: conn, host: target, timer });
    send(target, {
      kind: "rpc",
      id,
      from: conn.deviceId,
      method,
      params: frame.params ?? {},
    });
  }

  function rpcResult(conn, frame) {
    const id = typeof frame.id === "string" ? frame.id.trim() : "";
    const entry = pending.get(id);
    if (!entry) return;
    if (entry.host !== conn) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    const ok = frame.ok === true;
    send(entry.caller, {
      kind: "rpcResult",
      id,
      ok,
      ...(ok
        ? { result: frame.result ?? null }
        : {
            error:
              frame.error && typeof frame.error === "object"
                ? {
                    code:
                      typeof frame.error.code === "string"
                        ? frame.error.code
                        : "failed",
                    message:
                      typeof frame.error.message === "string"
                        ? frame.error.message
                        : "The machine could not complete that.",
                  }
                : { code: "failed", message: "The machine could not complete that." },
          }),
    });
  }

  function cleanup(conn) {
    if (!connections.delete(conn)) return;
    subjectConnections(conn.subject).delete(conn);
    // A connection that dies with RPCs in flight must not leave their callers
    // waiting for the 60-second timeout.
    for (const [id, entry] of pending) {
      if (entry.caller === conn) {
        clearTimeout(entry.timer);
        pending.delete(id);
      } else if (entry.host === conn) {
        clearTimeout(entry.timer);
        pending.delete(id);
        rpcError(entry.caller, id, "host_disconnected", "The machine disconnected.");
      }
    }
    if (conn.hello) presence.remove(conn);
    else schedulePresence(conn.subject);
  }

  function heartbeat() {
    const now = Date.now();
    for (const conn of connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        // The close handler will clean up.
      }
      if (conn.hello && now - conn.lastTouch > TOUCH_MS) {
        conn.lastTouch = now;
        try {
          db.prepare(
            `UPDATE devices SET last_seen_at = ${nowSql}
              WHERE google_subject = ? AND device_id = ?`,
          ).run(conn.subject, conn.deviceId);
        } catch {
          // A touch is not worth a connection.
        }
      }
    }
  }

  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  server.on("upgrade", onUpgrade);

  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      offPresence();
      for (const timer of presenceTimers.values()) clearTimeout(timer);
      presenceTimers.clear();
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      server.off("upgrade", onUpgrade);
      for (const conn of [...connections]) {
        try {
          conn.ws.close(1001, "The relay is restarting.");
        } catch {
          // Already gone.
        }
      }
      wss.close();
      connections.clear();
      bySubject.clear();
    },
  };
}
