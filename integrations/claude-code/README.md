# AgentUse for Claude Code

Turn a workflow from the current Claude Code conversation into a focused,
validated AgentUse agent with `/agentuse:automate`.

## Install a release

Download `agentuse-claude-plugin.zip` from the desired
[AgentUse release](https://github.com/agentuse/agentuse/releases) and extract it
into a persistent directory. The extraction root contains the marketplace
metadata and an `agentuse` subdirectory.

```sh
claude plugin marketplace add /absolute/path/to/extracted-claude
claude plugin install agentuse@agentuse-release
```

Use the extraction root, not its `agentuse` subdirectory, in the marketplace
command. See the [installation guide](https://docs.agentuse.io/guides/coding-agent-integrations)
for download commands, portable skills, and updates.

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
claude plugin marketplace add ./dist/integrations/claude-marketplace
claude plugin install agentuse@agentuse-development
```

Restart Claude Code after installation.
