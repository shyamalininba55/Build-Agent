import test from "node:test";
import assert from "node:assert/strict";
import { classifyIssue, isRepairableIssue, sanitizeDiagnostic } from "./issues.js";

const examples = [
  ["invalid API key; quota exceeded", "API"],
  ["Anthropic API error 401: invalid x-api-key", "API"],
  ["SyntaxError: Unexpected token )", "Coding"],
  ["npm run build failed: SyntaxError in src/App.jsx: Unexpected token )", "Coding"],
  ["npm install failed: dependency version conflict", "Dependency"],
  ["flutter: command not found", "CMD/Terminal"],
  ["integration tests timed out", "Testing"],
  ["Flutter Android build failed: missing asset", "Build"],
  ["git push rejected: non-fast-forward", "Git"],
  ["GitHub API error 403: insufficient permissions", "GitHub"],
  ["npm install failed: ECONNREFUSED registry.npmjs.org", "Network"],
  ["pip install failed: NewConnectionError: Failed to establish a new connection: [Errno 11001] getaddrinfo failed", "Network"],
  ["Render deployment timeout", "Deployment"],
  ["getaddrinfo ENOTFOUND api.example.test", "Network"],
  ["ERR_CONNECTION_REFUSED localhost:3000", "Network"],
  ["exposed API key committed to source", "Security"],
  ["unsupported Node version; requires node >=22", "Environment"],
  ["ENOENT: file not found in invalid project structure", "File/project"],
  ["PostgreSQL migration failed", "Database"],
  ["AI agent repair attempt returned invalid generated code", "AI-agent"],
  ["Agent returned empty content for docs.py", "AI-agent"],
  ["previous stage dependency failed; pipeline stopped", "Pipeline"],
  ["rollback failed: previous version unavailable", "Rollback"]
];

test("classifies representative pipeline failures", () => {
  for (const [message, expectedCategory] of examples) {
    assert.equal(classifyIssue(message).category, expectedCategory, message);
  }
});

test("marks code and validation failures repairable but blocks unsafe or external failures", () => {
  for (const message of ["SyntaxError: Unexpected token", "npm install package conflict", "unit tests failed", "build failed", "file not found"]) {
    assert.equal(isRepairableIssue(classifyIssue(message)), true, message);
  }

  for (const message of [
    "invalid API key",
    "GitHub API error 403",
    "exposed secret",
    "git push rejected",
    "DNS lookup failed",
    "pip install failed: NewConnectionError: Failed to establish a new connection: [Errno 11001] getaddrinfo failed"
  ]) {
    assert.equal(isRepairableIssue(classifyIssue(message)), false, message);
  }
});

test("detects and redacts common secret values from diagnostics", () => {
  const apiKey = `AIza${"A".repeat(35)}`;
  assert.equal(classifyIssue(`build output included ${apiKey}`).category, "Security");
  assert.equal(sanitizeDiagnostic(`API_KEY=${apiKey}`).includes(apiKey), false);
  assert.equal(classifyIssue(`PASSWORD='${"s".repeat(24)}'`).category, "Security");
  assert.equal(sanitizeDiagnostic("postgres://user:database-secret@db.example.test/app").includes("database-secret"), false);
});
