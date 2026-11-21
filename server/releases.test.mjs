import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publicReleaseInfo } from "./download.mjs";
import {
  compareVersions,
  parseVersion,
  releaseFile,
  releaseIndex,
  releaseInfo,
  storeListing,
} from "./releases.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hook-releases-test-"));
  const releases = join(directory, "releases");
  mkdirSync(releases);
  const config = join(directory, "release.config.json");
  writeFileSync(config, JSON.stringify({ minimumVersion: "0.1.0" }));
  return {
    env: { DOWNLOAD_DIR: releases, RELEASE_CONFIG: config },
    directory,
    releases,
    config,
    writeInstaller(name, bytes = "installer") {
      writeFileSync(join(releases, name), bytes);
    },
    writeIndex(entries, extra = {}) {
      writeFileSync(
        join(releases, "releases.json"),
        JSON.stringify({ releases: entries, ...extra }),
      );
    },
    writeMinimum(version) {
      writeFileSync(config, JSON.stringify({ minimumVersion: version }));
    },
    writeStore(store) {
      writeFileSync(config, JSON.stringify({ minimumVersion: "0.1.0", store }));
    },
  };
}

test("version comparison follows semver precedence", () => {
  assert.equal(parseVersion("v1.2.3-beta.1")?.major, 1);
  assert.equal(parseVersion("not-a-version"), null);
  assert.ok(compareVersions("0.2.0", "0.10.0") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("the versioned index is preferred and lists newest first", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-0.1.0-setup.exe", "old");
  f.writeInstaller("Hook-0.2.0-setup.exe", "new");
  f.writeIndex(
    {
      "0.1.0": { file: "Hook-0.1.0-setup.exe", sha256: "aaa", size: 3 },
      "0.2.0": {
        file: "Hook-0.2.0-setup.exe",
        sha256: "bbb",
        size: 3,
        notes: "Faster updates",
      },
    },
    { latest: "0.2.0" },
  );

  const index = releaseIndex(f.env);
  assert.equal(index.latest, "0.2.0");
  assert.equal(index.minimum, "0.1.0");
  assert.deepEqual(
    index.releases.map((release) => release.version),
    ["0.2.0", "0.1.0"],
  );
  assert.match(index.releases[0].url, /version=0\.2\.0/);
  assert.equal(index.releases[0].notes, "Faster updates");
});

test("a declared latest wins over the highest version (rollback)", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-0.1.0-setup.exe");
  f.writeInstaller("Hook-0.2.0-setup.exe");
  f.writeIndex(
    {
      "0.1.0": { file: "Hook-0.1.0-setup.exe" },
      "0.2.0": { file: "Hook-0.2.0-setup.exe" },
    },
    { latest: "0.1.0" },
  );

  assert.equal(releaseIndex(f.env).latest, "0.1.0");
  assert.equal(releaseInfo(f.env).version, "0.1.0");
});

test("entries whose installer is missing are not offered", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-0.1.0-setup.exe");
  f.writeIndex({
    "0.1.0": { file: "Hook-0.1.0-setup.exe" },
    "0.2.0": { file: "Hook-0.2.0-setup.exe" },
  });

  const index = releaseIndex(f.env);
  assert.equal(index.latest, "0.1.0");
  assert.equal(index.releases.length, 1);
});

test("the minimum comes from the committed config and never exceeds latest", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-0.1.0-setup.exe");
  f.writeIndex({ "0.1.0": { file: "Hook-0.1.0-setup.exe" } });

  assert.equal(releaseIndex(f.env).minimum, "0.1.0");
  f.writeMinimum("0.5.0");
  assert.equal(releaseIndex(f.env).minimum, "0.1.0");
  f.writeMinimum("garbage");
  assert.equal(releaseIndex(f.env).minimum, "0.0.0");
});

test("the Store channel has its own latest and floor", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-0.1.1-setup.exe");
  f.writeIndex({ "0.1.1": { file: "Hook-0.1.1-setup.exe" } });

  assert.deepEqual(releaseIndex(f.env).store, { latest: null, minimum: null });

  f.writeStore({ latest: "0.1.0", minimumVersion: "0.1.0" });
  assert.deepEqual(releaseIndex(f.env).store, {
    latest: "0.1.0",
    minimum: "0.1.0",
  });

  // A Store floor ahead of the newest Store build is clamped, never forced.
  f.writeStore({ latest: "0.1.0", minimumVersion: "0.2.0" });
  assert.deepEqual(releaseIndex(f.env).store, {
    latest: "0.1.0",
    minimum: "0.1.0",
  });

  // The direct channel is unaffected by the Store pair.
  assert.equal(releaseIndex(f.env).latest, "0.1.1");
});

test("the Store listing is a deep link, and absent when unconfigured", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  // A release config without a listing id must not invent one.
  assert.equal(storeListing(f.env), null);

  f.writeStore({ productId: " 9NX9J93HP25M ", latest: "0.4.0" });
  assert.deepEqual(storeListing(f.env), {
    productId: "9NX9J93HP25M",
    url: "ms-windows-store://pdp/?productid=9NX9J93HP25M",
  });

  // Each product opens its own listing, and an unknown one opens nothing.
  writeFileSync(
    f.config,
    JSON.stringify({
      minimumVersion: "0.1.0",
      store: { productId: "9NX9J93HP25M" },
      products: { workspace: { store: { productId: "9NWS00000000" } } },
    }),
  );
  assert.equal(storeListing(f.env, "workspace").productId, "9NWS00000000");
  assert.equal(storeListing(f.env, "mobile"), null);
});

test("the legacy single-slot layout still works", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-setup.exe");
  writeFileSync(
    join(f.releases, "latest.json"),
    JSON.stringify({ version: "0.1.0", sha256: "abc", size: 9 }),
  );

  const index = releaseIndex(f.env);
  assert.equal(index.latest, "0.1.0");
  assert.equal(index.releases[0].url, "/api/download/windows");
  assert.equal(releaseFile(f.env), join(f.releases, "Hook-setup.exe"));
});

test("a download resolves only versions that the index knows", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  f.writeInstaller("Hook-0.1.0-setup.exe");
  f.writeInstaller("Hook-0.2.0-setup.exe");
  f.writeIndex({
    "0.1.0": { file: "Hook-0.1.0-setup.exe" },
    "0.2.0": { file: "Hook-0.2.0-setup.exe" },
  });

  assert.equal(releaseFile(f.env), join(f.releases, "Hook-0.2.0-setup.exe"));
  assert.equal(
    releaseFile(f.env, "0.1.0"),
    join(f.releases, "Hook-0.1.0-setup.exe"),
  );
  assert.equal(releaseFile(f.env, "9.9.9"), null);
});

test("an index cannot point outside the download directory", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  writeFileSync(join(f.directory, "outside.exe"), "nope");
  f.writeIndex({
    "0.1.0": { file: "../outside.exe" },
  });

  assert.equal(releaseIndex(f.env).releases.length, 0);
  assert.equal(releaseFile(f.env, "0.1.0"), null);
});

test("each product publishes its own index, and an unpublished one is absent", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));

  // Nothing has shipped for the second product yet.
  assert.equal(publicReleaseInfo(f.env, "workspace"), null);
  assert.equal(publicReleaseInfo(f.env, "nonsense"), null);

  writeFileSync(
    join(f.releases, "releases.workspace.json"),
    JSON.stringify({
      latest: "0.1.0",
      minimum: "0.1.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
      releases: { "0.1.0": { file: "Hook-Workspace-0.1.0-setup.exe" } },
    }),
  );
  f.writeInstaller("Hook-Workspace-0.1.0-setup.exe");

  const workspace = publicReleaseInfo(f.env, "workspace");
  assert.equal(workspace.latest, "0.1.0");
  assert.equal(workspace.releases[0].version, "0.1.0");
  assert.equal(workspace.releases[0].url, "/api/download/windows?version=0.1.0");
  // The installer lookup follows the product, not the chat app's index.
  assert.equal(
    releaseFile(f.env, null, "workspace"),
    join(f.releases, "Hook-Workspace-0.1.0-setup.exe"),
  );
  // The chat app's index is untouched by the second product.
  assert.equal(releaseIndex(f.env).latest, null);
});
