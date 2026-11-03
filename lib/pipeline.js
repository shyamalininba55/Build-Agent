import fs from "fs/promises";
import path from "path";
import { cloneRepo, createRepository, createPullRequest, createPullRequestCompareUrl, commitAndPush, cleanup } from "./github.js";
import {
  DEFAULT_MODEL_INSTRUCTIONS,
  findConfigurationBlockers,
  pickFiles,
  generateFileContent,
  repairFileContent
} from "./agent.js";
import { detectProject, isRunnerUnavailable, runBuildAndTest } from "./build.js";
import { classifyIssue, isRepairableIssue, sanitizeDiagnostic } from "./issues.js";
import {
  getRenderFailureLogs,
  getRenderService,
  isFailedRenderDeployment,
  resolveLiveCheckUrl,
  waitForRenderDeployment
} from "./render.js";

async function validateProject(workDir, command) {
  try {
    return await runBuildAndTest(workDir, command);
  } catch (error) {
    const output = sanitizeDiagnostic(error?.stack || error?.message || String(error));
    return { ok: false, logs: [], output: `Validation runner error: ${output}` };
  }
}

export function findFilesToRemove(command, fileList) {
  const filesToRemove = new Set();
  const removalPattern = /\b(?:remove|delete)\s+([\w./-]+\.[\w-]+)/gi;
  const replacementPattern = /\b(?:replace|rename|move)\s+([\w./-]+\.[\w-]+)\s+(?:with|to)\s+([\w./-]+\.[\w-]+)/gi;
  for (const match of command.matchAll(removalPattern)) {
    if (fileList.includes(match[1])) filesToRemove.add(match[1]);
  }
  for (const match of command.matchAll(replacementPattern)) {
    if (fileList.includes(match[1])) filesToRemove.add(match[1]);
  }

  const removeDocs = /\b(?:remove|delete)\s+(?:the\s+)?(?:docs?|documentation)(?:[.\s]+files?)?\b/i.test(command);
  if (removeDocs) {
    for (const file of fileList) {
      const normalized = file.replace(/\\/g, "/");
      const basename = normalized.split("/").at(-1);
      if (/^docs?(?:[-_.]|$)/i.test(basename) || /^docs?\//i.test(normalized)) {
        filesToRemove.add(file);
      }
    }
  }

  return filesToRemove;
}

export function hasRequestedFileChanges(targetFiles, filesToRemove) {
  return targetFiles.length > 0 || filesToRemove.size > 0;
}

/**
 * Runs the agent workflow: parse command -> find files -> modify code ->
 * build/test -> push a feature branch -> create a pull request.
 */
export async function runPipeline({
  repoUrl,
  token,
  branch,
  command,
  deployHookUrl,
  deployUrl,
  renderApiKey,
  renderServiceId,
  createNewRepo,
  repoName,
  previewOnly = false
}) {
  const steps = [];
  const generatedFiles = [];
  const safeGeneratedFiles = () => generatedFiles.map((file) => ({
    ...file,
    content: sanitizeDiagnostic(file.content)
  }));
  const log = (name, detail, ok = true) => {
    const issue = ok ? null : classifyIssue(detail, name);
    steps.push({
      name,
      detail: ok ? detail : sanitizeDiagnostic(detail),
      ok,
      ...(issue ? { issueCategory: issue.category, retryable: issue.retryable } : {}),
      time: new Date().toISOString()
    });
  };

  log("parse-command", sanitizeDiagnostic(`"${command}"`));
  if (classifyIssue(command).category === "Security") {
    log("security-check", "possible secret detected in the request; it was not sent to the AI provider", false);
    return {
      ok: false,
      steps,
      issues: [{ category: "Security", retryable: false, stage: "security-check", detail: "Potential secret detected in request." }],
      output: "Potential secret detected in the request. Remove the secret and configure it in the target environment instead."
    };
  }
  const configurationBlockers = findConfigurationBlockers(command);
  if (configurationBlockers.length) {
    for (const blocker of configurationBlockers) log("configuration-required", blocker, false);
    return { ok: false, steps, output: configurationBlockers.join("\n") };
  }
  const monitorRender = Boolean(renderApiKey && renderServiceId);
  let modelCommand = `${command}\n\nDefault agent instructions:\n${DEFAULT_MODEL_INSTRUCTIONS}`;

  let workDir, git, authedUrl, baseBranch;
  try {
    if (createNewRepo) {
      const created = await createRepository(token, repoName);
      repoUrl = created.clone_url;
      ({ workDir, git, authedUrl } = await cloneRepo(repoUrl, token, branch));
      log("create-repo", `created ${created.full_name}`);
    } else {
      ({ workDir, git, authedUrl } = await cloneRepo(repoUrl, token, branch));
      log("clone-repo", "cloned to a temporary workspace");
    }
    baseBranch = (await git.raw(["branch", "--show-current"])).trim();
  } catch (e) {
    log("clone-repo", e.message, false);
    return { ok: false, steps };
  }

  try {
    let fileList;
    try {
      const raw = await git.raw(["ls-files"]);
      fileList = raw.split("\n").filter(Boolean).filter((f) => !f.includes("node_modules/"));
      log("scan-repo", `${fileList.length} tracked files`);
      const project = await detectProject(workDir, command);
      modelCommand += `\nDetected project type: ${project.type}. Project directory: ${project.rootDir || "repository root"}. Keep changes within the detected runtime unless the request explicitly asks to migrate.`;
      log("detect-project", `${project.type} at ${project.rootDir || "repository root"}`);
    } catch (e) {
      log("scan-repo", e.message, false);
      return { ok: false, steps };
    }

    let targetFiles;
    try {
      targetFiles = await pickFiles(modelCommand, fileList);
      log("select-files", targetFiles.join(", ") || "(none returned)");
    } catch (e) {
      log("select-files", e.message, false);
      return { ok: false, steps };
    }

    const filesToRemove = findFilesToRemove(command, fileList);

    for (const relPath of filesToRemove) {
      try {
        await fs.rm(path.join(workDir, relPath), { force: true });
        log("remove-file", `removed ${relPath}`);
      } catch (e) {
        log("remove-file", `${relPath}: ${e.message}`, false);
        return { ok: false, steps };
      }
    }
    targetFiles = targetFiles.filter((relPath) => !filesToRemove.has(relPath));
    if (!hasRequestedFileChanges(targetFiles, filesToRemove) && !previewOnly) {
      const detail = "No files were selected and no changes were made. Describe a specific code change to create a pull request, or use Deploy update for an existing pull request that has been merged into main.";
      log("select-files", detail, false);
      return { ok: false, steps, output: detail, files: safeGeneratedFiles() };
    }

    for (const relPath of targetFiles) {
      const filePath = path.join(workDir, relPath);
      let current = "";
      let newContent;
      let generationError;
      try {
        current = await fs.readFile(filePath, "utf8");
      } catch {
        /* file doesn't exist yet — treated as a new file */
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          newContent = await generateFileContent(modelCommand, relPath, current);
          generationError = null;
          break;
        } catch (error) {
          generationError = error;
          const issue = classifyIssue(error.message, "generate-code");
          if (!isRepairableIssue(issue) || /truncated by the token limit/i.test(error.message) || attempt === 3) break;
          log("generate-code-retry", `${relPath}: attempt ${attempt} of 3 returned an invalid agent response; retrying`, false);
        }
      }
      if (generationError) {
        const issue = classifyIssue(generationError.message, "generate-code");
        const detail = sanitizeDiagnostic(`${relPath}: ${generationError.message}`);
        log("generate-code", detail, false);
        return {
          ok: false,
          steps,
          issues: [{ category: issue.category, retryable: issue.retryable, stage: "generate-code", detail }],
          output: detail,
          files: safeGeneratedFiles()
        };
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, newContent, "utf8");
      generatedFiles.push({ path: relPath, content: newContent });
      log("generate-code", `wrote ${relPath}`);
    }

    const exposedSecret = generatedFiles.find((file) => classifyIssue(file.content).category === "Security");
    if (exposedSecret) {
      log("security-scan", `possible exposed secret in ${exposedSecret.path}; refusing to preview or open a pull request`, false);
      return {
        ok: false,
        steps,
        issues: [{ category: "Security", retryable: false, stage: "security-scan", detail: "Potential secret value detected in generated content." }],
        output: "Potential secret value detected in generated content. The change was not pushed.",
        files: safeGeneratedFiles()
      };
    }

    let buildResult = await validateProject(workDir, command);
    const maxRepairAttempts = 3;
    let repairAttempt = 0;
    while (!buildResult.ok && repairAttempt < maxRepairAttempts) {
      const issue = classifyIssue(buildResult.output, "build-test");
      if (
        isRunnerUnavailable(buildResult.output) ||
        findConfigurationBlockers(buildResult.output).length ||
        !isRepairableIssue(issue)
      ) {
        log("repair-code", `stopped automatic repair for ${issue.category}; operator action is required`, false);
        break;
      }
      repairAttempt += 1;
      log("repair-code", `attempt ${repairAttempt} of ${maxRepairAttempts}: asking the model to fix ${issue.category.toLowerCase()} issues`);
      const repairOutput = sanitizeDiagnostic(buildResult.output);
      const repairCommand = `${modelCommand}\n\nLocal validation failure:\n${repairOutput}`;
      const repairPaths = new Set(generatedFiles.map((file) => file.path));
      try {
        const selectedFiles = await pickFiles(repairCommand, fileList);
        for (const relPath of selectedFiles) repairPaths.add(relPath);
      } catch (e) {
        log("repair-code", `could not select files for repair: ${e.message}`, false);
        break;
      }
      if (!repairPaths.size) {
        log("repair-code", "no files were selected for repair", false);
        break;
      }
      let repairFailed = false;
      for (const relPath of repairPaths) {
        const filePath = path.join(workDir, relPath);
        try {
          const current = await fs.readFile(filePath, "utf8");
          const repaired = await repairFileContent(repairCommand, relPath, current, repairOutput);
          await fs.writeFile(filePath, repaired, "utf8");
          const existing = generatedFiles.find((file) => file.path === relPath);
          if (existing) existing.content = repaired;
          else generatedFiles.push({ path: relPath, content: repaired });
        } catch (e) {
          log("repair-code", `${relPath}: ${e.message}`, false);
          repairFailed = true;
          break;
        }
      }
      if (repairFailed) break;
      buildResult = await validateProject(workDir, command);
    }
    log("build-test", buildResult.ok ? buildResult.logs.join(" | ") : buildResult.output, buildResult.ok);
    if (!buildResult.ok) {
      return {
        ok: false,
        steps,
        issues: steps.filter((step) => step.issueCategory).map(({ issueCategory, retryable, name, detail }) => ({
          category: issueCategory,
          retryable,
          stage: name,
          detail
        })),
        output: sanitizeDiagnostic(buildResult.output),
        files: safeGeneratedFiles()
      };
    }

    if (previewOnly) {
      log("preview-only", "preview complete — no commit or push was made because approval has not been granted yet", true);
      return {
        ok: true,
        previewOnly: true,
        steps,
        output: sanitizeDiagnostic(buildResult.output),
        files: generatedFiles,
        filesChanged: [...new Set([...filesToRemove, ...targetFiles])],
        deployUrl: deployUrl || process.env.DEPLOY_URL || null
      };
    }

    const slug = command.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
    const featureBranch = `build-agent/${Date.now()}-${slug}`;
    let branchPushed = false;
    try {
      await git.checkoutLocalBranch(featureBranch);
      const pushResult = await commitAndPush(git, authedUrl, `${command} (automated)`, featureBranch);
      if (!pushResult.pushed) {
        const detail = "No changes were produced, so there is nothing to push or create a pull request for. Describe a specific code change, or deploy an existing pull request after it is merged into main.";
        log("push-agent-branch", detail, false);
        return { ok: false, steps, output: detail, files: safeGeneratedFiles(), filesChanged: [] };
      }
      branchPushed = true;
      log("push-agent-branch", `pushed ${featureBranch} at ${pushResult.commit.hash.slice(0, 7)}`);
      const pullRequest = await createPullRequest(
        token,
        repoUrl,
        featureBranch,
        baseBranch,
        command.trim().slice(0, 200),
        `Automated change requested:\n\n${command}\n\nLocal build and tests passed before opening this pull request.`
      );
      log("create-pull-request", `opened ${pullRequest.html_url}`);
      return {
        ok: true,
        awaitingReview: true,
        pullRequest: { url: pullRequest.html_url, number: pullRequest.number },
        steps,
        files: generatedFiles,
        filesChanged: [...new Set([...filesToRemove, ...targetFiles])],
        output: buildResult.output,
        deployUrl: deployUrl || process.env.DEPLOY_URL || null
      };
    } catch (e) {
      const stage = branchPushed ? "create-pull-request" : "push-agent-branch";
      const detail = sanitizeDiagnostic(e.message);
      const issue = classifyIssue(detail, stage);
      log(stage, detail, false);
      const pullRequest = branchPushed
        ? { compareUrl: createPullRequestCompareUrl(repoUrl, featureBranch, baseBranch), branch: featureBranch }
        : undefined;
      return {
        ok: false,
        steps,
        issues: [{ category: issue.category, retryable: issue.retryable, stage, detail }],
        output: detail,
        ...(pullRequest ? { pullRequest } : {}),
        files: safeGeneratedFiles()
      };
    }

    const configuredLiveUrl = deployUrl || process.env.DEPLOY_URL || null;
    const liveCheckUrl = monitorRender
      ? resolveLiveCheckUrl(configuredLiveUrl, renderService?.serviceDetails?.url)
      : configuredLiveUrl;

    let deployment = null;
    let deploymentOk = true;
    let output = buildResult.output;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const deployStartedAt = new Date().toISOString();
      let pushResult;
      try {
        pushResult = await commitAndPush(git, authedUrl, `${command} (automated)`, branch);
        log(
          "commit-push",
          pushResult.pushed ? `pushed ${pushResult.commit.hash.slice(0, 7)}` : pushResult.reason,
          true
        );
      } catch (e) {
        log("commit-push", e.message, false);
        return { ok: false, steps, files: generatedFiles };
      }

      if (!pushResult.pushed) {
        log("trigger-deploy", "skipped — no changes were pushed");
        if (monitorRender && deployment && deployment.status !== "live") {
          deploymentOk = false;
          output = "The repair produced no new commit; the failed Render deployment remains unresolved.";
        }
        break;
      }

      if (deployHookUrl && !(monitorRender && renderService.autoDeploy === "yes")) {
        try {
          const res = await fetch(deployHookUrl, { method: "POST" });
          log("trigger-deploy", `deploy hook responded ${res.status}`, res.ok);
        } catch (e) {
          log("trigger-deploy", e.message, false);
        }
      } else if (!deployHookUrl) {
        log("trigger-deploy", "push complete — connected hosts should auto-deploy this branch");
      } else {
        log("trigger-deploy", "deploy hook skipped — Render auto-deploy is enabled for this service");
      }

      if (!monitorRender) {
        const renderTarget = /(?:\.onrender\.com|api\.render\.com)/i.test(`${deployUrl || ""} ${deployHookUrl || ""}`);
        log(
          "render-monitor",
          "not checked here — GitHub Actions verifies Render deployment status after the pull request is merged",
          !renderTarget
        );
        if (renderTarget) {
          deploymentOk = false;
          output = "The code was pushed, but Render deployment status is unverified because server-side Render credentials are not configured.";
        }
        break;
      }

      let result;
      try {
        result = await waitForRenderDeployment(renderApiKey, renderServiceId, {
          commitHash: pushResult.commit.hash,
          since: deployStartedAt
        });
      } catch (e) {
        log("render-deploy", e.message, false);
        deploymentOk = false;
        output = e.message;
        break;
      }

      deployment = result.deployment;
      if (result.timedOut) {
        log(
          "render-deploy",
          deployment
            ? `timed out waiting; latest status: ${deployment.status}`
            : "timed out waiting for a deployment of the pushed commit",
          false
        );
        deploymentOk = false;
        output = "Render deployment did not finish before the monitoring timeout.";
        break;
      }

      if (deployment.status === "live") {
        log("render-deploy", `deployment ${deployment.id} is live`);
        if (liveCheckUrl) {
          try {
            const response = await fetch(liveCheckUrl);
            const healthy = response.ok;
            log("live-check", `${liveCheckUrl} responded ${response.status}`, healthy);
            if (!healthy) {
              deploymentOk = false;
              output = `Live URL check failed with HTTP ${response.status}.`;
            }
          } catch (e) {
            log("live-check", e.message, false);
            deploymentOk = false;
            output = e.message;
          }
        }
        break;
      }

      log("render-deploy", `deployment ${deployment.id} ended with ${deployment.status}`, false);
      deploymentOk = false;
      if (!isFailedRenderDeployment(deployment.status)) {
        output = `Render deployment ended in ${deployment.status} and cannot be repaired automatically.`;
        break;
      }
      const logTypes = deployment.status === "build_failed" ? ["build"] : ["build", "app"];
      try {
        const logs = await getRenderFailureLogs(renderApiKey, renderServiceId, renderService.ownerId, {
          startTime: deployment.createdAt || deployStartedAt,
          endTime: new Date().toISOString(),
          types: logTypes
        });
        if (logs) {
          output = logs;
          log("render-failure-logs", `retrieved ${logs.split("\n").length} lines from ${logTypes.join(" and ")} logs`);
        } else {
          output = `Render deployment failed with status ${deployment.status}; no build logs were returned.`;
          log("render-failure-logs", "no deployment logs were returned", false);
        }
      } catch (e) {
        output = `Render deployment failed with status ${deployment.status}. Could not retrieve logs: ${e.message}`;
        log("render-failure-logs", e.message, false);
        break;
      }

      const configurationBlockers = findConfigurationBlockers(output);
      if (configurationBlockers.length) {
        for (const blocker of configurationBlockers) log("configuration-required", blocker, false);
        output = configurationBlockers.join("\n");
        break;
      }
      if (attempt === 1 || !output) break;

      log("repair-code", `deployment repair attempt ${attempt + 1} of 1`);
      let repairFailed = false;
      const repairCommand = `${modelCommand}\n\nRender deployment failure logs:\n${output}`;
      const repairedPaths = new Set(generatedFiles.map((file) => file.path));
      try {
        const selectedFiles = await pickFiles(repairCommand, fileList);
        for (const relPath of selectedFiles) {
          if (repairedPaths.has(relPath)) continue;
          const filePath = path.join(workDir, relPath);
          let current = "";
          try {
            current = await fs.readFile(filePath, "utf8");
          } catch {
            // The model may select a new file path from the deployment error.
          }
          const repaired = await repairFileContent(repairCommand, relPath, current, output);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, repaired, "utf8");
          generatedFiles.push({ path: relPath, content: repaired });
          repairedPaths.add(relPath);
        }
      } catch (e) {
        log("repair-code", `could not select affected files: ${e.message}`, false);
        break;
      }
      for (const file of generatedFiles) {
        const filePath = path.join(workDir, file.path);
        try {
          const current = await fs.readFile(filePath, "utf8");
          const repaired = await repairFileContent(repairCommand, file.path, current, output);
          await fs.writeFile(filePath, repaired, "utf8");
          file.content = repaired;
        } catch (e) {
          log("repair-code", `${file.path}: ${e.message}`, false);
          repairFailed = true;
          break;
        }
      }
      if (repairFailed || generatedFiles.length === 0) {
        if (generatedFiles.length === 0) log("repair-code", "no generated files are available to repair", false);
        break;
      }

      let repairBuild = await runBuildAndTest(workDir, command);
      for (let buildAttempt = 1; !repairBuild.ok && buildAttempt <= 1; buildAttempt += 1) {
        log("repair-build", `local validation repair attempt ${buildAttempt}`);
        for (const file of generatedFiles) {
          const filePath = path.join(workDir, file.path);
          const current = await fs.readFile(filePath, "utf8");
          const repaired = await repairFileContent(repairCommand, file.path, current, repairBuild.output);
          await fs.writeFile(filePath, repaired, "utf8");
          file.content = repaired;
        }
        repairBuild = await runBuildAndTest(workDir, command);
      }
      log("build-test-repair", repairBuild.logs.join(" | "), repairBuild.ok);
      if (!repairBuild.ok) {
        output = repairBuild.output;
        break;
      }
      output = repairBuild.output;
      deploymentOk = true;
    }

    return {
      ok: deploymentOk,
      previewOnly: false,
      steps,
      filesChanged: [...new Set([...filesToRemove, ...targetFiles])],
      output,
      files: generatedFiles,
      deployment: deployment ? { id: deployment.id, status: deployment.status } : null,
      deployUrl: liveCheckUrl
    };
  } finally {
    await cleanup(workDir);
  }
}
