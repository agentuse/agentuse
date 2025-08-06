#!/usr/bin/env bun
import { parseAgent } from './parser';
import { connectMCP } from './mcp';
import { runAgent } from './runner';
import { Command } from 'commander';
import * as fs from 'fs/promises';

const program = new Command();

program
  .name('openagent')
  .description('Zero-configuration CLI for AI agents')
  .version('1.0.0');

program
  .command('run <file>')
  .description('Run an AI agent from a markdown file')
  .action(async (file: string) => {
    try {
      // Parse agent specification from markdown file
      const agent = await parseAgent(file);
      
      // Connect to MCP servers if configured
      const mcp = await connectMCP(agent.config.mcp_servers);
      
      // Run the agent
      await runAgent(agent, mcp);
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });


// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}