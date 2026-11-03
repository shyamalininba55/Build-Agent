import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_INSTRUCTIONS, findConfigurationBlockers, generateFileContent } from "./agent.js";

test("retries truncated file generation with a larger output budget", async () => {
  const originalFetch = globalThis.fetch;
  const budgets = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    budgets.push(body.generationConfig.maxOutputTokens);
    return {
      ok: true,
      json: async () => budgets.length === 1
        ? { candidates: [{ finishReason: "MAX_TOKENS" }] }
        : { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "print('done')" }] } }] }
    };
  };

  try {
    const content = await generateFileContent("update the file", "backend.py", "");
    assert.equal(content, "print('done')\n");
    assert.equal(budgets.length, 2);
    assert.ok(budgets[1] > budgets[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Google as a fallback when Anthropic is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_FALLBACK_PROVIDER: process.env.AI_FALLBACK_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY
  };
  process.env.AI_PROVIDER = "anthropic";
  process.env.AI_FALLBACK_PROVIDER = "google";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.GOOGLE_API_KEY = "test-google-key";
  const { generateFileContent: generateWithFallback } = await import(`./agent.js?fallback-test=${Date.now()}`);
  const requestedHosts = [];
  globalThis.fetch = async (url, options) => {
    requestedHosts.push(new URL(url).hostname);
    if (new URL(url).hostname === "api.anthropic.com") {
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limit exceeded" }
      }), { status: 429, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: "print('fallback')" }] }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const content = await generateWithFallback("update the file", "backend.py", "");
    assert.equal(content, "print('fallback')\n");
    assert.equal(requestedHosts.at(-1), "generativelanguage.googleapis.com");
    assert.ok(requestedHosts.slice(0, -1).every((host) => host === "api.anthropic.com"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("identifies placeholder psycopg2 database URLs without exposing credentials", () => {
  const blockers = findConfigurationBlockers(
    'Database connection error: invalid dsn after "postgresql+psycopg://DB_USER:DB_PASSWORD@DB_HOST:5432/DB_NAME"'
  );

  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /DATABASE_URL/);
  assert.match(blockers[0], /postgresql:\/\//);
  assert.doesNotMatch(blockers[0], /DB_PASSWORD/);
});

test("identifies missing OpenAI configuration for RAG", () => {
  const blockers = findConfigurationBlockers("RAG Engine: Missing API Key");

  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /OPENAI_API_KEY/);
  assert.match(blockers[0], /secret environment variable/);
});

test("detects unset DATABASE_URL and OPENAI_API_KEY wording in real error text", () => {
  const dbBlockers = findConfigurationBlockers("Database connection failed: DATABASE_URL is not set");
  const openAiBlockers = findConfigurationBlockers("RAG initialization failed: OPENAI_API_KEY is undefined");

  assert.equal(dbBlockers.length, 1);
  assert.match(dbBlockers[0], /DATABASE_URL/);
  assert.equal(openAiBlockers.length, 1);
  assert.match(openAiBlockers[0], /OPENAI_API_KEY/);
});

test("does not classify unrelated deployment errors as configuration blockers", () => {
  assert.deepEqual(findConfigurationBlockers("ModuleNotFoundError: No module named 'pgvector'"), []);
});

test("keeps Python syntax errors repairable even when source mentions environment variables", () => {
  const error = `SyntaxError: unterminated f-string literal\n    f.write(f"\\nDATABASE_URL={new_db_url}`;
  assert.deepEqual(findConfigurationBlockers(error), []);
});

test("does not treat an API key variable mentioned in code as a missing-key error", () => {
  assert.deepEqual(findConfigurationBlockers('config = os.environ.get("OPENAI_API_KEY")'), []);
});

test("default model instructions stop before deployment when required secrets are missing", () => {
  assert.match(DEFAULT_MODEL_INSTRUCTIONS, /stop.*deploy|do not deploy/i);
  assert.match(DEFAULT_MODEL_INSTRUCTIONS, /(password|database URL|DATABASE_URL|API key|OPENAI_API_KEY)/i);
  assert.match(DEFAULT_MODEL_INSTRUCTIONS, /missing.*(password|database URL|DATABASE_URL|API key|OPENAI_API_KEY)|(?:password|database URL|DATABASE_URL|API key|OPENAI_API_KEY).*missing/i);
  assert.match(DEFAULT_MODEL_INSTRUCTIONS, /show the actual error|do not hide/i);
  assert.match(DEFAULT_MODEL_INSTRUCTIONS, /never.*(write|store).*secret|do not write.*secret/i);
});