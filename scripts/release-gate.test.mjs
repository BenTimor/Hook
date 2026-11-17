import assert from "node:assert/strict";
import test from "node:test";

import { decide } from "./release-gate.mjs";

const published = (version, sourceHash, extras = {}) => ({
  latest: version,
  releases: [{ version, sourceHash, ...extras }],
});

test("the first release always builds", () => {
  const result = decide({ version: "0.1.0", sourceHash: "v1:a", published: null });
  assert.equal(result.publish, true);
});

test("identical application source skips the build", () => {
  const result = decide({
    version: "0.1.0",
    sourceHash: "v1:a",
    published: published("0.1.0", "v1:a"),
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /identical/);
});

test("a version-only bump does not rebuild identical source", () => {
  const result = decide({
    version: "0.1.1",
    sourceHash: "v1:a",
    published: published("0.1.0", "v1:a"),
  });
  assert.equal(result.publish, false);
});

test("changed source without a version bump is an error", () => {
  const result = decide({
    version: "0.1.0",
    sourceHash: "v1:new",
    published: published("0.1.0", "v1:old"),
  });
  assert.equal(result.publish, false);
  assert.match(result.error, /version:bump/);
});

test("changed source with a higher version publishes", () => {
  const result = decide({
    version: "0.2.0",
    sourceHash: "v1:new",
    published: published("0.1.0", "v1:old"),
  });
  assert.equal(result.publish, true);
  assert.match(result.reason, /0\.1\.0 -> 0\.2\.0/);
});

test("a lower version never publishes over a newer one", () => {
  const result = decide({
    version: "0.1.0",
    sourceHash: "v1:new",
    published: published("0.2.0", "v1:old"),
  });
  assert.equal(result.publish, false);
  assert.match(result.error, /downgrade/);
});

test("a published entry without a source hash is treated as changed", () => {
  const result = decide({
    version: "0.1.0",
    sourceHash: "v1:new",
    published: published("0.1.0", null),
  });
  assert.equal(result.publish, false);
  assert.match(result.error, /already published/);
});

test("the declared latest is used even when it is not first", () => {
  const result = decide({
    version: "0.3.0",
    sourceHash: "v1:new",
    published: {
      latest: "0.2.0",
      releases: [
        { version: "0.3.0", sourceHash: "v1:older-but-higher" },
        { version: "0.2.0", sourceHash: "v1:published" },
      ],
    },
  });
  assert.equal(result.publish, true);
});

test("every product's source inputs exist", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { appInputs, PRODUCTS, root } = await import("./products.mjs");
  for (const product of Object.values(PRODUCTS)) {
    const missing = appInputs(product).filter((input) => !existsSync(join(root, input)));
    assert.deepEqual(missing, [], `${product.id}: ${missing.join(", ")}`);
  }
});
