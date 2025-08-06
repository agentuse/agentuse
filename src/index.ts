#!/usr/bin/env bun
import { parseAgent } from './parser';
import { connectMCP } from './mcp';
import { runAgent } from './runner';
import { Command } from 'commander';

const program = new Command();

program
  .name('openagent')
  .description('Zero-configuration CLI for AI agents')
  .version('1.0.0');

program
  .command('run <file>')
  .description('Run an AI agent from a markdown file')
  .option('--debug', 'Enable verbose debug logging')
  .option('--timeout <seconds>', 'Maximum execution time in seconds (default: 300)', '300')
  .action(async (file: string, options: { debug: boolean, timeout: string }) => {
    try {
      // Parse timeout value
      const timeoutMs = parseInt(options.timeout) * 1000;
      if (isNaN(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Invalid timeout value. Must be a positive number of seconds.');
      }
      
      // Parse agent specification from markdown file
      const agent = await parseAgent(file);
      
      // Connect to MCP servers if configured
      const mcp = await connectMCP(agent.config.mcp_servers, options.debug);
      
      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);
      
      // Run the agent with timeout
      try {
        await runAgent(agent, mcp, options.debug, abortController.signal);
      } catch (error: any) {
        if (abortController.signal.aborted || error.name === 'AbortError') {
          console.error(`\n⏱️ Agent execution timed out after ${options.timeout} seconds`);
          process.exit(1);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
      
      // Exit successfully after agent completes
      process.exit(0);
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