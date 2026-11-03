import Anthropic from "@anthropic-ai/sdk";
import { generateWithLocalModel } from "./local-model.js";

export const DEFAULT_MODEL_INSTRUCTIONS = `
You are a coding agent for a real repository. Follow these rules in order:
1. Diagnose the real error, including syntax errors, runtime errors, and missing environment configuration.
2. If a required password, database URL (for example DATABASE_URL), API key (for example OPENAI_API_KEY), or other secret is missing or invalid, stop and ask the user to add it in the hosting environment before any deployment or push. Do not deploy while required credentials are missing.
3. Show the actual error and the exact missing variable name to the user. Do not hide failures, claim success, or pretend a placeholder value is valid.
4. If code is broken, fix the smallest root cause, validate it locally again, and only then continue.
5. Never write, echo, store, or hardcode secrets in source files, repo .env files, logs, or UI text. If the app expects a secret from the environment, keep the code reading it from environment variables and report the variable name clearly.
6. Keep the change focused and minimal. Preserve unrelated behavior and code style.
7. If the request is to deploy, only do so after the required environment variables are configured and the app is validated.
`;

const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const AI_PROVIDER = (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "google")).toLowerCase();
const AI_FALLBACK_PROVIDER = (process.env.AI_FALLBACK_PROVIDER || "google").toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const FILE_SELECTION_MAX_TOKENS = Number.parseInt(process.env.AI_FILE_SELECTION_MAX_TOKENS || "1000", 10);
const CODE_MAX_TOKENS = Number.parseInt(process.env.AI_CODE_MAX_TOKENS || "24000", 10);
const CODE_INITIAL_MAX_TOKENS = Math.min(12000, CODE_MAX_TOKENS);

if (!Number.isSafeInteger(CODE_MAX_TOKENS) || CODE_MAX_TOKENS < 1) {
  throw new Error("AI_CODE_MAX_TOKENS must be a positive integer");
}

async function callAnthropic(system, userText, maxTokens = 1500) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: userText }]
  });
  if (message.stop_reason === "max_tokens") {
    throw new Error("AI response was truncated by the token limit; increase the configured output budget and retry.");
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function callGoogleAI(system, userText, maxTokens = 1500) {
  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2
      }
    })
  };
  const models = [MODEL, FALLBACK_MODEL].filter((model, index, list) => list.indexOf(model) === index);

  for (const model of models) {
    const url = `${GOOGLE_URL}/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
    let res;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await fetch(url, request);
        if (res.status === 429 && model !== FALLBACK_MODEL) {
          break;
        }
        if ([500, 502, 503, 504].includes(res.status) && attempt < 3) {
          await res.text();
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    if (!res) {
      throw new Error(`Google AI Studio request failed after 3 attempts: ${lastError?.cause?.message || lastError?.message}`);
    }
    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new Error("AI response was truncated by the token limit; increase the configured output budget and retry.");
      }
      return candidate?.content?.parts?.[0]?.text || "";
    }
    const errText = await res.text();
    const shouldTryFallback = [429, 500, 502, 503, 504].includes(res.status) && model !== FALLBACK_MODEL;
    if (!shouldTryFallback) {
      throw new Error(`Google AI Studio API error ${res.status}: ${errText}`);
    }
  }

  throw new Error(`Google AI Studio quota exceeded for ${MODEL}; fallback model ${FALLBACK_MODEL} also failed.`);
}

async function callAI(system, userText, maxTokens = 1500) {
  const callProvider = (provider) => {
    if (provider === "anthropic") return callAnthropic(system, userText, maxTokens);
    if (provider === "google") return callGoogleAI(system, userText, maxTokens);
    if (provider === "local") return generateWithLocalModel(system, userText, maxTokens);
    throw new Error(`Unsupported AI provider: ${provider}. Use "anthropic", "google", or "local".`);
  };

  try {
    return await callProvider(AI_PROVIDER);
  } catch (error) {
    const isFallbackCondition = error.status === 429
      || /(?:rate[_ -]?limit|quota exceeded|resource_exhausted|truncated by the token limit)/i.test(error.message || "");
    const fallbackConfigured = AI_FALLBACK_PROVIDER === "local"
      ? Boolean(
        process.env.LOCAL_MODEL_ID ||
        (process.env.LOCAL_BASE_MODEL_PATH && (process.env.LOCAL_ADAPTER_PATH || process.env.LOCAL_ADAPTER_ZIP))
      )
      : Boolean(AI_FALLBACK_PROVIDER === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.GOOGLE_API_KEY);
    if (!isFallbackCondition || AI_FALLBACK_PROVIDER === AI_PROVIDER || !fallbackConfigured) throw error;

    try {
      return await callProvider(AI_FALLBACK_PROVIDER);
    } catch (fallbackError) {
      throw new Error(
        `${AI_PROVIDER} reached its rate or usage limit, and ${AI_FALLBACK_PROVIDER} fallback failed: ${fallbackError.message}`,
        { cause: fallbackError }
      );
    }
  }
}

async function callAIWithOutputBudget(system, userText) {
  let maxTokens = CODE_INITIAL_MAX_TOKENS;
  while (true) {
    try {
      return await callAI(system, userText, maxTokens);
    } catch (error) {
      if (!/truncated by the token limit/i.test(error.message)) throw error;
      if (maxTokens >= CODE_MAX_TOKENS) {
        throw new Error(
          `AI response was truncated by the token limit at the configured maximum of ${CODE_MAX_TOKENS} output tokens. Increase AI_CODE_MAX_TOKENS and retry.`,
          { cause: error }
        );
      }
      maxTokens = Math.min(maxTokens * 2, CODE_MAX_TOKENS);
    }
  }
}

export function findConfigurationBlockers(text) {
  if (/SyntaxError|syntax error|unterminated (?:f-?string|string literal|triple-quoted string)|invalid syntax/i.test(text)) {
    return [];
  }

  const blockers = [];
  const dbUrlMissingOrInvalid = /\b(?:DATABASE_URL|POSTGRES(?:QL)?_URL)\b.*\b(?:missing|not set|not configured|undefined|empty|invalid|placeholder)\b|\b(?:missing|not set|not configured|undefined|empty|invalid|placeholder).{0,80}\b(?:DATABASE_URL|POSTGRES(?:QL)?_URL)\b|\binvalid dsn\b|missing\s+["']?=["']?\s+after|DB_USER:DB_PASSWORD@DB_HOST:5432\/DB_NAME/i.test(text);
  if (dbUrlMissingOrInvalid) {
    blockers.push(
      "DATABASE_URL is a placeholder or invalid for psycopg2. Set the real Render PostgreSQL internal URL in the service environment; psycopg2 expects a postgresql:// URL. Do not put credentials in the command or source code."
    );
  }
  const aiKeyMissingOrInvalid = /RAG Engine\s*:\s*Missing API Key|\b(?:OPENAI_API_KEY|OpenAI API key)\b.*\b(?:missing|not set|not configured|undefined|empty|invalid|unauthorized)\b|\b(?:missing|not set|not configured|undefined|empty|invalid|unauthorized).{0,80}\b(?:OPENAI_API_KEY|OpenAI API key)\b/i.test(text);
  if (aiKeyMissingOrInvalid) {
    blockers.push(
      "OPENAI_API_KEY is missing for RAG. Add it as a secret environment variable on the Render service; do not put the key in the command or source code."
    );
  }
  return blockers;
}

/** Step: "finds the required code/files" — asks the model to pick targets from the file list. */
export async function pickFiles(command, fileList) {
  const system = `${DEFAULT_MODEL_INSTRUCTIONS}\n\nYou are a coding agent. Given a list of files in a repository and a plain-English change request, decide which existing file(s) should be edited, or propose one sensible new file path if nothing fits. Respond with ONLY a JSON array of relative file paths, nothing else — no explanation, no markdown fences. Limit to at most 3 files, fewer if possible.`;
  const user = `Change request: "${command}"\n\nFiles in repo:\n${fileList.join("\n")}`;
  let text;
  try {
    text = await callAI(system, user, FILE_SELECTION_MAX_TOKENS);
  } catch (error) {
    if (!/truncated by the token limit/i.test(error.message)) throw error;
    text = await callAI(system, user, FILE_SELECTION_MAX_TOKENS * 2);
  }
  const candidates = [];
  const match = text.match(/\[[\s\S]*\]/);
  if (match) candidates.push(match[0]);
  candidates.push(text.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.every((file) => typeof file === "string")) {
        return parsed.slice(0, 3);
      }
    } catch {
      // Try the recovery format below for truncated or lightly wrapped responses.
    }
  }

  const normalizePath = (file) => file.replace(/^[./\\]+/, "").replace(/\\/g, "/").trim();
  const knownFiles = new Map(fileList.map((file) => [normalizePath(file), file]));
  const recoveredPaths = [...text.matchAll(/[`"']?([./\\]?[A-Za-z0-9_-]+(?:[\\/][A-Za-z0-9_.-]+)+)[`"']?/g)]
    .map((match) => normalizePath(match[1]))
    .filter((file) => knownFiles.has(file))
    .map((file) => knownFiles.get(file))
    .filter((file, index, files) => files.indexOf(file) === index)
    .slice(0, 3);
  if (recoveredPaths.length) return recoveredPaths;

  const proposedPaths = [...text.matchAll(/[`"']?([./\\]?[A-Za-z0-9_-]+(?:[\\/][A-Za-z0-9_.-]+)+)[`"']?/g)]
    .map((match) => normalizePath(match[1]))
    .filter((file, index, files) => files.indexOf(file) === index)
    .slice(0, 3);
  if (proposedPaths.length) return proposedPaths;

  throw new Error(`Could not parse file selection from agent response: ${text}`);
}

/** Step: "modifies or adds code" — asks the model for the complete new file content. */
export async function generateFileContent(command, filePath, currentContent) {
  const system = `${DEFAULT_MODEL_INSTRUCTIONS}\n\nYou are a coding agent making a focused, minimal change to one file to satisfy a change request. Diagnose reported errors instead of hiding them. Never invent, hardcode, request, echo, or write secret values such as database URLs, passwords, or API keys to source files, repository .env files, logs, or UI storage. Application code may read configured secrets from environment variables; when one is missing, show its variable name and tell the operator to configure it in the hosting provider's environment settings. Output ONLY the complete new content of the file after applying the change — no explanation, no markdown code fences, no commentary before or after. Preserve existing code style, comments, and unrelated functionality exactly as they are.`;
  const user = `File: ${filePath}\nChange request: "${command}"\n\nCurrent content (empty means this is a new file):\n---\n${currentContent}\n---`;
  const text = await callAIWithOutputBudget(system, user);
  const content = (
    text
      .replace(/^```[a-zA-Z0-9]*\n/, "")
      .replace(/```\s*$/, "")
      .trim() + "\n"
  );
  if (!content.trim()) throw new Error(`Agent returned empty content for ${filePath}`);
  return content;
}

/** Step: repairs generated code after a build or runtime error. */
export async function repairFileContent(command, filePath, currentContent, errorOutput) {
  const system = `${DEFAULT_MODEL_INSTRUCTIONS}\n\nYou are a coding agent repairing one file after execution failed. First distinguish code defects from missing or invalid environment configuration. Apply the smallest necessary code fix, but never invent, hardcode, request, echo, or write database URLs, passwords, API keys, or other secrets to source files, repository .env files, logs, or UI storage. Application code may read secrets from environment variables. Never hide an error by reporting a false healthy state. If a failure requires an operator-provided environment value, preserve truthful error reporting and identify the exact variable for the operator to configure in the hosting provider's environment settings. Output ONLY the complete corrected file content — no explanation, markdown fences, or commentary. Preserve unrelated behavior.`;
  const user = `File: ${filePath}\nOriginal request: "${command}"\n\nCurrent content:\n---\n${currentContent}\n---\n\nExecution error:\n---\n${errorOutput}\n---`;
  const text = await callAIWithOutputBudget(system, user);
  return (
    text
      .replace(/^```[a-zA-Z0-9]*\n/, "")
      .replace(/```\s*$/, "")
      .trim() + "\n"
  );
}
