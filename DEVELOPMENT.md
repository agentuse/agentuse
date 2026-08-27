# Development

## Docker Sandboxes

The repository includes an optional [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) environment for contributors. It does not replace the normal host development workflow or the production `Dockerfile`. It also serves a different purpose from `scripts/serve-sandbox.sh`, which isolates a second development daemon on the host while intentionally reusing some host AgentUse state.

### Prerequisites

Install Docker Desktop with Docker Sandboxes `sbx` 0.39.0 or newer, then sign in. Docker Desktop supports macOS, Windows, and Linux desktop. On headless Linux, install and authenticate the supported `sbx` CLI and daemon for that host. Confirm the version with:

```bash
sbx version
```

Run clone mode from the repository's main checkout. Docker Sandboxes cannot create a clone-mode sandbox from a linked Git worktree. The committed `.sbxenv.yaml` selects the Codex agent, a private clone, the stable name `agentuse-dev`, and maps sandbox port 12233 to `127.0.0.1:12233` on the host.

Codex or ChatGPT authentication only authenticates the coding agent. It is not an AgentUse runtime provider login. The environment deliberately declares no AgentUse secrets, bindings, extra workspaces, or host AgentUse config mounts.

### Create, bootstrap, and smoke

From the main repository checkout:

```bash
sbx env run
```

This opens a persistent sandbox shell. In that shell:

```bash
pnpm sbx:bootstrap
pnpm sbx:smoke
```

Bootstrap installs or verifies Node.js 22+, the exact Bun version in `.tool-versions`, and the pnpm version in `package.json#packageManager`; it then runs a frozen install and build. It is safe to rerun.

The smoke command starts `agentuse setup --web --host 0.0.0.0 --no-auth` with a disposable home, config, and data directory and with common runtime-provider variables removed. The exposed bind is acceptable only because the environment maps it to host loopback. The script refuses to run unless `/run/sandbox/source` is the read-only source mount provided by a clone-mode Docker Sandbox. It exits after verifying that fresh, provider-free onboarding responds successfully.

If port 12233 is already in use, stop the host process or sandbox that owns it (`sbx ls` and `sbx ports agentuse-dev` help identify mappings). Port changes require editing a local environment override or the mapping and then removing and recreating the sandbox; environment port changes do not apply to an existing sandbox.

### Persistent lifecycle and exporting work

Leaving the shell does not erase installed tools or the private clone. Reattach with `sbx env run`; `sbx env exec -- bash` is useful for an additional persistent shell. Use `sbx stop agentuse-dev` to pause and `sbx env run` to resume.

Before removing or resetting a clone sandbox, commit and push its work, or export it with Git from the sandbox. The host checkout is read-only at `/run/sandbox/source`, and uncommitted work in the private clone is destroyed by removal. Inspect the branch and working tree before cleanup:

```bash
sbx env exec -- git status --short --branch
sbx env exec -- git log --oneline --decorate -10
sbx env rm
sbx env run
```

`sbx env rm` followed by `sbx env run` is the supported remove/recreate reset. It discards the sandbox filesystem, installed dependencies, and private clone. This environment declares no scoped secrets or global credential bindings, so removal does not manage or copy AgentUse provider credentials.
