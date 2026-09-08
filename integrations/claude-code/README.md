# AgentUse for Claude Code

Turn a workflow from the current Claude Code conversation into a focused,
validated AgentUse agent.

## Install

For normal use, install the repository skill with the cross-host Agent Skills
installer:

```sh
npx skills add agentuse/agentuse
```

Restart Claude Code, then ask it to use AgentUse to make the workflow
repeatable. See the [installation guide](https://docs.agentuse.io/guides/coding-agent-integrations)
for the complete authoring and validation flow.

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
claude plugin marketplace add ./dist/integrations/claude-marketplace
claude plugin install agentuse@agentuse-development
```

Restart Claude Code after installation.
