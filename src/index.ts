#!/usr/bin/env bun
import { parseAgent } from './parser';
import { connectMCP } from './mcp';
import { runAgent } from './runner';
import { Command } from 'commander';
import { createAuthCommand } from './cli/auth';
import { logger, LogLevel } from './utils/logger';

const program = new Command();

program
  .name('openagent')
  .description('Zero-configuration CLI for AI agents')
  .version('1.0.0');

// Add auth command
program.addCommand(createAuthCommand());

program
  .command('run <file>')
  .description('Run an AI agent from a markdown file')
  .option('-q, --quiet', 'Suppress info messages (only show warnings and errors)')
  .option('-d, --debug', 'Enable verbose debug logging')
  .option('-v, --verbose', 'Show detailed execution information')
  .option('--timeout <seconds>', 'Maximum execution time in seconds (default: 300)', '300')
  .action(async (file: string, options: { quiet: boolean, debug: boolean, verbose: boolean, timeout: string }) => {
    const startTime = Date.now();
    
    try {
      // Configure logger based on flags
      if (options.quiet && options.debug) {
        throw new Error('Cannot use --quiet and --debug together');
      }
      
      if (options.quiet) {
        logger.configure({ level: LogLevel.WARN });
      } else if (options.debug) {
        logger.configure({ level: LogLevel.DEBUG, enableDebug: true });
      }
      
      // Log startup time if verbose
      if (options.verbose) {
        logger.info(`Starting OpenAgent at ${new Date().toISOString()}`);
      }
      
      // Parse timeout value
      const timeoutMs = parseInt(options.timeout) * 1000;
      if (isNaN(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Invalid timeout value. Must be a positive number of seconds.');
      }
      
      // Parse agent specification from markdown file
      const agent = await parseAgent(file);
      
      // Connect to MCP servers if configured
      const mcp = await connectMCP(agent.config.mcp_servers as any, options.debug);
      
      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);
      
      // Run the agent with timeout
      try {
        await runAgent(agent, mcp, options.debug, abortController.signal, startTime, options.verbose);
      } catch (error: any) {
        if (abortController.signal.aborted || error.name === 'AbortError') {
          logger.error(`Agent execution timed out after ${options.timeout} seconds`);
          process.exit(1);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
      
      // Exit successfully after agent completes
      process.exit(0);
    } catch (error) {
      logger.error('Error', error as Error);
      process.exit(1);
    }
  });


// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}