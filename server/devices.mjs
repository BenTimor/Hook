import { json, Router } from "express";
import { remoteRefusal } from "./plans.mjs";
import { bumpSeq } from "./sync.mjs";
import { requireApiUser } from "./tokens.mjs";

/**
 * The account's machines.
 *
 * `devices` is a small registry: a name, what kind of machine it is, its
 * platform and app version, a capability summary and when it was last seen.
 * Nothing about a conversation, a project or a credential lives here.
 *
 * The live half — who is connected right now — is in memory in this process.
 * It is deliberately not persisted: after a deploy every device is offline
 * until it reconnects, and `last_seen_at` is what the UI shows in the meantime.
 */

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_NAME = 60;

export function createPresence() {
  /** subject -> device id -> connections */
  const bySubject = new Map();
  const listeners = new Set();

  function table(subject) {
    let devices = bySubject.get(subject);
    if (!devices) bySubject.set(subject, (devices = new Map()));
    return devices;
  }

  function emit(subject) {
    for (const listener of listeners) {
      try {
        listener(subject);
      } catch {
        // A broadcast listener must never take a connection down.
      }
    }
  }

  return {
    add(conn) {
      table(conn.subject).set(conn.deviceId, setFor(table(conn.subject), conn.deviceId).add(conn));
      emit(conn.subject);
    },
    remove(conn) {
      const devices = bySubject.get(conn.subject);
      const set = devices?.get(conn.deviceId);
      if (!set) return;
      set.delete(conn);
      if (!set.size) devices.delete(conn.deviceId);
      if (!devices.size) bySubject.delete(conn.subject);
      emit(conn.subject);
    },
    online(subject, deviceId) {
      return Boolean(bySubject.get(subject)?.get(deviceId)?.size);
    },
    hostOnline(subject, deviceId) {
      const set = bySubject.get(subject)?.get(deviceId);
      if (!set) return false;
      for (const conn of set) if (conn.role === "host") return true;
      return false;
    },
    /** The host connection a command for this machine must reach. */
    host(subject, deviceId) {
      const set = bySubject.get(subject)?.get(deviceId);
      if (!set) return null;
      for (const conn of set) if (conn.role === "host") return conn;
      return null;
    },
    connections(subject, deviceId) {
      return [...(bySubject.get(subject)?.get(deviceId) ?? [])];
    },
    closeDevice(subject, deviceId, code = 4001, reason = "This machine was removed.") {
      for (const conn of this.connections(subject, deviceId)) {
        try {
          conn.close(code, reason);
        } catch {
          // It may already be closing.
        }
      }
    },
    /** Every socket this account holds — used when cloud sync is turned off. */
    closeSubject(subject, code = 4003, reason = "Cloud sync is turned off.") {
      for (const deviceId of [...(bySubject.get(subject)?.keys() ?? [])]) {
        this.closeDevice(subject, deviceId, code, reason);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(subject) {
      emit(subject);
    },
    clear() {
      bySubject.clear();
      listeners.clear();
    },
  };
}

function setFor(devices, deviceId) {
  let set = devices.get(deviceId);
  if (!set) devices.set(deviceId, (set = new Set()));
  return set;
}

function parseJson(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The account's devices, rows merged with live connections, newest first.
 * Shared by `GET /api/devices` and the relay's presence broadcast so both
 * halves cannot drift.
 */
export function deviceViews(db, presence, subject) {
  const rows = db
    .prepare(
      `SELECT device_id, name, kind, platform, arch, app_version, product,
              can_host, capabilities, specs, remote_allowed, last_seen_at
         FROM devices
        WHERE google_subject = ?
        ORDER BY last_seen_at DESC, name`,
    )
    .all(subject);
  return rows.map((row) => {
    const online = presence?.online(subject, row.device_id) ?? false;
    const hostOnline = presence?.hostOnline(subject, row.device_id) ?? false;
    // Products share a device row, so `capabilities` is whichever one connected
    // last. Whether a browser is *running* has to come from the sockets.
    const browserOnline = (presence?.connections(subject, row.device_id) ?? []).some(
      (candidate) => candidate.device?.product === "browser",
    );
    return {
      id: row.device_id,
      name: row.name,
      kind: row.kind,
      platform: row.platform,
      arch: row.arch,
      appVersion: row.app_version,
      product: row.product,
      canHost: Boolean(row.can_host),
      online,
      hostOnline,
      browserOnline,
      role: hostOnline ? "host" : "controller",
      remoteAllowed: Boolean(row.remote_allowed),
      lastSeen: row.last_seen_at,
      capabilities: parseJson(row.capabilities),
      specs: parseJson(row.specs),
    };
  });
}

function refusalBody(refusal) {
  return {
    error: {
      message: refusal.message,
      type: "invalid_request_error",
      code: refusal.code,
    },
  };
}

/**
 * `GET /api/devices`, `PATCH /api/devices/:id`, `DELETE /api/devices/:id`.
 *
 * Every route is behind the paid + cloud-sync gate. Removing a device revokes
 * the app and git tokens that device held; it does not delete the account's
 * chats or projects, which are account data rather than device data.
 */
export function createDevicesRouter({ db, presence }) {
  const router = Router();
  router.use(json({ limit: "16kb" }));

  const gate = (req, res) => {
    const row = requireApiUser(db, req, res);
    if (!row) return null;
    const refusal = remoteRefusal(row);
    if (refusal) {
      res.status(403).json(refusalBody(refusal));
      return null;
    }
    return row;
  };

  router.get("/", (req, res) => {
    const row = gate(req, res);
    if (!row) return;
    res.json({ devices: deviceViews(db, presence, row.google_subject) });
  });

  router.patch("/:id", (req, res) => {
    const row = gate(req, res);
    if (!row) return;
    const id = req.params.id;
    if (!ID.test(id)) return res.status(400).json({ error: "invalid_device" });
    const existing = db
      .prepare(
        "SELECT device_id FROM devices WHERE google_subject = ? AND device_id = ?",
      )
      .get(row.google_subject, id);
    if (!existing) return res.status(404).json({ error: "unknown_device" });

    const changes = [];
    const values = [];
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "name")) {
      if (typeof req.body.name !== "string")
        return res.status(400).json({ error: "invalid_name" });
      const name = req.body.name
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NAME);
      if (!name) return res.status(400).json({ error: "invalid_name" });
      changes.push("name = ?");
      values.push(name);
    }
    if (
      req.body &&
      Object.prototype.hasOwnProperty.call(req.body, "remoteAllowed")
    ) {
      if (typeof req.body.remoteAllowed !== "boolean")
        return res.status(400).json({ error: "invalid_remote_allowed" });
      changes.push("remote_allowed = ?");
      values.push(req.body.remoteAllowed ? 1 : 0);
    }
    if (!changes.length) return res.status(400).json({ error: "nothing_to_change" });

    db.prepare(
      `UPDATE devices SET ${changes.join(", ")}
        WHERE google_subject = ? AND device_id = ?`,
    ).run(...values, row.google_subject, id);
    // The relay broadcasts the new name / switch to every connected device.
    presence?.emit(row.google_subject);
    const device = deviceViews(db, presence, row.google_subject).find(
      (entry) => entry.id === id,
    );
    res.json({ device });
  });

  router.delete("/:id", (req, res) => {
    const row = gate(req, res);
    if (!row) return;
    const id = req.params.id;
    if (!ID.test(id)) return res.status(400).json({ error: "invalid_device" });
    const existing = db
      .prepare(
        "SELECT device_id FROM devices WHERE google_subject = ? AND device_id = ?",
      )
      .get(row.google_subject, id);
    if (!existing) return res.status(404).json({ error: "unknown_device" });

    // Every credential this machine held stops working. The account's chats,
    // projects and memory are untouched: they belong to the account.
    db.prepare(
      `UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE google_subject = ? AND device_id = ? AND revoked_at IS NULL`,
    ).run(row.google_subject, id);
    // Stubs for chats that lived on this machine go with it, as tombstones, so
    // the other devices stop listing conversations nobody can open.
    const stubs = db
      .prepare(
        "SELECT chat_id FROM sync_remote_chats WHERE google_subject = ? AND device_id = ? AND deleted = 0",
      )
      .all(row.google_subject, id);
    for (const stub of stubs) {
      const seq = bumpSeq(db, row.google_subject);
      db.prepare(
        `UPDATE sync_remote_chats
            SET seq = ?, deleted = 1, updated_at = ?, title = '', message_count = 0
          WHERE google_subject = ? AND chat_id = ?`,
      ).run(seq, Date.now(), row.google_subject, stub.chat_id);
    }
    db.prepare(
      "DELETE FROM devices WHERE google_subject = ? AND device_id = ?",
    ).run(row.google_subject, id);
    presence?.closeDevice(row.google_subject, id);
    presence?.emit(row.google_subject);
    res.status(204).end();
  });

  return router;
}
