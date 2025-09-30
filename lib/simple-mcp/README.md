# simple-mcp

> The simplest way to turn JavaScript/TypeScript functions into MCP stdio servers

`simple-mcp` makes it dead simple to create [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers from plain JavaScript/TypeScript functions. No boilerplate, no complexity—just write your functions and go.

## Features

- ✅ **File-first**: Drop a `.ts` or `.js` file → instant MCP server
- ✅ **Stdio transport**: Perfect for subprocess spawning (Claude Desktop, AgentUse, etc.)
- ✅ **Type-safe**: Zod schema validation built-in
- ✅ **Zero config**: Sensible defaults, optional customization
- ✅ **CLI included**: Standalone server or programmatic use

## Installation

### Create a New Project (Recommended)

The easiest way to get started:

```bash
npm create simple-mcp my-tools
cd my-tools
npm run serve
```

This scaffolds a complete project with dependencies, examples, and proper structure.

### Manual Installation

```bash
# Global installation (for CLI use)
npm install -g simple-mcp

# Or as a dependency (for programmatic use)
npm install simple-mcp
```

## Quick Start

### Option 1: Use create-simple-mcp (Easiest)

```bash
npm create simple-mcp my-tools
cd my-tools
npm run serve
```

You get a complete project with working examples. See [create-simple-mcp](../create-simple-mcp) for details.

### Option 2: Manual Setup

### 1. Write Your Tool

Create a file `tools/date.ts`:

```typescript
import { z } from 'zod';

export default {
  description: 'Get current date and time',
  parameters: z.object({
    format: z.enum(['iso', 'locale', 'unix']).optional()
  }),
  execute: ({ format = 'iso' }) => {
    const now = new Date();
    switch (format) {
      case 'locale': return now.toLocaleString();
      case 'unix': return now.getTime().toString();
      default: return now.toISOString();
    }
  }
};
```

### 2. Run It

```bash
# Start an MCP server
simple-mcp serve ./tools/date.ts
```

That's it! Your function is now an MCP server.

## Usage

### CLI Usage

```bash
# Serve all tools from a file
simple-mcp serve ./tools.ts

# Serve a specific export
simple-mcp serve ./tools.ts --export getCurrentTime

# Get help
simple-mcp --help
```

### Programmatic Usage

```typescript
import { createToolServer, createMCPCommand } from 'simple-mcp';

// Start a server directly
await createToolServer({
  toolPath: './tools/date.ts'
});

// Or get command config for spawning
const { command, args, env } = createMCPCommand({
  toolPath: './tools/date.ts',
  exportName: 'getCurrentTime' // optional
});

// Use with child_process
import { spawn } from 'child_process';
const server = spawn(command, args, { env });
```

### Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
      "args": ["simple-mcp", "serve", "/absolute/path/to/tools.ts"]
    }
  }
}
```

## Tool File Format

### Single Tool (Default Export)

```typescript
import { z } from 'zod';

export default {
  description: 'What the tool does',
  parameters: z.object({
    param1: z.string(),
    param2: z.number().optional()
  }),
  execute: async (params, context?) => {
    // Your logic here
    return 'result';
  }
};
```

### Multiple Tools (Named Exports)

```typescript
import { z } from 'zod';

export const getTodayDate = {
  description: 'Get today\\'s date',
  parameters: z.object({}),
  execute: () => new Date().toISOString()
};

export const getCurrentTime = {
  description: 'Get current time',
  parameters: z.object({}),
  execute: () => new Date().toLocaleTimeString()
};
```

### Tool Context

Tools receive an optional `context` parameter with useful information:

```typescript
export default {
  description: 'Example tool with context',
  parameters: z.object({}),
  execute: async (params, context) => {
    console.log(context.sessionId);     // Session identifier
    console.log(context.callId);        // Call identifier
    console.log(context.agent);         // Agent name
    console.log(context.workingDirectory); // CWD
    console.log(context.projectRoot);   // Project root

    // Report progress
    context.metadata({
      title: 'Processing',
      progress: 50,
      metadata: { step: 1 }
    });

    // Check for cancellation
    if (context.abort.aborted) {
      throw new Error('Cancelled');
    }

    return 'result';
  }
};
```

## Environment Variables

- `SIMPLE_MCP_SESSION_ID` - Session identifier (default: 'default')
- `SIMPLE_MCP_AGENT` - Agent name (default: 'simple-mcp')
- `SIMPLE_MCP_PROJECT_ROOT` - Project root directory (default: cwd)

Also supports AgentUse environment variables:
- `AGENTUSE_SESSION_ID`
- `AGENTUSE_AGENT_NAME`
- `AGENTUSE_PROJECT_ROOT`

## TypeScript Support

`.ts` files are automatically handled using `tsx`. Make sure you have it installed:

```bash
npm install -g tsx
# or let npx handle it automatically
```

## Dependencies

### If Using create-simple-mcp

Your project comes with `zod` and `axios` pre-installed. Add more as needed:

```bash
npm install octokit
```

### Manual Setup

Create a `package.json` in your tools directory and install dependencies:

```bash
cd .agentuse  # or wherever your tools are
npm init -y
npm install zod axios octokit
```

### Example with Dependencies

```typescript
import axios from 'axios';
import { Octokit } from 'octokit';

export default {
  description: 'Fetch GitHub issues',
  parameters: z.object({ repo: z.string() }),
  execute: async ({ repo }) => {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data } = await octokit.request('GET /repos/{repo}/issues', { repo });
    return JSON.stringify(data);
  }
};
```

## Comparison with Other Tools

| Feature | simple-mcp | easy-mcp | mcp-lite | mcp-framework |
|---------|-----------|----------|----------|---------------|
| File-first | ✅ | ❌ | ❌ | ✅ |
| Stdio transport | ✅ | ✅ | ❌ (HTTP) | ✅ |
| Zero boilerplate | ✅ | ❌ | ❌ | ✅ |
| CLI included | ✅ | ❌ | ❌ | ✅ |
| TypeScript auto-load | ✅ | ✅ | ❌ | ✅ |

## Examples

See `examples/` directory (coming soon) or check out [AgentUse](https://github.com/agentuse/agentuse) which uses `simple-mcp` for custom tools.

## API Reference

### `createToolServer(options)`

Start an MCP stdio server.

```typescript
interface CreateServerOptions {
  toolPath: string;      // Path to tool file
  exportName?: string;   // Optional: specific export
  env?: Record<string, string>; // Optional: env vars
}
```

### `createMCPCommand(options)`

Get command configuration for spawning a server.

```typescript
const { command, args, env } = createMCPCommand({
  toolPath: './tools.ts',
  exportName: 'myTool'  // optional
});
```

Returns:

```typescript
interface MCPCommand {
  command: string;  // 'node' or 'npx'
  args: string[];   // CLI arguments
  env?: Record<string, string>; // Environment variables
}
```

### `loadToolModule(toolPath)`

Load and validate a tool module.

```typescript
const tools = await loadToolModule('./tools.ts');
```

### `zodToJsonSchema(schema)`

Convert Zod schema to JSON Schema.

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'simple-mcp';

const schema = z.object({ name: z.string() });
const jsonSchema = zodToJsonSchema(schema);
```

## License

Apache-2.0

## Contributing

Contributions welcome! This library was extracted from [AgentUse](https://github.com/agentuse/agentuse) to make it reusable across projects.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - The MCP specification
- [AgentUse](https://github.com/agentuse/agentuse) - AI agent runner that uses simple-mcp
- [Claude Desktop](https://claude.ai/download) - Anthropic's desktop app with MCP support