import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "local_model_worker.py");
let worker;
let nextRequestId = 1;

export function isLocalModelConfigured() {
  return Boolean(
    process.env.LOCAL_MODEL_ID ||
    (process.env.LOCAL_BASE_MODEL_PATH && (process.env.LOCAL_ADAPTER_PATH || process.env.LOCAL_ADAPTER_ZIP))
  );
}

function rejectPending(currentWorker, error) {
  for (const pending of currentWorker.pending.values()) pending.reject(error);
  currentWorker.pending.clear();
}

function handleWorkerLine(currentWorker, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    rejectPending(currentWorker, new Error(`Local model worker returned invalid JSON: ${error.message}`));
    currentWorker.child.kill();
    return;
  }

  const pending = currentWorker.pending.get(message.id);
  if (!pending) return;
  currentWorker.pending.delete(message.id);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.text);
}

function startWorker() {
  if (!isLocalModelConfigured()) {
    throw new Error("Local model requires LOCAL_MODEL_ID or LOCAL_BASE_MODEL_PATH plus LOCAL_ADAPTER_PATH (or LOCAL_ADAPTER_ZIP).");
  }

  const child = spawn(process.env.PYTHON_EXECUTABLE || "python", [scriptPath], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const currentWorker = { child, pending: new Map(), outputBuffer: "" };
  worker = currentWorker;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    currentWorker.outputBuffer += chunk;
    let newline = currentWorker.outputBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = currentWorker.outputBuffer.slice(0, newline).trim();
      currentWorker.outputBuffer = currentWorker.outputBuffer.slice(newline + 1);
      if (line) handleWorkerLine(currentWorker, line);
      newline = currentWorker.outputBuffer.indexOf("\n");
    }
  });
  child.on("error", (error) => {
    rejectPending(currentWorker, new Error(`Could not start local model worker: ${error.message}`, { cause: error }));
    if (worker === currentWorker) worker = null;
  });
  child.on("close", (code, signal) => {
    const error = new Error(`Local model worker exited${code === null ? ` after signal ${signal}` : ` with code ${code}`}.`);
    rejectPending(currentWorker, error);
    if (worker === currentWorker) worker = null;
  });
  return currentWorker;
}

export function generateWithLocalModel(system, user, maxTokens) {
  const currentWorker = worker || startWorker();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    currentWorker.pending.set(id, { resolve, reject });
    currentWorker.child.stdin.write(
      `${JSON.stringify({ id, system, user, maxTokens })}\n`,
      (error) => {
        if (!error) return;
        currentWorker.pending.delete(id);
        reject(new Error(`Could not send request to local model worker: ${error.message}`, { cause: error }));
      }
    );
  });
}

export function closeLocalModel() {
  const currentWorker = worker;
  if (!currentWorker) return Promise.resolve();
  worker = null;
  return new Promise((resolve) => {
    currentWorker.child.once("close", resolve);
    currentWorker.child.stdin.end();
  });
}
