#!/usr/bin/env node

/**
 * CLI for simple-mcp
 * Provides commands for running MCP servers from tool files
 */

import { createToolServer } from './server.js';

const command = process.argv[2];
const toolPath = process.argv[3];

function showHelp() {
  console.log(`
simple-mcp - Turn JavaScript/TypeScript functions into MCP stdio servers

Usage:
  simple-mcp serve <tool-file> [--export <name>]

Commands:
  serve <tool-file>    Start an MCP stdio server from a tool file
                       Supports both .js and .ts files

Options:
  --export <name>      Load a specific named export from the tool file
  --help, -h           Show this help message

Examples:
  # Serve all tools from a file
  simple-mcp serve ./tools/date.ts

  # Serve a specific export
  simple-mcp serve ./tools/github.ts --export getIssues

  # Use in Claude Desktop config
  {
    "mcpServers": {
      "my-tools": {
        "command": "npx",
        "args": ["simple-mcp", "serve", "/path/to/tools.ts"]
      }
    }
  }

Tool File Format:
  Your tool file should export one or more tool definitions:

  import { z } from 'zod';

  export default {
    description: 'Get current date',
    parameters: z.object({
      format: z.string().optional()
    }),
    execute: ({ format }) => {
      return new Date().toISOString();
    }
  };

  Or multiple named exports:

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
`);
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  if (command === 'serve') {
    if (!toolPath) {
      console.error('Error: Tool file path required\n');
      showHelp();
      process.exit(1);
    }

    // Parse --export flag
    const exportFlagIndex = process.argv.indexOf('--export');
    const exportName = exportFlagIndex !== -1 ? process.argv[exportFlagIndex + 1] : undefined;

    try {
      await createToolServer({
        toolPath,
        exportName
      });
    } catch (error) {
      console.error(`Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}\n`);
    showHelp();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});