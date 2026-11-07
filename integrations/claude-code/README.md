# AgentUse for Claude Code

Adds AgentUse Cloud as an MCP server, so Claude Code can reach AgentUse on your
own computer. Ask it about your agents and runs, to automate the work in this
conversation ("Use AgentUse to run this every Monday"), or to find and fix
agents that fail. Drafts and fixes open on a review page, where you turn them
on.

## Before you start

Connect your computer to AgentUse Cloud once, in the AgentUse app
(**Settings → AgentUse Cloud → Connect**) or in a terminal:

```sh
agentuse connect
```

The first time Claude Code uses the plugin, it opens AgentUse Cloud to sign
you in and asks you to allow it. See the
[AgentUse Cloud guide](https://docs.agentuse.io/guides/agentuse-cloud).

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
claude plugin marketplace add ./dist/integrations/claude-marketplace
claude plugin install agentuse@agentuse-development
```

Restart Claude Code after installation.
