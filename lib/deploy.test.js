import test from "node:test";
import assert from "node:assert/strict";
import { deployAfterMergedPullRequest, validateDeployHookUrl } from "./deploy.js";

test("refuses deployment until the pull request is merged into main", async () => {
  const originalFetch = globalThis.fetch;
  let deployCalls = 0;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ number: 15, merged_at: null, base: { ref: "main" } })
  });

  try {
    await assert.rejects(
      deployAfterMergedPullRequest({
        repoUrl: "https://github.com/octo/project",
        token: "token",
        pullRequestNumber: 15,
        deployHookUrl: "https://api.render.com/deploy/service?key=secret",
        fetchImpl: async () => { deployCalls += 1; return { ok: true }; }
      }),
      /Merge pull request #15 into main/
    );
    assert.equal(deployCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("triggers the hook once when the PR is merged into main", async () => {
  const originalFetch = globalThis.fetch;
  let hookRequest;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ number: 15, merged_at: "2026-09-29T12:00:00Z", base: { ref: "main" } })
  });

  try {
    const result = await deployAfterMergedPullRequest({
      repoUrl: "https://github.com/octo/project",
      token: "token",
      pullRequestNumber: 15,
      deployHookUrl: "https://api.render.com/deploy/service?key=secret",
      fetchImpl: async (url, options) => {
        hookRequest = { url, options };
        return { ok: true, status: 202 };
      }
    });
    assert.deepEqual(result, { pullRequestNumber: 15 });
    assert.equal(hookRequest.url, "https://api.render.com/deploy/service?key=secret");
    assert.deepEqual(hookRequest.options, { method: "POST" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-HTTPS and non-Render hook URLs", () => {
  assert.throws(() => validateDeployHookUrl("http://api.render.com/deploy/service?key=secret"), /valid HTTPS/);
  assert.throws(() => validateDeployHookUrl("https://example.com/deploy/service"), /valid HTTPS/);
});