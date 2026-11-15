import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where the Windows installer and its manifest live. The release workflow
 * uploads both into the container's bind-mounted data directory, so a rebuilt
 * app is what the website serves on the next download without redeploying.
 *
 *   DOWNLOAD_DIR/latest.json      { version, size, sha256, builtAt, commit, file }
 *   DOWNLOAD_DIR/Hook-setup.exe
 */
export const RELEASE_FILE = "Hook-setup.exe";
export const RELEASE_MANIFEST = "latest.json";

export function releaseDir(env) {
  return resolve(env.DOWNLOAD_DIR || "data/releases");
}

/**
 * Everything the site needs to render a download button. Never throws: a
 * missing release simply reports `available: false`, so an approved user sees
 * "coming shortly" instead of a broken page.
 */
export function releaseInfo(env) {
  const dir = releaseDir(env);
  const file = join(dir, RELEASE_FILE);
  let size = null;
  try {
    const stat = statSync(file);
    if (stat.isFile()) size = stat.size;
  } catch {
    return { available: false };
  }

  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, RELEASE_MANIFEST), "utf8"));
  } catch {
    // A manifest is optional; the file itself is enough to offer a download.
  }

  return {
    available: true,
    version: typeof manifest.version === "string" ? manifest.version : null,
    commit: typeof manifest.commit === "string" ? manifest.commit : null,
    builtAt: typeof manifest.builtAt === "string" ? manifest.builtAt : null,
    sha256: typeof manifest.sha256 === "string" ? manifest.sha256 : null,
    size: Number.isSafeInteger(manifest.size) ? manifest.size : size,
    file: RELEASE_FILE,
    url: "/api/download/windows",
  };
}

export function releaseFile(env) {
  return join(releaseDir(env), RELEASE_FILE);
}
