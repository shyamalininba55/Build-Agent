import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const modelId = process.env.LOCAL_MODEL_ID;
if (!modelId) {
  throw new Error("Set LOCAL_MODEL_ID in .env before running npm run download:model.");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON_EXECUTABLE || "python";
const downloadScript = path.join(projectRoot, "scripts", "download_model.py");
const downloader = spawn(python, [downloadScript], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true
});

downloader.on("error", (error) => {
  console.error(`Could not start model downloader: ${error.message}`);
  process.exitCode = 1;
});
downloader.on("close", (code) => {
  if (code !== 0) process.exitCode = code || 1;
});
