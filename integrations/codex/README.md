# AgentUse for Codex and ChatGPT

Adds AgentUse Cloud as an MCP server, so Codex can reach AgentUse on your own
computer. Ask it to automate the work in this conversation, or to find and fix
agents that fail. Drafts and fixes open on a review page, where you turn them
on.

## Before you start

Connect your computer to AgentUse Cloud once, in the AgentUse app
(**Settings → AgentUse Cloud → Connect**) or in a terminal:

```sh
agentuse connect
```

The first time Codex uses the plugin, it opens AgentUse Cloud to sign you in
and asks you to allow it. See the
[AgentUse Cloud guide](https://docs.agentuse.io/guides/agentuse-cloud).

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
codex plugin marketplace add ./dist/integrations/codex-marketplace
codex plugin add agentuse@agentuse-development
```

Start a new task after rebuilding or reinstalling the plugin.
