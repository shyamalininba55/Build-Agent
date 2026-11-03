# Build Agent

A real command-to-deploy pipeline:

```
user types a command
        ↓
agent understands it (Claude)
        ↓
agent detects the project type and finds relevant files
        ↓
agent writes the new file content
        ↓
runtime-specific validation runs
  ↓
on repairable failure, AI gets up to three focused repair attempts
        ↓
      git push to an agent branch
        ↓
      GitHub pull request and required Actions checks
        ↓
      human review and merge
        ↓
      user clicks Deploy update in Build Agent
        ↓
      deploy hook starts the deployment
```

This is a real Node/Express service — it clones the repo, edits files, runs
local validation, and opens a pull request. The Deploy update control only
starts deployment after GitHub confirms the pull request is merged into `main`.

## Setup

```bash
npm install
copy .env.example .env
# edit .env and add your selected provider API key
npm start
```

Open `http://localhost:3000`.


To create a new app repository, enable **Create a new public GitHub repository**
in the form, enter a repository name, and provide a GitHub token that can create
repositories and manage pull requests. The agent initializes the repository,
generates the requested files, runs the available checks, and opens a pull
request. Leave the checkbox off to continue working with an existing repository
URL.

## Using it

For each run you provide, in the form (nothing is stored server-side between requests):

- **GitHub repo URL** — `https://github.com/owner/repo`
- **Branch** — defaults to the repo's default branch
- **GitHub token** — a fine-grained personal access token scoped to just that
  repo, with **Contents: Read and write**, **Pull requests: Read and write**,
  **Actions: Read and write**, and **Secrets: Read and write** permissions.
  Creating a new repository also
  requires repository creation permission. For organization repositories,
  make sure the organization is the token's resource owner. A 403 during PR creation includes a compare link
  for the branch already pushed.
  Create one at
  GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained tokens.
- **Deployment** — configure Render and its deploy hook in GitHub Actions
  secrets as described below. The agent does not deploy unmerged changes.
- **Command** — plain English, e.g. "add a search bar to the invoice list".

## How each step actually works

- **Find files / write code** (`lib/agent.js`) — two calls to the configured AI
  provider (Anthropic Claude by default in `.env.example`, or Google Gemini):
  one to pick which file(s) to touch from the repo's file list, one per file
  to generate its full new content. This is a straightforward first version;
  a more advanced version would work from real diffs/patches instead of
  whole-file rewrites, and use multiple turns for larger changes.
- **Local rate-limit fallback** — set `AI_FALLBACK_PROVIDER=local` and
  `LOCAL_MODEL_ID=Qwen/Qwen2.5-Coder-0.5B-Instruct` to use a downloadable,
  instruction-tuned coding model when the cloud provider reaches a quota,
  rate limit, or truncates output. Run `npm run download:model` to cache the
  model before use.   Install PyTorch, `transformers`, and `huggingface_hub[hf_xet]` in
  the Python environment used by the server; a CUDA-enabled PyTorch build uses
  an available NVIDIA GPU. Alternatively, `LOCAL_BASE_MODEL_PATH` and
  `LOCAL_ADAPTER_ZIP` can load a compatible PEFT/LoRA adapter. Neither local
  mode requires another model API key.
- **Project detection and validation** (`lib/build.js`) — detects root or
  nested Node, Python, and Flutter manifests. Node projects install with
  `npm ci` when a lockfile exists, then run available `build`, `test`, `lint`,
  and `typecheck` scripts. Python projects install their requirements, run
  `compileall`, and run `pytest` when a test directory exists. Flutter projects
  run `pub get`, `analyze`, and tests when present. Missing local toolchains and
  missing secrets are reported instead of being treated as code defects.
- **Pull request** (`lib/github.js`, `lib/pipeline.js`) — pushes to a unique
  `build-agent/*` branch and opens a PR against the selected base branch. The
  GitHub token is embedded only in the temporary clone's push URL.
- **Deploy update** (`lib/deploy.js`, `server.js`) — checks the selected PR is
  merged into `main`, then sends one POST to the configured HTTPS deploy hook.
  The app reports when the provider accepts the request; use the configured
  live site URL to check the deployed app.

## Error handling

Failed stages are tagged with categories such as API, Coding, Dependency,
Testing, Build, Git/GitHub, Deployment, Network, Security, Environment,
Database, AI-agent, and Pipeline. Coding and validation failures can receive up
to three AI repair attempts; missing tools, credentials, permissions, network
services, and security findings are reported for operator action instead of
being guessed at. Likely credential values are redacted from diagnostics, and
common secret patterns in generated files block preview and PR creation. This
is pattern-based protection, not a substitute for a dedicated secret scanner.

## Security — read this before exposing it beyond your own machine

- `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` live only in your `.env` file on the
  server; they are never sent to the browser.
- The GitHub token is supplied per-request from the browser and is never
  written to disk outside the temporary clone, which is deleted after each
  run. It **is** sent over the network to your own server on every run, so
  only run this over HTTPS if it's anywhere but `localhost`.
- Render deployment credentials are stored as GitHub Actions secrets, not in
  the browser or the agent server.
- Add `RENDER_API_KEY` directly in the target repository's GitHub Actions
  secrets; do not add it to this app's `.env`.
- Values entered on the Deploy page are sent to this app's server only for the
  GitHub secret update, encrypted with GitHub's repository public key, and not
  written to browser storage or application logs. Use HTTPS when the app server
  is not running on `localhost`.
- If you deploy this control app itself somewhere reachable by others, set
  `APP_ACCESS_KEY` in `.env` — the frontend will then be required to send it
  back as the `x-access-key` header, or requests are rejected. Without it,
  anyone who can reach the server can spend your Anthropic API credits and
  open pull requests in repositories for which they supply a token.
- Prefer fine-grained, single-repo, short-expiry GitHub tokens over classic
  tokens with broad `repo` scope, and revoke them once you're done.

## CI/CD

GitHub Actions runs the build and tests on Node.js 20, 22, and 24 for every push
and pull request. The `CI gate` job is the stable required status check. To
require approval before deployment:

This workflow protects the Build Agent repository. Repositories connected
through the agent must also have their own Actions checks and branch protection
configured on the selected base branch for the same guarantees.

1. Configure the hosting service's deploy hook and disable automatic deploy on
  push, so deployment starts from the Build Agent's **Deploy update** button.
2. In GitHub, open **Settings → Branches** (or **Rules → Rulesets**) and protect
  `main`. Require pull requests, at least one approving review, and the
  required status check **CI gate**. Block direct pushes to `main`.
3. On the app's Deploy page, fill in the deploy hook, service ID, and live URL,
  then save. The app encrypts these values as GitHub Actions secrets. Keep the
  Deploy page and Build Agent result in the same browser tab; after you merge
  the PR, click **Deploy update**. Add `RENDER_API_KEY` manually under
  **Settings → Secrets and variables → Actions** if using the optional manual
  Actions deployment workflow.

The Actions workflow runs CI only. The Build Agent verifies the PR is merged
into `main` before it triggers the deployment hook.

## Known limitations (v1)

- File edits are whole-file rewrites generated by the model, not true
  diffs/patches — fine for small, focused changes; risky for large files or
  sweeping refactors.
- Other runtimes without an implemented validator are reported as unvalidated;
  the agent does not claim their build or tests passed.
- The Deploy update button confirms the hook accepted the request; it does not
  poll deployment completion or run the post-deploy health check. Other hosting
  providers need a provider-specific deployment integration.
- AI edits remain whole-file rewrites, not patches — they are intended for
  small, focused changes and can be risky for large files or sweeping refactors.
- A successful HTTP response only confirms that the configured URL responds;
  it cannot detect application-level errors rendered in a page with HTTP 200.
- No queueing — one run at a time; a second request while one is in
  progress will start a second concurrent clone, which is fine but not
  optimized.

## Deploying this app itself

This is a normal Node service, so it deploys anywhere Node does — Render,
Railway, Fly.io, a VPS, etc. Set `ANTHROPIC_API_KEY` and `APP_ACCESS_KEY` as
environment variables on the host, and treat the URL as sensitive: it's the
front door to real git push access, gated only by whatever token the caller
supplies.
