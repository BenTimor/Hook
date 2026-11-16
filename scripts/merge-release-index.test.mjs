import assert from "node:assert/strict";
import test from "node:test";

import { mergeReleaseIndex } from "./merge-release-index.mjs";

const manifest = (version, extras = {}) => ({
  version,
  file: `Hook-${version}-setup.exe`,
  size: 100,
  sha256: "a".repeat(64),
  builtAt: "2026-11-15T12:00:00.000Z",
  commit: "abc1234",
  sourceHash: `v1:${version}`,
  notes: null,
  ...extras,
});

test("the new build becomes the published latest", () => {
  const index = mergeReleaseIndex(
    [
      { version: "0.1.0", file: "Hook-setup.exe", sha256: "old" },
      { version: "0.2.0", file: "Hook-0.2.0-setup.exe", sha256: "mid" },
    ],
    manifest("0.3.0"),
  );

  assert.equal(index.latest, "0.3.0");
  assert.deepEqual(Object.keys(index.releases).sort(), [
    "0.1.0",
    "0.2.0",
    "0.3.0",
  ]);
  assert.equal(index.releases["0.3.0"].file, "Hook-0.3.0-setup.exe");
  assert.equal(index.releases["0.3.0"].sourceHash, "v1:0.3.0");
});

test("old versions are pruned but the previous one stays", () => {
  const published = Array.from({ length: 6 }, (_, index) => ({
    version: `0.${index + 1}.0`,
    file: `Hook-0.${index + 1}.0-setup.exe`,
  }));
  const index = mergeReleaseIndex(published, manifest("0.7.0"), 3);
  assert.deepEqual(Object.keys(index.releases).sort(), [
    "0.5.0",
    "0.6.0",
    "0.7.0",
  ]);
});

test("a legacy published entry survives until it is pruned", () => {
  const index = mergeReleaseIndex(
    [{ version: "0.1.0", file: "Hook-setup.exe", sha256: "legacy" }],
    manifest("0.1.1"),
  );
  assert.equal(index.releases["0.1.0"].file, "Hook-setup.exe");
  assert.equal(index.latest, "0.1.1");
});

test("the newest version sorts numerically, not lexicographically", () => {
  const index = mergeReleaseIndex(
    [{ version: "0.9.0", file: "Hook-0.9.0-setup.exe" }],
    manifest("0.10.0"),
    2,
  );
  assert.deepEqual(Object.keys(index.releases).sort(), ["0.10.0", "0.9.0"]);
});
