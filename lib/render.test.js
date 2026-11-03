import test from "node:test";
import assert from "node:assert/strict";
import {
  getRenderFailureLogs,
  isFailedRenderDeployment,
  resolveLiveCheckUrl,
  waitForRenderDeployment
} from "./render.js";

const response = (data) => ({ ok: true, json: async () => data });

test("waits for the deployment matching the pushed commit", async () => {
  const results = [
    [{ deploy: { id: "dep-1", status: "build_in_progress", commit: { id: "abc123" } } }],
    [{ deploy: { id: "dep-1", status: "live", commit: { id: "abc123" } } }]
  ];
  const result = await waitForRenderDeployment("key", "srv-1", {
    commitHash: "abc123",
    since: "2026-01-01T00:00:00.000Z",
    fetchImpl: async () => response(results.shift()),
    sleep: async () => {},
    now: (() => {
      let time = 0;
      return () => time++;
    })(),
    timeoutMs: 100
  });

  assert.equal(result.deployment.status, "live");
  assert.equal(result.timedOut, false);
});

test("returns a failed Render deployment without waiting for timeout", async () => {
  const result = await waitForRenderDeployment("key", "srv-1", {
    commitHash: "abc123",
    since: "2026-01-01T00:00:00.000Z",
    fetchImpl: async () => response([
      { deploy: { id: "dep-1", status: "build_failed", commit: { id: "abc123" } } }
    ]),
    now: () => 0
  });

  assert.equal(result.deployment.status, "build_failed");
  assert.equal(result.timedOut, false);
});

test("only failed deployment states are eligible for automatic repair", () => {
  assert.equal(isFailedRenderDeployment("build_failed"), true);
  assert.equal(isFailedRenderDeployment("deactivated"), false);
  assert.equal(isFailedRenderDeployment("live"), false);
});

test("uses the actual Render URL instead of a stale Render domain", () => {
  assert.equal(
    resolveLiveCheckUrl("https://my-app.onrender.com", "https://postgresql-project-1-nolj.onrender.com"),
    "https://postgresql-project-1-nolj.onrender.com"
  );
});

test("preserves a custom domain for live checks", () => {
  assert.equal(
    resolveLiveCheckUrl("https://database.example.com", "https://postgresql-project-1-nolj.onrender.com"),
    "https://database.example.com"
  );
});

test("retrieves build and runtime logs for a failed Render deployment", async () => {
  const requestedUrls = [];
  const logs = await getRenderFailureLogs("key", "srv-1", "owner-1", {
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:01:00.000Z",
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url);
      requestedUrls.push(requestedUrl);
      const type = requestedUrl.searchParams.get("type");
      return response({ logs: [{ message: type === "build" ? "build passed" : "streamlit: command not found" }] });
    }
  });

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get("ownerId"), "owner-1");
  assert.equal(requestedUrls[0].searchParams.get("resource"), "srv-1");
  assert.equal(requestedUrls[0].searchParams.get("type"), "build");
  assert.equal(requestedUrls[1].searchParams.get("type"), "app");
  assert.match(logs, /build passed/);
  assert.match(logs, /streamlit: command not found/);
});