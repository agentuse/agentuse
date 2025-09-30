# create-simple-mcp

> Scaffold a new [simple-mcp](../simple-mcp) tools project with one command

Quickly create a complete MCP tools project with dependencies, examples, and proper structure.

## Usage

```bash
# Using npm
npm create simple-mcp my-tools

# Using npx
npx create-simple-mcp my-tools

# Using pnpm
pnpm create simple-mcp my-tools
```

## What You Get

```
my-tools/
├── package.json          # Pre-configured with dependencies
├── tools/
│   ├── example.ts        # Example tool with HTTP requests
│   └── date.ts          # Simple date/time tool
├── README.md            # Getting started guide
└── .gitignore
```

### Pre-installed Dependencies

- ✅ `zod` - Schema validation
- ✅ `axios` - HTTP requests
- ✅ `simple-mcp` - MCP server library
- ✅ `tsx` - TypeScript execution
- ✅ `typescript` - TypeScript compiler

## Quick Start

After creating your project:

```bash
cd my-tools
npm run serve         # Test the example tool
npm run serve:date    # Test the date tool
```

## Adding New Tools

Create a new file in `tools/`:

```typescript
// tools/my-tool.ts
import { z } from 'zod';

export default {
  description: 'What your tool does',
  parameters: z.object({
    name: z.string()
  }),
  execute: ({ name }) => {
    return `Hello, ${name}!`;
  }
};
```

Then run it:

```bash
npx simple-mcp serve ./tools/my-tool.ts
```

## Adding Dependencies

```bash
npm install package-name
```

Then import in your tools:

```typescript
import something from 'package-name';

export default {
  description: 'Use the dependency',
  parameters: z.object({}),
  execute: async () => {
    const result = await something.doSomething();
    return result;
  }
};
```

## Options

```bash
# Skip automatic npm install
npm create simple-mcp my-tools --skip-install

# Show help
npm create simple-mcp --help
```

## Example: Use with Claude Desktop

After creating your project, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
      "args": ["simple-mcp", "serve", "/absolute/path/to/my-tools/tools/example.ts"]
    }
  }
}
```

## Example: Use with AgentUse

```yaml
---
tools:
  - example
  - date
---

Use the tools to help me.
```

Place tool files in `.agentuse/tools/` and reference them in your agent files.

## Related

- [simple-mcp](../simple-mcp) - The MCP server library
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [AgentUse](https://github.com/agentuse/agentuse)

## License

Apache-2.0