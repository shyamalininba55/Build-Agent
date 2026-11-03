import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const pexec = promisify(exec);
const SKIP_DIRECTORIES = new Set([".git", ".venv", "venv", "node_modules", "build", "dist", "__pycache__"]);

export function isRunnerUnavailable(output) {
  return /python is not installed|flutter is not installed|not available on PATH|command not found|not recognized as an internal or external command|ENOENT/i.test(output || "");
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function findManifests(rootDir, relativeDir = "", depth = 0) {
  if (depth > 4) return [];
  const currentDir = path.join(rootDir, relativeDir);
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        manifests.push(...await findManifests(rootDir, path.join(relativeDir, entry.name), depth + 1));
      }
      continue;
    }

    const types = {
      "package.json": "node",
      "requirements.txt": "python",
      "pyproject.toml": "python",
      "pubspec.yaml": "flutter"
    };
    if (types[entry.name]) {
      manifests.push({ type: types[entry.name], file: path.join(relativeDir, entry.name), rootDir: relativeDir });
    }
  }
  return manifests;
}

export async function detectProject(workDir, command = "") {
  const manifests = await findManifests(workDir);
  if (!manifests.length) return { type: "unknown", rootDir: "", manifests: [] };

  let preferredType;
  if (/\bflutter\b|\bdart\b/i.test(command)) preferredType = "flutter";
  else if (/\bpython\b|\bstreamlit\b|\bfastapi\b|\bflask\b/i.test(command)) preferredType = "python";
  else if (/\bnode(?:\.js)?\b|\breact\b|\bvite\b|\bnext\.js\b/i.test(command)) preferredType = "node";

  const candidates = preferredType ? manifests.filter((item) => item.type === preferredType) : manifests;
  const selected = candidates.sort((left, right) => {
    const depthDifference = left.rootDir.split(path.sep).filter(Boolean).length - right.rootDir.split(path.sep).filter(Boolean).length;
    if (depthDifference) return depthDifference;
    return ["node", "python", "flutter"].indexOf(left.type) - ["node", "python", "flutter"].indexOf(right.type);
  })[0] || manifests[0];
  return { ...selected, manifests };
}

function result(ok, logs, output, project) {
  return { ok, logs, output: output.filter(Boolean).join("\n"), projectType: project.type, projectDir: project.rootDir };
}

async function runCommand(command, label, options, logs, output) {
  try {
    const runResult = await pexec(command, options);
    output.push(runResult.stdout, runResult.stderr);
    logs.push(`${label}: ok`);
    return true;
  } catch (error) {
    output.push(error.stdout, error.stderr, error.message);
    logs.push(`${label} failed: ${error.message}`);
    return false;
  }
}

async function runNodeChecks(workDir, project, logs, output) {
  const projectDir = path.join(workDir, project.rootDir);
  const packageJson = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const options = {
    cwd: projectDir,
    timeout: 180000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` }
  };
  const installCommand = await exists(path.join(projectDir, "package-lock.json")) ? "ci" : "install";
  if (!await runCommand(`${npmCommand} ${installCommand}`, `npm ${installCommand}`, options, logs, output)) return false;

  let ranScript = false;
  for (const script of ["build", "test", "lint", "typecheck"]) {
    if (!packageJson.scripts?.[script]) continue;
    ranScript = true;
    if (!await runCommand(`${npmCommand} run ${script}`, `npm run ${script}`, options, logs, output)) return false;
  }
  if (!ranScript) {
    const available = Object.keys(packageJson.scripts || {});
    logs.push(`no build/test/lint/typecheck scripts defined${available.length ? `; available: ${available.join(", ")}` : ""}`);
  }
  return true;
}

function pythonCommand() {
  if (process.platform === "win32") {
    const windowsPython = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe");
    return exists(windowsPython).then((found) => found ? `"${windowsPython}"` : "python");
  }
  return Promise.resolve("python3");
}

export function pythonInstallCommand(executable, project, hasTests) {
  const testRunner = hasTests ? " pytest" : "";
  if (path.basename(project.file) === "requirements.txt") {
    return `${executable} -m pip install -r "${path.basename(project.file)}"${testRunner}`;
  }
  return `${executable} -m pip install .${testRunner}`;
}

async function runPythonChecks(workDir, project, logs, output) {
  const projectDir = path.join(workDir, project.rootDir);
  const executable = await pythonCommand();
  const options = { cwd: projectDir, timeout: 300000, maxBuffer: 5 * 1024 * 1024, env: process.env };
  const hasTests = await exists(path.join(projectDir, "tests")) || await exists(path.join(projectDir, "test"));

  const installLabel = hasTests ? "Python dependencies and test runner" : "Python dependencies";
  if (!await runCommand(pythonInstallCommand(executable, project, hasTests), installLabel, options, logs, output)) return false;

  if (!await runCommand(`${executable} -m compileall -q .`, "Python compile check", options, logs, output)) return false;

  if (hasTests && !await runCommand(`${executable} -m pytest`, "Python tests", options, logs, output)) return false;
  if (!hasTests) logs.push("no Python tests directory found; compile check completed");
  return true;
}

async function runFlutterChecks(workDir, project, logs, output) {
  const projectDir = path.join(workDir, project.rootDir);
  const options = { cwd: projectDir, timeout: 300000, maxBuffer: 5 * 1024 * 1024, env: process.env };
  if (!await runCommand("flutter pub get", "Flutter dependencies", options, logs, output)) return false;
  if (!await runCommand("flutter analyze", "Flutter analyze", options, logs, output)) return false;
  if (await exists(path.join(projectDir, "test")) && !await runCommand("flutter test", "Flutter tests", options, logs, output)) return false;
  if (!await exists(path.join(projectDir, "test"))) logs.push("no Flutter test directory found; analyze completed");
  return true;
}

export async function runBuildAndTest(workDir, command = "") {
  const logs = [];
  const output = [];
  const project = await detectProject(workDir, command);
  logs.push(`detected ${project.type} project${project.rootDir ? ` at ${project.rootDir}` : " at repository root"}`);

  if (project.type === "node") return result(await runNodeChecks(workDir, project, logs, output), logs, output, project);
  if (project.type === "python") return result(await runPythonChecks(workDir, project, logs, output), logs, output, project);
  if (project.type === "flutter") return result(await runFlutterChecks(workDir, project, logs, output), logs, output, project);

  logs.push("no supported project manifest found; local validation skipped");
  return result(true, logs, output, project);
}
