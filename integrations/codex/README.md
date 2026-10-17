# AgentUse for Codex and ChatGPT

Adds AgentUse Cloud as an MCP server, so Codex can reach AgentUse on your own
computer. Ask it about your agents and runs, to automate the work in this conversation, or to find and fix
agents that fail. Drafts and fixes open on a review page, where you turn them
on.

## Before you start

Connect your computer to AgentUse Cloud once, in the AgentUse app
(**Settings → AgentUse Cloud → Connect**) or in a terminal:

```sh
agentuse connect
```

After installing the plugin with the Codex CLI, start its OAuth sign-in:

```sh
codex mcp login agentuse
```

Finish sign-in and consent in the browser, then start a new Codex task. Connecting
your computer with `agentuse connect` and authorizing Codex are separate steps.
`codex plugin add` installs the plugin but does not start OAuth, even when the
marketplace declares authentication on install.

If AgentUse is mentioned in a chat but no tools appear, check Codex's MCP status
and run `codex mcp login agentuse`. A new chat alone does not sign you in. See the
[AgentUse Cloud guide](https://docs.agentuse.io/guides/agentuse-cloud).

## Local development

Build with `bun run integrations:build` from the repository root, then add the
generated marketplace and install the plugin:

```sh
codex plugin marketplace add ./dist/integrations/codex-marketplace
codex plugin add agentuse@agentuse-development
codex mcp login agentuse
```

Start a new task after rebuilding or reinstalling the plugin.
