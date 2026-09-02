import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'fs';

if (realpathSync(process.cwd()) !== realpathSync(process.argv[2])) process.exit(42);

const server = new McpServer({ name: 'cwd-probe', version: '1.0.0' });
await server.connect(new StdioServerTransport());
