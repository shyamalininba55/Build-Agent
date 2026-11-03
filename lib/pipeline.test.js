import test from "node:test";
import assert from "node:assert/strict";
import { findFilesToRemove, hasRequestedFileChanges } from "./pipeline.js";

test("reports no changes when the model selected no files and nothing is being removed", () => {
  assert.equal(hasRequestedFileChanges([], new Set()), false);
});

test("allows changes when files are selected or explicitly removed", () => {
  assert.equal(hasRequestedFileChanges(["backend.py"], new Set()), true);
  assert.equal(hasRequestedFileChanges([], new Set(["README.md"])), true);
});

test("interprets 'remove docs. files' as deleting tracked documentation files", () => {
  const trackedFiles = [
    "docs.py",
    "docs.md",
    "docs/guide.md",
    "src/docs.jsx",
    "README.md",
    "src/app.py"
  ];

  assert.deepEqual(
    [...findFilesToRemove("remove docs. files", trackedFiles)].sort(),
    ["docs.md", "docs.py", "docs/guide.md", "src/docs.jsx"].sort()
  );
});

test("does not remove documentation files without an explicit removal request", () => {
  const trackedFiles = ["docs.md", "README.md"];
  assert.deepEqual([...findFilesToRemove("update the docs files", trackedFiles)], []);
});
