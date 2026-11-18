import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { root } from "./products.mjs";
import { siteInputs, siteSourceHash } from "./site-source-hash.mjs";

/** A throwaway tree holding just the files a case cares about. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "hook-site-hash-"));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

test("every site input exists", () => {
  const missing = siteInputs().filter((input) => !existsSync(join(root, input)));
  assert.deepEqual(missing, []);
});

test("a change to what the container runs changes the hash", () => {
  const dir = fixture({ "server/waitlist.mjs": "one\n" });
  const before = siteSourceHash({ root: dir });
  writeFileSync(join(dir, "server/waitlist.mjs"), "two\n");
  assert.notEqual(siteSourceHash({ root: dir }), before);
});

test("a frontend change does not rebuild the server image", () => {
  const dir = fixture({
    "server/waitlist.mjs": "one\n",
    "waitlist/src/App.tsx": "export default null;\n",
  });
  const before = siteSourceHash({ root: dir });
  writeFileSync(join(dir, "waitlist/src/App.tsx"), "export const App = null;\n");
  assert.equal(siteSourceHash({ root: dir }), before);
});

test("a member manifest does rebuild it, because install resolves against it", () => {
  const dir = fixture({ "packages/ui/package.json": "{}\n" });
  const before = siteSourceHash({ root: dir });
  writeFileSync(join(dir, "packages/ui/package.json"), "{ }\n");
  assert.notEqual(siteSourceHash({ root: dir }), before);
});

test("a checkout's line endings are not a release", () => {
  const dir = fixture({ "server/waitlist.mjs": "one\ntwo\n" });
  const before = siteSourceHash({ root: dir });
  writeFileSync(join(dir, "server/waitlist.mjs"), "one\r\ntwo\r\n");
  assert.equal(siteSourceHash({ root: dir }), before);
});

test("a missing input is skipped instead of failing the deploy", () => {
  const dir = fixture({ "server/waitlist.mjs": "one\n" });
  assert.match(siteSourceHash({ root: dir }), /^s1:[0-9a-f]{64}$/);
});
