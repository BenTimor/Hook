import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * The versioned download slot served to the website and to Hook itself.
 *
 *   DOWNLOAD_DIR/
 *     releases.json                 the index (written last, swapped atomically)
 *     Hook-0.2.0-setup.exe          one immutable installer per version
 *     Hook-0.1.0-setup.exe          the previous version, still downloadable
 *     Hook-setup.exe, latest.json   legacy single-slot layout (read-only fallback)
 *
 * Publishing a release never removes or overwrites the version currently being
 * served: the new executable is uploaded under its own name first, and only
 * then does the index start pointing at it. A build that takes twenty minutes
 * therefore cannot take downloads down.
 */
export const RELEASE_FILE = "Hook-setup.exe";
export const RELEASE_MANIFEST = "latest.json";
export const RELEASE_INDEX = "releases.json";
export const RELEASE_CONFIG = "release.config.json";

export function releaseDir(env) {
  return resolve(env.DOWNLOAD_DIR || "data/releases");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** `1.2.3`, `v1.2.3`, `1.2.3-beta.1`: enough ordering for release slots. */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  // A prerelease sorts before the same version without one.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function installerPath(dir, file) {
  // Version slots are looked up in the index, never built from user input; a
  // stray separator or traversal in a hand-edited index must still not escape.
  if (typeof file !== "string" || basename(file) !== file) return null;
  const path = join(dir, file);
  return existsSync(path) ? path : null;
}

function normalizeRelease(dir, version, entry) {
  if (!entry || typeof entry !== "object") return null;
  const file = installerPath(dir, entry.file);
  if (!file) return null;
  let size = Number.isSafeInteger(entry.size) ? entry.size : null;
  if (size === null) {
    try {
      size = statSync(file).size;
    } catch {
      return null;
    }
  }
  return {
    version,
    file: entry.file,
    size,
    sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
    commit: typeof entry.commit === "string" ? entry.commit : null,
    builtAt: typeof entry.builtAt === "string" ? entry.builtAt : null,
    notes: typeof entry.notes === "string" ? entry.notes : null,
    sourceHash: typeof entry.sourceHash === "string" ? entry.sourceHash : null,
    url: `/api/download/windows?version=${encodeURIComponent(version)}`,
  };
}

function legacyRelease(env) {
  const dir = releaseDir(env);
  const file = join(dir, RELEASE_FILE);
  if (!existsSync(file)) return null;
  let size = null;
  try {
    const stat = statSync(file);
    if (stat.isFile()) size = stat.size;
  } catch {
    return null;
  }
  const manifest = readJson(join(dir, RELEASE_MANIFEST)) ?? {};
  return {
    version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
    file: RELEASE_FILE,
    size: Number.isSafeInteger(manifest.size) ? manifest.size : size,
    sha256: typeof manifest.sha256 === "string" ? manifest.sha256 : null,
    commit: typeof manifest.commit === "string" ? manifest.commit : null,
    builtAt: typeof manifest.builtAt === "string" ? manifest.builtAt : null,
    notes: typeof manifest.notes === "string" ? manifest.notes : null,
    sourceHash: typeof manifest.sourceHash === "string" ? manifest.sourceHash : null,
    url: "/api/download/windows",
  };
}

function readConfig(env) {
  return readJson(resolve(env.RELEASE_CONFIG || RELEASE_CONFIG)) ?? {};
}

function readMinimum(config, latest) {
  const configured =
    typeof config.minimumVersion === "string" ? config.minimumVersion : null;
  if (!configured || !parseVersion(configured)) return "0.0.0";
  // Never force a version that cannot be downloaded: if the minimum is ahead of
  // the newest build (or ahead of every build), the newest build is the floor.
  if (latest && compareVersions(configured, latest.version) > 0) return latest.version;
  return configured;
}

/**
 * The Store channel moves on its own schedule: a direct build can ship days
 * before Microsoft certifies the same version. Store builds only see updates
 * once `store.latest` names a version that is actually live in the Store.
 */
function readStore(config) {
  const storeConfig =
    config.store && typeof config.store === "object" ? config.store : {};
  const latest =
    typeof storeConfig.latest === "string" && parseVersion(storeConfig.latest)
      ? storeConfig.latest
      : null;
  if (!latest) return { latest: null, minimum: null };

  let minimum =
    typeof storeConfig.minimumVersion === "string" &&
    parseVersion(storeConfig.minimumVersion)
      ? storeConfig.minimumVersion
      : "0.0.0";
  // Same rule as the direct channel: never force a version the Store does not
  // have. Raising the Store floor past its newest release falls back to it.
  if (compareVersions(minimum, latest) > 0) minimum = latest;
  return { latest, minimum };
}

/**
 * Everything the website and the desktop updater need, and nothing secret.
 *
 * `latest` and `releases` describe what can be downloaded; `minimum` is the
 * oldest version allowed to keep working, and comes from the committed
 * `release.config.json` so it can be raised without rebuilding the app.
 */
export function releaseIndex(env) {
  const dir = releaseDir(env);
  const config = readConfig(env);
  const index = readJson(join(dir, RELEASE_INDEX));

  let releases = [];
  if (index && index.releases && typeof index.releases === "object") {
    releases = Object.entries(index.releases)
      .map(([version, entry]) => normalizeRelease(dir, version, entry))
      .filter(Boolean)
      .sort((a, b) => compareVersions(b.version, a.version));
  }
  if (releases.length === 0) {
    const legacy = legacyRelease(env);
    if (legacy) releases = [legacy];
  }

  // The explicit `latest` wins when it still resolves; otherwise the highest
  // version that actually has a file on disk does.
  const declared =
    index && typeof index.latest === "string"
      ? releases.find((release) => release.version === index.latest)
      : null;
  const latest = declared ?? releases[0] ?? null;
  if (latest) {
    // Keep the array consistent with the advertised latest.
    releases = [latest, ...releases.filter((release) => release !== latest)];
  }

  return {
    latest: latest?.version ?? null,
    minimum: readMinimum(config, latest),
    store: readStore(config),
    updatedAt:
      index && typeof index.updatedAt === "string"
        ? index.updatedAt
        : (latest?.builtAt ?? null),
    releases,
  };
}

/** The compact shape the signed-in website renders. */
export function releaseInfo(env) {
  const latest = releaseIndex(env).releases[0];
  if (!latest) return { available: false };
  return {
    available: true,
    version: latest.version,
    commit: latest.commit,
    builtAt: latest.builtAt,
    sha256: latest.sha256,
    size: latest.size,
    file: latest.file,
    url: latest.url,
  };
}

/**
 * Resolve a downloadable installer. `version` is matched against the index
 * (never turned into a path), so an unknown or malformed value simply misses.
 */
export function releaseFile(env, version = null) {
  const index = releaseIndex(env);
  const entry = version
    ? index.releases.find((release) => release.version === version)
    : index.releases[0];
  if (!entry) return null;
  return installerPath(releaseDir(env), entry.file);
}
