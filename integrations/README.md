# AgentUse integrations

Templates for the AgentUse plugins for Claude Code and Codex. Each plugin is
only an MCP server entry pointing at AgentUse Cloud
(`https://cloud.agentuse.io/mcp`). The `agentuse`, `automate` and `triage`
workflows come from the AgentUse MCP server itself
(`src/mcp-server/prompts.ts`), so the plugins carry no copy of them. Claude Code
lists them when you type `/agentuse`. Codex shows no MCP prompts,
so there the plugin gives `@AgentUse` instead. Plain requests reach the same
workflows through `get_workflow` in both.

Build local marketplaces and release archives with:

```sh
bun run integrations:build
```

The command writes them under `dist/integrations/`. These outputs are for local
development and are not attached to GitHub Releases. Check them with:

```sh
bun run integrations:check
```
