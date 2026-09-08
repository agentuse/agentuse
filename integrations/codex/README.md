# AgentUse for Codex

Turn a workflow from the current Codex conversation into a focused, validated
AgentUse agent.

## Install

For normal use, install the repository skill with the cross-host Agent Skills
installer:

```sh
npx skills add agentuse/agentuse
```

Start a new Codex task, then ask Codex to use AgentUse to make the workflow
repeatable. See the [installation guide](https://docs.agentuse.io/guides/coding-agent-integrations)
for the complete authoring and validation flow.

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
codex plugin marketplace add ./dist/integrations/codex-marketplace
codex plugin add agentuse@agentuse-development
```

Start a new task after rebuilding or reinstalling the plugin.
