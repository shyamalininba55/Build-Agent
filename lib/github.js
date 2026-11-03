import simpleGit from "simple-git";
import fs from "fs/promises";
import path from "path";
import os from "os";
import sodium from "libsodium-wrappers";

async function githubRequest(token, endpoint, options = {}) {
  const { parseJson = true, ...requestOptions } = options;
  const request = {
    ...requestOptions,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };
  let response;
  let fetchError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`https://api.github.com${endpoint}`, request);
      break;
    } catch (cause) {
      fetchError = cause;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  if (!response) {
    const details = [fetchError?.cause?.code, fetchError?.cause?.message].filter(Boolean).join(": ");
    throw new Error(`GitHub API network request failed after 3 attempts: ${details || fetchError?.message || "unknown network error"}`, { cause: fetchError });
  }
  if (!response.ok) {
    const details = await response.text();
    const message = response.status === 401
      ? "GitHub rejected the supplied token (401). It may be expired, revoked, or invalid."
      : `GitHub API error ${response.status}: ${details}`;
    const error = new Error(message);
    error.status = response.status;
    error.acceptedPermissions = response.headers?.get?.("x-accepted-github-permissions") || null;
    throw error;
  }
  return parseJson && response.status !== 204 ? response.json() : null;
}

const ACTION_SECRET_NAMES = new Set([
  "RENDER_DEPLOY_HOOK_URL",
  "RENDER_API_KEY",
  "RENDER_SERVICE_ID",
  "DEPLOY_URL"
]);

export async function setActionsSecrets(token, repoUrl, secrets) {
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repoUrl);
  } catch {
    throw new Error("Actions secrets require a GitHub repository URL");
  }
  const [owner, repository] = repositoryUrl.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (repositoryUrl.hostname.toLowerCase() !== "github.com" || !owner || !repository) {
    throw new Error("Actions secrets require a GitHub repository URL in https://github.com/owner/repo format");
  }
  const entries = Object.entries(secrets || {});
  if (!entries.length || entries.some(([name, value]) => !ACTION_SECRET_NAMES.has(name) || typeof value !== "string" || !value.trim())) {
    throw new Error("Provide non-empty values for the supported Render Actions secrets only");
  }

  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  let publicKey;
  try {
    publicKey = await githubRequest(token, `${repositoryPath}/actions/secrets/public-key`);
  } catch (error) {
    if (error.status === 403) {
      const permissionName = /(?:^|,\s*)secrets=(?:read|write)/i.test(error.acceptedPermissions || "")
        ? "Secrets"
        : "Actions";
      const permissionHint = error.acceptedPermissions
        ? ` GitHub reports this endpoint requires: ${error.acceptedPermissions}.`
        : "";
      throw new Error(
        `GitHub denied access to repository Actions secrets (403). Confirm the app is using the token with ${permissionName}: Read and write for this exact repository.${permissionHint}`
      );
    }
    throw error;
  }
  if (!publicKey?.key || !publicKey?.key_id) {
    throw new Error("GitHub did not return the repository Actions public key");
  }
  await sodium.ready;
  const binaryPublicKey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
  const configured = [];
  for (const [name, value] of entries) {
    const encryptedValue = sodium.crypto_box_seal(sodium.from_string(value), binaryPublicKey);
    try {
      await githubRequest(token, `${repositoryPath}/actions/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        parseJson: false,
        body: JSON.stringify({
          encrypted_value: sodium.to_base64(encryptedValue, sodium.base64_variants.ORIGINAL),
          key_id: publicKey.key_id
        })
      });
      configured.push(name);
    } catch (error) {
      if (error.status === 403) {
        const permissionHint = error.acceptedPermissions
          ? ` GitHub reports this endpoint requires: ${error.acceptedPermissions}.`
          : "";
        error.message = `GitHub denied Actions secret updates (403). Confirm the token has Secrets: Read and write permission for this exact repository.${permissionHint}`;
      }
      error.configuredSecrets = configured;
      throw error;
    }
  }
  return configured;
}

export async function createRepository(token, name, description = "Created by Build Agent") {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Repository name may only contain letters, numbers, dots, hyphens, and underscores");
  }
  return githubRequest(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, description, private: false, auto_init: true })
  });
}

export async function createPullRequest(token, repoUrl, head, base, title, body) {
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repoUrl);
  } catch {
    throw new Error("Pull requests require a GitHub repository URL");
  }
  const [owner, repository] = repositoryUrl.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (repositoryUrl.hostname.toLowerCase() !== "github.com" || !owner || !repository) {
    throw new Error("Pull requests require a GitHub repository URL in https://github.com/owner/repo format");
  }
  try {
    return await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`, {
      method: "POST",
      body: JSON.stringify({ head, base, title, body })
    });
  } catch (error) {
    if (error.status === 403) {
      throw new Error(
        "GitHub denied pull request creation (403). The branch was pushed, but the token needs Pull requests: Read and write access to this exact repository."
      );
    }
    throw error;
  }
}

export async function getPullRequest(token, repoUrl, pullRequestNumber) {
  if (!Number.isSafeInteger(Number(pullRequestNumber)) || Number(pullRequestNumber) < 1) {
    throw new Error("A valid pull request number is required");
  }
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repoUrl);
  } catch {
    throw new Error("Pull requests require a GitHub repository URL");
  }
  const [owner, repository] = repositoryUrl.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (repositoryUrl.hostname.toLowerCase() !== "github.com" || !owner || !repository) {
    throw new Error("Pull requests require a GitHub repository URL in https://github.com/owner/repo format");
  }
  return githubRequest(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${Number(pullRequestNumber)}`
  );
}

export async function getLatestMergedPullRequest(token, repoUrl) {
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repoUrl);
  } catch {
    throw new Error("Pull requests require a GitHub repository URL");
  }
  const [owner, repository] = repositoryUrl.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (repositoryUrl.hostname.toLowerCase() !== "github.com" || !owner || !repository) {
    throw new Error("Pull requests require a GitHub repository URL in https://github.com/owner/repo format");
  }
  const pullRequests = await githubRequest(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`
  );
  const mergedPullRequest = pullRequests.find((pullRequest) => pullRequest.merged_at && pullRequest.base?.ref === "main");
  if (!mergedPullRequest) {
    const error = new Error("No pull request merged into main was found. Merge a pull request before deploying.");
    error.status = 409;
    throw error;
  }
  return mergedPullRequest;
}

export function createPullRequestCompareUrl(repoUrl, head, base) {
  const repositoryUrl = new URL(repoUrl);
  const [owner, repository] = repositoryUrl.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (repositoryUrl.hostname.toLowerCase() !== "github.com" || !owner || !repository) {
    throw new Error("Pull request compare links require a GitHub repository URL");
  }
  const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeRef(base)}...${encodeRef(head)}?expand=1`;
}

export function isRetryableCloneError(error) {
  return /(?:Recv failure|connection (?:was )?reset|connection timed out|could not resolve host|failed to connect|network is unreachable|operation timed out|remote end hung up unexpectedly|early EOF|unexpected disconnect while reading sideband packet)/i
    .test(error?.message || "");
}

/**
 * Clones repoUrl into a fresh temp directory using a short-lived token.
 * The token is only ever embedded in the local git remote URL inside this
 * process's temp folder — it is never written to disk elsewhere or logged.
 */
export async function cloneRepo(repoUrl, token, branch) {
  const encodedToken = encodeURIComponent(token);
  const authedUrl = repoUrl.replace(
    /^https:\/\//,
    `https://x-access-token:${encodedToken}@`
  );
  const git = simpleGit();
  let cloneArgs = branch ? ["--branch", branch, "--single-branch"] : [];
  let workDir;
  let attempts = 0;

  while (attempts < 3) {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "build-agent-"));
    try {
      await git.clone(authedUrl, workDir, cloneArgs);
      break;
    } catch (error) {
      await cleanup(workDir);
      workDir = undefined;

      const message = error?.message || "";
      const missingBranch = cloneArgs.length > 0
        && /Remote branch .* not found|not found in upstream origin/i.test(message);
      if (missingBranch) {
        cloneArgs = [];
        continue;
      }

      attempts += 1;
      if (!isRetryableCloneError(error) || attempts >= 3) {
        if (isRetryableCloneError(error)) {
          throw new Error(`GitHub clone failed after ${attempts} attempts due to a network error: ${message}`, { cause: error });
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
    }
  }

  if (!workDir) throw new Error("GitHub clone failed without creating a workspace.");
  const repoGit = simpleGit(workDir);
  // Strip the token back out of the stored remote so it doesn't linger
  // in .git/config for longer than the clone step needs it.
  await repoGit.remote(["set-url", "origin", repoUrl]);
  await repoGit.addConfig(
    "user.name",
    process.env.BUILD_AGENT_GIT_NAME || "Build Agent"
  );
  await repoGit.addConfig(
    "user.email",
    process.env.BUILD_AGENT_GIT_EMAIL || "build-agent@localhost"
  );
  // Re-add auth only for the push step, done in commitAndPush.
  return { workDir, git: repoGit, authedUrl };
}

export async function createLocalRepository(repoUrl, token, branch) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "build-agent-"));
  const repoGit = simpleGit(workDir);
  await repoGit.init();
  if (branch) await repoGit.checkoutLocalBranch(branch);
  await repoGit.addRemote("origin", repoUrl);
  await repoGit.addConfig("user.name", process.env.BUILD_AGENT_GIT_NAME || "Build Agent");
  await repoGit.addConfig("user.email", process.env.BUILD_AGENT_GIT_EMAIL || "build-agent@localhost");
  return {
    workDir,
    git: repoGit,
    authedUrl: repoUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(token)}@`)
  };
}

export async function commitAndPush(git, authedUrl, message, branch) {
  const status = await git.status();
  if (status.files.length === 0) {
    return { pushed: false, reason: "no changes to commit" };
  }
  await git.add(".");
  await git.commit(message);

  const targetBranch = branch && status.current === branch ? branch : status.current;
  try {
    await git.push(authedUrl, targetBranch);
  } catch (error) {
    const message = error?.message || "";
    if (/Authentication failed|Invalid username or token|Password authentication is not supported|Permission to .* denied|403/i.test(message)) {
      throw new Error(
        "GitHub denied the push (403). The PAT must belong to an account with write access to this repository, and its fine-grained repository permission must include Contents: Read and write. Verify the PAT targets this exact repository and retry."
      );
    }
    throw error;
  }
  const log = await git.log({ maxCount: 1 });
  return { pushed: true, commit: log.latest };
}

export async function cleanup(workDir) {
  if (!workDir) return;
  try {
    await fs.rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 500
    });
  } catch (error) {
    // Windows can briefly keep a cloned file open after git or a build exits.
    console.warn(`Could not remove temporary workspace ${workDir}: ${error.message}`);
  }
}
