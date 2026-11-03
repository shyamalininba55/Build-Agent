import test from "node:test";
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers";
import { createPullRequest, createPullRequestCompareUrl, getLatestMergedPullRequest, getPullRequest, isRetryableCloneError, setActionsSecrets } from "./github.js";

test("retries clone errors caused by temporary network failures but not authentication errors", () => {
  assert.equal(isRetryableCloneError(new Error("Recv failure: Connection was reset")), true);
  assert.equal(isRetryableCloneError(new Error("fatal: Authentication failed for repository")), false);
});

test("creates a pull request against the requested base branch", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ html_url: "https://github.com/octo/project/pull/7" }) };
  };

  try {
    const pullRequest = await createPullRequest(
      "token",
      "https://github.com/octo/project.git",
      "build-agent/change-123",
      "main",
      "Add requested change",
      "Automated change"
    );

    assert.equal(request.url, "https://api.github.com/repos/octo/project/pulls");
    assert.equal(request.options.headers.Authorization, "Bearer token");
    assert.deepEqual(request.body, {
      head: "build-agent/change-123",
      base: "main",
      title: "Add requested change",
      body: "Automated change"
    });
    assert.equal(pullRequest.html_url, "https://github.com/octo/project/pull/7");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-GitHub pull request repositories", async () => {
  await assert.rejects(
    createPullRequest("token", "https://example.com/octo/project", "agent/change", "main", "title", "body"),
    /Pull requests require a GitHub repository URL/
  );
});

test("explains when GitHub rejects an invalid token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"message":"Bad credentials"}'
  });

  try {
    await assert.rejects(
      createPullRequest("token", "https://github.com/octo/project", "build-agent/fix", "main", "title", "body"),
      (error) => {
        assert.equal(error.status, 401);
        assert.match(error.message, /GitHub rejected the supplied token \(401\)/);
        assert.doesNotMatch(error.message, /Bad credentials/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explains missing pull-request permission after GitHub returns 403", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"message":"Resource not accessible by personal access token"}'
  });

  try {
    await assert.rejects(
      createPullRequest("token", "https://github.com/octo/project", "build-agent/fix", "main", "title", "body"),
      /Pull requests: Read and write access/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("builds a compare link for a pushed agent branch", () => {
  assert.equal(
    createPullRequestCompareUrl("https://github.com/octo/project.git", "build-agent/fix-123", "main"),
    "https://github.com/octo/project/compare/main...build-agent/fix-123?expand=1"
  );
});

test("reads pull request merge state from the selected GitHub repository", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  globalThis.fetch = async (url) => {
    requestUrl = url;
    return { ok: true, json: async () => ({ number: 12, merged_at: "2026-09-29T12:00:00Z", base: { ref: "main" } }) };
  };

  try {
    const pullRequest = await getPullRequest("token", "https://github.com/octo/project.git", 12);
    assert.equal(requestUrl, "https://api.github.com/repos/octo/project/pulls/12");
    assert.equal(pullRequest.merged_at, "2026-09-29T12:00:00Z");
    assert.equal(pullRequest.base.ref, "main");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finds the latest pull request merged into main", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  globalThis.fetch = async (url) => {
    requestUrl = url;
    return {
      ok: true,
      json: async () => [
        { number: 8, merged_at: null, base: { ref: "main" } },
        { number: 7, merged_at: "2026-10-07T08:53:08Z", base: { ref: "main" } }
      ]
    };
  };

  try {
    const pullRequest = await getLatestMergedPullRequest("token", "https://github.com/octo/project.git");
    assert.equal(requestUrl, "https://api.github.com/repos/octo/project/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100");
    assert.equal(pullRequest.number, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires a pull request merged into main before latest-PR deployment", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    await assert.rejects(
      getLatestMergedPullRequest("token", "https://github.com/octo/project"),
      /No pull request merged into main/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("encrypts Actions secrets using GitHub's repository public key", async () => {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const originalFetch = globalThis.fetch;
  const savedSecrets = {};
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith("/actions/secrets/public-key")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          key: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL),
          key_id: "key-id"
        })
      };
    }
    const name = decodeURIComponent(url.split("/").at(-1));
    const payload = JSON.parse(options.body);
    const plaintext = sodium.crypto_box_seal_open(
      sodium.from_base64(payload.encrypted_value, sodium.base64_variants.ORIGINAL),
      keyPair.publicKey,
      keyPair.privateKey
    );
    savedSecrets[name] = sodium.to_string(plaintext);
    return { ok: true, status: 201 };
  };

  try {
    const secrets = {
      RENDER_DEPLOY_HOOK_URL: "https://api.render.com/deploy/example",
      RENDER_API_KEY: "render-api-key",
      RENDER_SERVICE_ID: "srv-example",
      DEPLOY_URL: "https://example.onrender.com"
    };
    const configured = await setActionsSecrets("token", "https://github.com/octo/project", secrets);
    assert.deepEqual(configured, Object.keys(secrets));
    assert.deepEqual(savedSecrets, secrets);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unsupported Actions secret names", async () => {
  await assert.rejects(
    setActionsSecrets("token", "https://github.com/octo/project", { OTHER_SECRET: "value" }),
    /supported Render Actions secrets/
  );
});

test("explains the required token access when GitHub denies the Actions public key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => "secrets=read" },
    text: async () => '{"message":"Resource not accessible by personal access token"}'
  });

  try {
    await assert.rejects(
      setActionsSecrets("token", "https://github.com/octo/project", { DEPLOY_URL: "https://example.test" }),
      /Secrets: Read and write for this exact repository.*secrets=read/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("includes the network cause when the GitHub API request cannot connect", async () => {
  const originalFetch = globalThis.fetch;
  const cause = Object.assign(new Error("socket reset by peer"), { code: "ECONNRESET" });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("fetch failed", { cause });
  };

  try {
    await assert.rejects(
      setActionsSecrets("token", "https://github.com/octo/project", { DEPLOY_URL: "https://example.test" }),
      /GitHub API network request failed after 3 attempts: ECONNRESET: socket reset by peer/
    );
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
