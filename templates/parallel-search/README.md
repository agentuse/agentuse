# Parallel web research

This opt-in example uses AgentUse's HTTP MCP support to search the web and read
pages with [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
The search and fetch tools work without a Parallel account or API key. Anonymous
access has lower rate limits and is intended for exploration and light use.

## Run

Requires Node.js 22+ and a connected model provider. From a checkout of this
repository, install the CLI and connect the model provider used by the example:

```bash
npm install -g agentuse
agentuse provider login
agentuse doctor templates/parallel-search/research.agentuse
agentuse run templates/parallel-search/research.agentuse "What is Model Context Protocol? Use primary sources."
```

The example uses `anthropic:claude-sonnet`. To use another connected model,
pass `--model`, for example `--model openai:gpt-5.6`. Model-provider authentication
is still required; the MCP connection itself has no authentication header.

The agent searches, fetches relevant pages, and returns a short answer with source
URLs. Edit the instructions to change the default topic. No schedule, filesystem
access, or shell access is enabled.

## Use in an existing agent

Copy this into your agent's frontmatter, alongside any existing MCP servers:

```yaml
mcpServers:
  parallel:
    url: https://search.parallel.ai/mcp
    headers:
      User-Agent: AgentUse-Parallel-Search-Example (https://github.com/agentuse/agentuse)
```

AgentUse exposes `mcp__parallel__web_search` and `mcp__parallel__web_fetch`.
The server supplies their input schemas. Search takes an `objective` and
`search_queries`; fetch takes `urls`. Reuse one `session_id` across related calls
within a run. This configuration uses Streamable HTTP and does not need a local
MCP server, an `npx` bridge, or a Parallel API key.
