import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { runPipeline } from "./lib/pipeline.js";
import { getLatestMergedPullRequest, setActionsSecrets } from "./lib/github.js";
import { sanitizeDiagnostic } from "./lib/issues.js";
import { deployAfterMergedPullRequest } from "./lib/deploy.js";
import { closeLocalModel, isLocalModelConfigured } from "./lib/local-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function checkAccess(req, res, next) {
  const required = process.env.APP_ACCESS_KEY;
  if (!required) return next(); // no key configured — fine for local-only use
  if (req.header("x-access-key") === required) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.post("/api/run", checkAccess, async (req, res) => {
    const {
      repoUrl,
      repoName,
      createNewRepo,
      token,
      branch,
      command,
      deployHookUrl,
      deployUrl,
      renderApiKey,
      renderServiceId,
      previewOnly
    } = req.body || {};
  if ((!createNewRepo && !repoUrl) || (createNewRepo && !repoName) || !token || !command) {
    return res.status(400).json({ error: "token and command are required; provide repoUrl or repoName" });
  }
  const provider = (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "google")).toLowerCase();
  const fallbackProvider = (process.env.AI_FALLBACK_PROVIDER || "google").toLowerCase();
  const supportedProviders = ["anthropic", "google", "local"];
  if (!supportedProviders.includes(provider)) {
    return res.status(500).json({ error: `Unsupported AI_PROVIDER: ${provider}` });
  }
  if (!supportedProviders.includes(fallbackProvider)) {
    return res.status(500).json({ error: `Unsupported AI_FALLBACK_PROVIDER: ${fallbackProvider}` });
  }
  const missingKey = provider === "anthropic"
    ? !process.env.ANTHROPIC_API_KEY
    : provider === "google"
      ? !process.env.GOOGLE_API_KEY
      : false;
  if (missingKey) {
    return res.status(500).json({ error: `${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY"} is not set on the server` });
  }
  const localRequired = provider === "local" || fallbackProvider === "local";
  if (localRequired && !isLocalModelConfigured()) {
    return res.status(500).json({ error: "Local AI requires LOCAL_MODEL_ID or LOCAL_BASE_MODEL_PATH plus LOCAL_ADAPTER_PATH (or LOCAL_ADAPTER_ZIP) on the server." });
  }
  try {
        const result = await runPipeline({
          repoUrl,
          repoName,
          createNewRepo,
          token,
          branch,
          command,
          deployHookUrl,
          deployUrl,
          renderApiKey,
          renderServiceId,
          previewOnly: Boolean(previewOnly)
        });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/github/actions-secrets", checkAccess, async (req, res) => {
  const { repoUrl, token, secrets } = req.body || {};
  const requiredNames = [
    "RENDER_DEPLOY_HOOK_URL",
    "RENDER_SERVICE_ID",
    "DEPLOY_URL"
  ];
  if (!repoUrl || !token || !secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    return res.status(400).json({ ok: false, error: "Repository URL, GitHub token, and secret values are required." });
  }
  if (requiredNames.some((name) => typeof secrets[name] !== "string" || !secrets[name].trim())) {
    return res.status(400).json({ ok: false, error: "Fill in all three Render deployment values." });
  }

  try {
    const configured = await setActionsSecrets(token, repoUrl, secrets);
    return res.json({ ok: true, configured });
  } catch (error) {
    const status = [401, 403, 404].includes(error.status) ? error.status : 502;
    return res.status(status).json({
      ok: false,
      error: sanitizeDiagnostic(error.message),
      configured: error.configuredSecrets || []
    });
  }
});

app.post("/api/deploy/merged-pr", checkAccess, async (req, res) => {
  const { repoUrl, token, pullRequestNumber, deployHookUrl, deployUrl } = req.body || {};
  if (!repoUrl || !token || !deployHookUrl || !deployUrl || !Number.isSafeInteger(Number(pullRequestNumber)) || Number(pullRequestNumber) < 1) {
    return res.status(400).json({ ok: false, error: "Repository, pull request, and deployment settings are required." });
  }

  try {
    const result = await deployAfterMergedPullRequest({
      repoUrl,
      token,
      pullRequestNumber: Number(pullRequestNumber),
      deployHookUrl
    });
    return res.status(202).json({
      ok: true,
      pullRequestNumber: result.pullRequestNumber,
      deployUrl,
      message: `Deployment for PR #${result.pullRequestNumber} was requested. The site may take a few minutes to update.`
    });
  } catch (error) {
    const status = [400, 401, 403, 404, 409].includes(error.status) ? error.status : 502;
    return res.status(status).json({ ok: false, error: sanitizeDiagnostic(error.message) });
  }
});

app.post("/api/deploy/latest-merged", checkAccess, async (req, res) => {
  const { repoUrl, token, deployHookUrl, deployUrl } = req.body || {};
  if (!repoUrl || !token || !deployHookUrl || !deployUrl) {
    return res.status(400).json({ ok: false, error: "Repository, GitHub token, and deployment settings are required." });
  }

  try {
    const pullRequest = await getLatestMergedPullRequest(token, repoUrl);
    const result = await deployAfterMergedPullRequest({
      repoUrl,
      token,
      pullRequestNumber: pullRequest.number,
      deployHookUrl
    });
    return res.status(202).json({
      ok: true,
      pullRequestNumber: result.pullRequestNumber,
      deployUrl,
      message: `Deployment for latest merged PR #${result.pullRequestNumber} was requested. The site may take a few minutes to update.`
    });
  } catch (error) {
    const status = [400, 401, 403, 404, 409].includes(error.status) ? error.status : 502;
    return res.status(status).json({ ok: false, error: sanitizeDiagnostic(error.message) });
  }
});

// Optional: after a deploy, poll whether the live site is responding.
app.get("/api/check-site", checkAccess, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url query param required" });
  try {
    const r = await fetch(url, { method: "GET" });
    res.json({ reachable: true, status: r.status });
  } catch (e) {
    res.json({ reachable: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  console.log(`Build agent listening on http://${HOST}:${PORT}`);
  console.log(`AI provider: ${(process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "google"))}`);
  console.log(`Access from Android emulator: http://10.0.2.2:${PORT}`);
});

function shutdown() {
  server.close(() => {
    closeLocalModel().catch((error) => {
      console.error(`Could not stop local model worker: ${error.message}`);
      process.exitCode = 1;
    });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
