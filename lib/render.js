const API_BASE = "https://api.render.com/v1";
const FAILED_STATUSES = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled"]);
const IN_PROGRESS_STATUSES = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress"
]);

export function isFailedRenderDeployment(status) {
  return FAILED_STATUSES.has(status);
}

export function resolveLiveCheckUrl(configuredUrl, renderServiceUrl) {
  if (!renderServiceUrl || !configuredUrl) return configuredUrl || renderServiceUrl || null;
  try {
    if (new URL(configuredUrl).hostname.endsWith(".onrender.com")) return renderServiceUrl;
  } catch {
    return renderServiceUrl;
  }
  return configuredUrl;
}

async function renderRequest(apiKey, endpoint, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Render API error ${response.status}: ${body}`);
  }
  return response.json();
}

function unwrapDeploys(response) {
  if (!Array.isArray(response)) return [];
  return response.map((entry) => entry.deploy || entry).filter((deploy) => deploy?.id);
}

export async function getRenderFailureLogs(apiKey, serviceId, ownerId, {
  startTime,
  endTime,
  types = ["build", "app"],
  fetchImpl = fetch
}) {
  const sections = [];
  for (const type of types) {
    const query = new URLSearchParams({ ownerId, startTime, endTime, limit: "100" });
    query.append("resource", serviceId);
    query.append("type", type);
    const response = await renderRequest(apiKey, `/logs?${query}`, fetchImpl);
    const logs = Array.isArray(response.logs) ? response.logs : [];
    const messages = logs.map((entry) => entry.message).filter(Boolean).slice(-150);
    if (messages.length) sections.push(`--- ${type} logs ---\n${messages.join("\n")}`);
  }
  return sections.join("\n\n").slice(-30000);
}

export async function waitForRenderDeployment(apiKey, serviceId, {
  commitHash,
  since,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 5000,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  now = Date.now
} = {}) {
  const query = new URLSearchParams({ createdAfter: since, limit: "20" });
  const deadline = now() + timeoutMs;
  let latestDeployment = null;

  while (now() <= deadline) {
    const response = await renderRequest(
      apiKey,
      `/services/${encodeURIComponent(serviceId)}/deploys?${query}`,
      fetchImpl
    );
    const deployments = unwrapDeploys(response);
    const matchingDeployment = deployments.find((deployment) => {
      const deployedCommit = deployment.commit?.id;
      return !commitHash || (deployedCommit && deployedCommit.startsWith(commitHash));
    });

    if (matchingDeployment) {
      latestDeployment = matchingDeployment;
      if (matchingDeployment.status === "live" || FAILED_STATUSES.has(matchingDeployment.status)) {
        return { deployment: matchingDeployment, timedOut: false };
      }
      if (!IN_PROGRESS_STATUSES.has(matchingDeployment.status)) {
        return { deployment: matchingDeployment, timedOut: false };
      }
    }

    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }

  return { deployment: latestDeployment, timedOut: true };
}

export async function getRenderService(apiKey, serviceId, fetchImpl = fetch) {
  return renderRequest(apiKey, `/services/${encodeURIComponent(serviceId)}`, fetchImpl);
}