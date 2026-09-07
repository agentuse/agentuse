# AgentUse for Codex

Turn a workflow from the current Codex conversation into a focused, validated
AgentUse agent with `$automate`.

## Install a release

Download `agentuse-codex-plugin.zip` from the desired
[AgentUse release](https://github.com/agentuse/agentuse/releases) and extract it
into a persistent directory. The extraction root contains the marketplace
metadata and an `agentuse` subdirectory.

```sh
codex plugin marketplace add /absolute/path/to/extracted-codex
codex plugin add agentuse@agentuse-release
```

Use the extraction root, not its `agentuse` subdirectory, in the marketplace
command. See the [installation guide](https://docs.agentuse.io/guides/coding-agent-integrations)
for download commands, portable skills, and updates.

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
codex plugin marketplace add ./dist/integrations/codex-marketplace
codex plugin add agentuse@agentuse-development
```

Start a new task after rebuilding or reinstalling the plugin.
