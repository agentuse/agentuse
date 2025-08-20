# AgentUse

Zero-configuration CLI for running AI agents with built-in Model Context Protocol (MCP) support, multi-provider compatibility, and extensible plugin system.

## Features

- 🚀 **Zero Configuration** - Run agents from simple markdown files with YAML frontmatter
- 🤖 **Multi-Provider Support** - OpenAI, Anthropic (with OAuth), OpenRouter
- 🔌 **MCP Integration** - Connect to any Model Context Protocol server
- 🧩 **Plugin System** - Extend functionality with custom plugins
- 🔄 **Sub-Agent Composition** - Agents can invoke other agents as tools
- 🌐 **Remote Agents** - Execute agents from HTTPS URLs (with security prompts)
- 💾 **Smart Context Management** - Automatic message compaction for long conversations
- 🔐 **Secure by Default** - Environment variable isolation and controlled access

## Installation

```bash
# Install globally via npm
npm install -g agentuse

# Or run directly without installation
npx agentuse run your-agent.agentuse

# Or use Bun for faster execution
bunx agentuse run your-agent.agentuse
```

### Development Setup

```bash
# Clone the repository
git clone https://github.com/agentuse/agentuse.git
cd agentuse

# Install dependencies with Bun
bun install

# Make the CLI available globally for development
bun link
```

## Quick Start

### 1. Create Your First Agent

Create a file `hello.agentuse`:

```markdown
---
model: openai:gpt-4o-mini
---

Write a friendly greeting and share an interesting tech fact!
```

### 2. Run the Agent

```bash
agentuse run hello.agentuse
```

## Agent Definition Format

Agents are defined in markdown files with YAML frontmatter:

```markdown
---
model: anthropic:claude-sonnet-4-20250514  # Required: model to use
mcp_servers:                                # Optional: MCP servers
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
subagents:                                  # Optional: sub-agents
  - path: ./reviewer.agentuse
    name: code_reviewer
    maxSteps: 30
---

# Agent Instructions

Your task is to analyze the codebase and provide insights...
```

## Model Configuration

### Supported Providers

```yaml
# OpenAI models
model: openai:gpt-4o
model: openai:gpt-4o-mini

# Anthropic models (supports OAuth)
model: anthropic:claude-3-haiku-20240307
model: anthropic:claude-sonnet-4-20250514

# OpenRouter models
model: openrouter:meta-llama/llama-3.2-11b-vision-instruct
```

### Environment Variable Management

```yaml
# Default API keys
model: openai:gpt-4o              # Uses OPENAI_API_KEY

# Custom environment variable suffix
model: openai:gpt-4o:dev          # Uses OPENAI_API_KEY_DEV

# Specific environment variable
model: openai:gpt-4o:MY_CUSTOM_KEY # Uses MY_CUSTOM_KEY
```

## MCP Server Configuration

Connect to Model Context Protocol servers for extended capabilities:

```yaml
mcp_servers:
  # File system access
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    
  # GitHub integration with controlled environment access
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    allowedEnvVars:      # Explicitly allow specific env vars
      - GITHUB_TOKEN
    
  # HTTP API server
  api_server:
    url: https://api.example.com/mcp
    headers:
      Authorization: "Bearer ${API_TOKEN}"
```

### Environment Variable Security

By default, MCP servers receive NO environment variables from `process.env`. Use `allowedEnvVars` to explicitly permit specific variables:

```yaml
mcp_servers:
  secure_server:
    command: ./server
    allowedEnvVars:        # Only these vars are passed
      - API_KEY
      - API_URL
    env:                   # Direct overrides
      DEBUG: "true"
      TIMEOUT: "30000"
```

## Sub-Agent Composition

Agents can invoke other agents as tools:

```yaml
# main.agentuse
---
model: openai:gpt-4o
subagents:
  - path: ./analyzer.agentuse
    name: code_analyzer
    maxSteps: 50
  - path: ./writer.agentuse
    name: doc_writer
---

Analyze the project and create documentation.
Use @code_analyzer to understand the code structure.
Use @doc_writer to generate the documentation.
```

## Plugin System

Extend AgentUse with custom plugins that hook into agent lifecycle events.

### Creating a Plugin

```javascript
// .agentuse/plugins/slack-notifier.js
export default {
  'agent:complete': async (event) => {
    if (event.isSubAgent) return; // Skip sub-agents
    
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `✅ Agent "${event.agent.name}" completed`,
        attachments: [{
          color: 'good',
          fields: [
            { title: 'Duration', value: `${event.result.duration.toFixed(1)}s`, short: true },
            { title: 'Tokens', value: event.result.tokens || 'N/A', short: true }
          ]
        }]
      })
    });
  }
};
```

### TypeScript Plugin

```typescript
// .agentuse/plugins/logger.ts
import type { PluginHandlers } from 'agentuse';

const plugin: PluginHandlers = {
  'agent:complete': async (event) => {
    console.log(`Agent: ${event.agent.name}`);
    console.log(`Tokens: ${event.result.tokens}`);
    console.log(`Tool calls: ${event.result.toolCalls}`);
  }
};

export default plugin;
```

Plugins load automatically from:
- `./.agentuse/plugins/*.{ts,js}` - Project plugins
- `~/.agentuse/plugins/*.{ts,js}` - Global plugins

## CLI Commands

### Run Command

```bash
agentuse run <file> [options]

Options:
  -q, --quiet              Suppress info messages
  -d, --debug              Enable debug logging
  -v, --verbose            Show detailed execution info
  --timeout <seconds>      Max execution time (default: 300)
```

### Authentication

```bash
# Set up OAuth for Anthropic
agentuse auth anthropic login

# Check auth status
agentuse auth anthropic status

# Log out
agentuse auth anthropic logout
```

## Remote Agent Execution

Run agents from HTTPS URLs with security prompts:

```bash
# Prompts for preview/confirmation
agentuse run https://example.com/agents/analyzer.agentuse
```

Security features:
- HTTPS-only URLs
- Mandatory `.agentuse` extension
- Preview option before execution
- Clear security warnings

## Advanced Features

### Context Management

AgentUse automatically manages conversation context to stay within token limits:

- Tracks token usage across messages
- Compacts conversation history when approaching limits
- Preserves important context during compaction
- Configurable via `CONTEXT_MANAGEMENT=true` environment variable

### Error Recovery

Built-in intelligent error handling:

- Automatic classification of errors (network, auth, rate limit, etc.)
- Smart retry logic for transient failures
- Helpful suggestions for recovery
- Tool errors passed to AI for adaptive responses

### Environment Variables

```bash
# API Keys
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...

# Configuration
export MAX_STEPS=2000              # Override default 1000 step limit
export CONTEXT_MANAGEMENT=true     # Enable context compaction
```

## Project Structure

```
agentuse/
├── src/
│   ├── index.ts            # CLI entry point
│   ├── runner.ts           # Agent execution engine
│   ├── parser.ts           # Agent file parser
│   ├── models.ts           # Model provider configuration
│   ├── mcp.ts              # MCP server integration
│   ├── subagent.ts         # Sub-agent tool creation
│   ├── context-manager.ts  # Token and context management
│   ├── compactor.ts        # Message compaction logic
│   ├── plugin/             # Plugin system
│   ├── auth/               # OAuth authentication
│   └── utils/              # Utilities and logging
├── examples/               # Example agents
├── store/                  # Agent library
├── docs/                   # Documentation
└── tests/                  # Test files
```

## Development

### Requirements

- [Bun](https://bun.sh) 1.0+
- Node.js 18+ (for some MCP servers)

### Testing

```bash
# Run tests
bun test

# Type checking
npx tsc --noEmit
```

### Code Style

- TypeScript with strict typing
- Async/await over callbacks
- Comprehensive error handling
- No `any` types without justification

## Examples

### Basic AI Assistant

```yaml
---
model: openai:gpt-4o-mini
---

You are a helpful AI assistant. Answer questions concisely and accurately.
```

### Code Reviewer with File Access

```yaml
---
model: anthropic:claude-sonnet-4-20250514
mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
    env:
      READ_ONLY: "true"
---

Review the code in the src/ directory and provide feedback on:
- Code quality and best practices
- Potential bugs or issues
- Performance optimizations
- Security concerns
```

### Multi-Tool Agent

```yaml
---
model: openai:gpt-4o
mcp_servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    allowedEnvVars: ["GITHUB_TOKEN"]
  
  postgres:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres"]
    allowedEnvVars: ["POSTGRES_URL"]
    
subagents:
  - path: ./sql-expert.agentuse
    name: sql_expert
---

Analyze the GitHub issues and create a summary report in the database.
Use @sql_expert for complex SQL queries.
```

## License

Apache License 2.0 - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests to our repository.

## Support

- Create an issue on GitHub for bug reports
- Check the `docs/` directory for detailed documentation
- See `examples/` for more agent examples