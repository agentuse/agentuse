# AgentUse integrations

Templates for the AgentUse plugins for Claude Code and Codex. Each plugin is
only an MCP server entry pointing at AgentUse Cloud
(`https://cloud.agentuse.io/mcp`). The `/agentuse`, `/automate` and `/triage` prompts come
from the AgentUse MCP server itself (`src/mcp-server/prompts.ts`), so the
plugins carry no copy of them.

Build local marketplaces and release archives with:

```sh
bun run integrations:build
```

The command writes them under `dist/integrations/`. These outputs are for local
development and are not attached to GitHub Releases. Check them with:

```sh
bun run integrations:check
```
