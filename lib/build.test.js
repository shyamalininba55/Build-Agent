import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { detectProject, isRunnerUnavailable, pythonInstallCommand } from "./build.js";

async function withProject(files, run) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "build-agent-test-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(workDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    }
    await run(workDir);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

test("detects Node projects at repository root", async () => {
  await withProject({ "package.json": "{}" }, async (workDir) => {
    const project = await detectProject(workDir);
    assert.equal(project.type, "node");
    assert.equal(project.rootDir, "");
  });
});

test("detects Python projects in nested folders", async () => {
  await withProject({ "postgresql project/requirements.txt": "streamlit\n" }, async (workDir) => {
    const project = await detectProject(workDir);
    assert.equal(project.type, "python");
    assert.equal(project.rootDir, path.join("postgresql project"));
  });
});

test("selects the requested Flutter project in a mixed repository", async () => {
  await withProject({
    "package.json": "{}",
    "mobile/pubspec.yaml": "name: sample\n"
  }, async (workDir) => {
    const project = await detectProject(workDir, "Fix the Flutter application");
    assert.equal(project.type, "flutter");
    assert.equal(project.rootDir, "mobile");
  });
});

test("does not classify a missing local toolchain as an application error", () => {
  assert.equal(isRunnerUnavailable("flutter: command not found"), true);
  assert.equal(isRunnerUnavailable("npm test failed: assertion error"), false);
});

test("installs pytest with Python dependencies only when test directories exist", () => {
  const executable = '"python"';
  assert.equal(
    pythonInstallCommand(executable, { file: "requirements.txt" }, true),
    '"python" -m pip install -r "requirements.txt" pytest'
  );
  assert.equal(
    pythonInstallCommand(executable, { file: "requirements.txt" }, false),
    '"python" -m pip install -r "requirements.txt"'
  );
  assert.equal(
    pythonInstallCommand(executable, { file: "pyproject.toml" }, true),
    '"python" -m pip install . pytest'
  );
});