import { getPullRequest } from "./github.js";

export function validateDeployHookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    const error = new Error("The deploy hook URL is invalid.");
    error.status = 400;
    throw error;
  }
  if (url.protocol !== "https:" || url.hostname !== "api.render.com" || !url.pathname.startsWith("/deploy/")) {
    const error = new Error("Only a valid HTTPS deployment hook URL is supported.");
    error.status = 400;
    throw error;
  }
  return url.href;
}

export async function deployAfterMergedPullRequest({
  repoUrl,
  token,
  pullRequestNumber,
  deployHookUrl,
  fetchImpl = fetch
}) {
  const hookUrl = validateDeployHookUrl(deployHookUrl);
  const pullRequest = await getPullRequest(token, repoUrl, pullRequestNumber);
  if (!pullRequest.merged_at || pullRequest.base?.ref !== "main") {
    const error = new Error(`Merge pull request #${pullRequestNumber} into main before deploying.`);
    error.status = 409;
    throw error;
  }

  let response;
  try {
    response = await fetchImpl(hookUrl, { method: "POST" });
  } catch {
    throw new Error("Could not reach the deploy hook. Check your network and try again.");
  }
  if (!response.ok) throw new Error(`The deploy hook returned HTTP ${response.status}.`);
  return { pullRequestNumber: Number(pullRequestNumber) };
}