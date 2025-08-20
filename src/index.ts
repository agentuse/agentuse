#!/usr/bin/env bun
import { parseAgent, parseAgentContent } from './parser';
import { connectMCP } from './mcp';
import { runAgent } from './runner';
import { Command } from 'commander';
import { createAuthCommand } from './cli/auth';
import { logger, LogLevel } from './utils/logger';
import { basename } from 'path';
import * as readline from 'readline';
import { PluginManager } from './plugin';

const program = new Command();

// Helper function to prompt user
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

// Helper function to fetch remote agent
async function fetchRemoteAgent(url: string): Promise<string> {
  // For localhost testing, allow self-signed certificates
  const fetchOptions: RequestInit = {};
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  
  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`Failed to fetch agent from ${url}: ${response.statusText}`);
    }
    return await response.text();
  } finally {
    // Restore certificate validation
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }
}

// Helper function to check if input is a URL
function isURL(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://');
}

program
  .name('agentuse')
  .description('Zero-configuration CLI for AI agents')
  .version('1.0.0');

// Add auth command
program.addCommand(createAuthCommand());

program
  .command('run <file>')
  .description('Run an AI agent from a markdown file or URL')
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
        logger.info(`Starting AgentUse at ${new Date().toISOString()}`);
      }
      
      // Parse timeout value
      const timeoutMs = parseInt(options.timeout) * 1000;
      if (isNaN(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Invalid timeout value. Must be a positive number of seconds.');
      }
      
      let agent;
      
      // Check if input is a URL
      if (isURL(file)) {
        // Validate HTTPS only
        if (!file.startsWith('https://')) {
          throw new Error('Only HTTPS URLs are allowed for security reasons');
        }
        
        // Validate .agentuse extension
        if (!file.endsWith('.agentuse')) {
          throw new Error('Remote agents must have .agentuse extension');
        }
        
        // Show warning and prompt
        console.log('\n⚠️  WARNING: You are about to execute an agent from:');
        console.log(file);
        console.log('\nOnly continue if you trust the source and have audited the agent.');
        
        const answer = await prompt('[p]review / [y]es / [N]o: ');
        
        let content: string;
        
        if (answer === 'p' || answer === 'preview') {
          // Fetch and show content
          logger.info('Fetching agent for preview...');
          content = await fetchRemoteAgent(file);
          console.log('\n--- Agent Content ---');
          console.log(content);
          console.log('--- End of Content ---\n');
          
          // Ask again after preview
          const confirmAnswer = await prompt('Execute this agent? [y]es / [N]o: ');
          if (confirmAnswer !== 'y' && confirmAnswer !== 'yes') {
            console.log('Aborted.');
            process.exit(0);
          }
        } else if (answer === 'y' || answer === 'yes') {
          // Fetch content
          logger.info('Fetching remote agent...');
          content = await fetchRemoteAgent(file);
        } else {
          // Default to No
          console.log('Aborted.');
          process.exit(0);
        }
        
        // Parse agent from content
        const agentName = basename(file).replace(/\.agentuse$/, '');
        agent = parseAgentContent(content!, agentName);
      } else {
        // Parse agent specification from local markdown file
        agent = await parseAgent(file);
      }
      
      // Connect to MCP servers if configured
      const mcp = await connectMCP(agent.config.mcp_servers, options.debug);
      
      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);
      
      // Initialize plugin manager before running agent
      let pluginManager: PluginManager | null = null;
      try {
        pluginManager = new PluginManager();
        await pluginManager.loadPlugins();
      } catch (pluginError) {
        logger.warn(`Failed to initialize plugins: ${(pluginError as Error).message}`);
      }
      
      // TODO: Future - emit agent:start event here
      // if (pluginManager) {
      //   await pluginManager.emitAgentStart({ ... });
      // }
      
      // Start capturing console output for plugins
      logger.startCapture();
      
      // Run the agent with timeout
      let result: any;
      try {
        // Pass the file path for sub-agent resolution (if it's a local file)
        const agentFilePath = !isURL(file) ? file : undefined;
        result = await runAgent(agent, mcp, options.debug, abortController.signal, startTime, options.verbose, agentFilePath);
      } catch (error: unknown) {
        if (abortController.signal.aborted || (error as Error).name === 'AbortError') {
          logger.error(`Agent execution timed out after ${options.timeout} seconds`);
          process.exit(1);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
      
      // Stop capturing and get console output
      const consoleOutput = logger.stopCapture();
      
      // Emit plugin event for agent completion
      if (pluginManager) {
        try {
          const duration = startTime ? (Date.now() - startTime) / 1000 : 0;
          const agentFilePath = !isURL(file) ? file : undefined;
          
          await pluginManager.emitAgentComplete({
            agent: {
              name: agent.name,
              model: agent.config.model,
              ...(agentFilePath && { filePath: agentFilePath })
            },
            result: {
              text: result.text || '',
              duration,
              tokens: result.usage?.totalTokens,
              toolCalls: result.toolCallCount || 0
            },
            isSubAgent: false,
            consoleOutput
          });
        } catch (pluginError) {
          // Don't fail the agent execution if plugins fail
          logger.warn(`Plugin event error: ${(pluginError as Error).message}`);
        }
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