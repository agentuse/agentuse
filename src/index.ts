#!/usr/bin/env bun
import { parseAgent, parseAgentContent } from './parser';
import { connectMCP } from './mcp';
import { runAgent } from './runner';
import { Command } from 'commander';
import { createAuthCommand } from './cli/auth';
import { createSessionsCommand } from './cli/sessions';
import { createServeCommand } from './cli/serve';
import { createModelsCommand } from './cli/models';
import { createSkillsCommand } from './cli/skills';
import { logger, LogLevel } from './utils/logger';
import { basename, resolve, dirname, join } from 'path';
import * as readline from 'readline';
import { PluginManager } from './plugin';
import { version as packageVersion } from '../package.json';
import { existsSync as existsSyncFs } from 'fs';

// Detect if running from a linked/local development build
function getVersionString(): string {
  const packageRoot = join(__dirname, '..');
  const isLocalDev = existsSyncFs(join(packageRoot, '.git'));
  return isLocalDev ? `${packageVersion} (local)` : packageVersion;
}

const version = getVersionString();
import { AuthenticationError } from './models';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolveProjectContext } from './utils/project';
import { resolveTimeout } from './utils/config';
import { printLogo } from './utils/branding';

const program = new Command();

// Helper function to prompt user
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve, reject) => {
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('Interrupted'));
    });

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
  .description('Run AI agents from natural language markdown files')
  .version(version)
  .showHelpAfterError('(add --help for additional information)')
  .configureOutput({
    outputError: (str, write) => {
      // For missing required arguments, show help instead of just error
      if (str.includes('missing required argument')) {
        program.outputHelp();
        write('\n' + str);
      } else {
        write(str);
      }
    }
  });

// Add auth command
program.addCommand(createAuthCommand());

// Add sessions command
program.addCommand(createSessionsCommand());

// Add serve command
program.addCommand(createServeCommand());

// Add models command
program.addCommand(createModelsCommand());

// Add skills command
program.addCommand(createSkillsCommand());

program
  .command('run <file> [prompt...]')
  .description('Run an AI agent from a markdown file or URL, optionally appending a prompt')
  .option('-q, --quiet', 'Suppress info messages (only show warnings and errors)')
  .option('-d, --debug', 'Enable debug mode with detailed logging and full error messages')
  .option('--timeout <seconds>', 'Maximum execution time in seconds (default: 300)', '300')
  .option('-C, --directory <path>', 'Run as if agentuse was started in <path> instead of the current directory')
  .option('--env-file <path>', 'Path to custom .env file')
  .option('-m, --model <model>', 'Override the model specified in the agent file')
  .action(async (file: string, promptArgs: string[], options: { quiet: boolean, debug: boolean, timeout: string, directory?: string, envFile?: string, model?: string }) => {
    const startTime = Date.now();
    let originalCwd: string | undefined;

    try {
      // Configure logger based on flags
      if (options.quiet && options.debug) {
        throw new Error('Cannot use --quiet and --debug together');
      }

      process.env.AGENTUSE_DEBUG = options.debug ? 'true' : 'false';

      if (options.quiet) {
        logger.configure({ level: LogLevel.WARN });
      } else if (options.debug) {
        logger.configure({ level: LogLevel.DEBUG, enableDebug: true });
      }

      // Show ASCII logo (unless in quiet mode)
      if (!options.quiet) {
        printLogo();
      }

      // Log startup time if debug
      if (options.debug) {
        logger.info(`Starting AgentUse at ${new Date().toISOString()}`);
      }
      
      // Parse CLI timeout value (will be used as override later)
      const timeoutWasExplicit = process.argv.includes('--timeout');
      const cliTimeoutSeconds = parseInt(options.timeout);
      if (isNaN(cliTimeoutSeconds) || cliTimeoutSeconds <= 0) {
        throw new Error('Invalid timeout value. Must be a positive number of seconds.');
      }

      // Parse MAX_STEPS env var if present (CLI override)
      const cliMaxSteps = process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS) : undefined;
      if (cliMaxSteps !== undefined && (isNaN(cliMaxSteps) || cliMaxSteps <= 0)) {
        throw new Error('Invalid MAX_STEPS value. Must be a positive integer.');
      }
      
      // Change working directory first if -C/--directory was specified
      originalCwd = process.cwd();
      if (options.directory) {
        const targetDir = resolve(options.directory);
        if (!existsSync(targetDir)) {
          throw new Error(`Directory not found: ${options.directory}`);
        }
        logger.debug(`Changing working directory from ${originalCwd} to ${targetDir}`);
        process.chdir(targetDir);
      }

      // Now detect project root from current directory (after potential cd)
      const projectContext = resolveProjectContext(process.cwd(), {
        ...(options.envFile && { envFile: options.envFile }),
      });
      logger.info(`Using project root: ${projectContext.projectRoot}`);

      // Initialize storage and session manager
      let sessionManager;
      try {
        const { initStorage } = await import('./storage/index.js');
        const { SessionManager } = await import('./session/index.js');

        await initStorage(projectContext.projectRoot);
        sessionManager = new SessionManager();

        logger.debug('Session storage initialized');
      } catch (storageError) {
        logger.warn(`Failed to initialize session storage: ${(storageError as Error).message}`);
      }

      // Load environment variables from resolved env file
      if (existsSync(projectContext.envFile)) {
        logger.info(`Loading environment from: ${projectContext.envFile}`);
        // @ts-ignore - quiet option exists but may not be in types
        dotenv.config({ path: projectContext.envFile, quiet: true });
      } else if (options.envFile) {
        // If explicitly specified but not found, error
        throw new Error(`Environment file not found: ${options.envFile}`);
      } else {
        logger.debug(`No .env file found at ${projectContext.envFile}, using system environment variables`);
      }

      // Join additional prompt arguments if provided
      const additionalPrompt = promptArgs.length > 0 ? promptArgs.join(' ') : null;

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
      
      // Keep additional prompt separate (don't concatenate)
      if (additionalPrompt && options.debug) {
        logger.info(`Additional user prompt: ${additionalPrompt}`);
      }

      // Override model if specified via CLI
      if (options.model) {
        // Validate model format (provider:model or provider:model:env)
        const modelParts = options.model.split(':');
        if (modelParts.length < 2) {
          throw new Error(`Invalid model format '${options.model}'. Expected format: provider:model or provider:model:env (e.g., openai:gpt-5, anthropic:claude-sonnet-4-0:dev)`);
        }

        const [provider] = modelParts;
        const validProviders = ['anthropic', 'openai'];
        if (!validProviders.includes(provider)) {
          throw new Error(`Invalid model provider '${provider}'. Supported providers: ${validProviders.join(', ')}`);
        }

        const originalModel = agent.config.model;
        agent.config.model = options.model;
        logger.info(`Model override: ${originalModel} → ${options.model}`);

        // Warn if provider-specific options don't match the new provider
        if (agent.config.openai && provider !== 'openai') {
          logger.warn(`Warning: OpenAI-specific options in config will be ignored with ${provider} model`);
        }
      }

      // Determine effective timeout (precedence: CLI > agent YAML > default)
      const effectiveTimeoutSeconds = resolveTimeout(
        cliTimeoutSeconds,
        timeoutWasExplicit,
        agent.config.timeout
      );
      const timeoutMs = effectiveTimeoutSeconds * 1000;

      // Connect to MCP servers if configured
      // Pass the agent file's directory as base path for resolving relative paths
      // Since we've already changed directory, resolve the file path from the new CWD
      const agentFilePath = !isURL(file) ? resolve(file) : undefined;
      const mcpBasePath = agentFilePath ? dirname(agentFilePath) : undefined;
      let mcp;
      try {
        mcp = await connectMCP(agent.config.mcpServers, options.debug, mcpBasePath);
      } catch (mcpError: any) {
        // Exit immediately on MCP connection errors (especially missing required env vars)
        if (mcpError.fatal || mcpError.message?.includes('Missing required environment variables')) {
          process.exit(1);
        }
        throw mcpError;
      }
      
      // Create abort controller for timeout
      const abortController = new AbortController();
      let wasInterrupted = false;  // Track if abort was from user interrupt vs timeout
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);

      // Handle Ctrl-C gracefully
      let sigintCount = 0;
      const sigintHandler = () => {
        sigintCount++;

        if (sigintCount === 1) {
          console.log('\n⚠️  Interrupting...');
          wasInterrupted = true;  // Mark as user interrupt
          abortController.abort();  // Trigger existing abort mechanism

          // Give cleanup 2 seconds, then force exit if still hanging
          setTimeout(() => {
            console.log('\n⚠️  Force exiting...');
            process.exit(130);
          }, 2000);
        } else {
          // Second Ctrl-C - immediate exit (if cleanup is taking too long)
          console.log('\n⚠️  Force exiting...');
          process.exit(130);
        }
      };
      process.on('SIGINT', sigintHandler);

      // Initialize plugin manager before running agent with project-specific plugin directories
      let pluginManager: PluginManager | null = null;
      try {
        pluginManager = new PluginManager();
        await pluginManager.loadPlugins(projectContext.pluginDirs);
        if (projectContext.pluginDirs.length > 0) {
          logger.debug(`Loading plugins from: ${projectContext.pluginDirs.join(', ')}`);
        }
      } catch (pluginError) {
        logger.warn(`Failed to initialize plugins: ${(pluginError as Error).message}`);
      }
      
      // TODO: Future - emit agent:start event here
      // if (pluginManager) {
      //   await pluginManager.emitAgentStart({ ... });
      // }

      // Start capturing console output for plugins
      logger.startCapture();

      // Log agent information
      logger.info(`Running agent: ${agent.name}`);
      if (agent.description) {
        logger.info(`Description: ${agent.description}`);
      }

      // Run the agent with timeout
      let result: any;
      try {
        if (agentFilePath && options.debug) {
          logger.debug(`[Main] Passing agent file path to runner: ${agentFilePath}`);
        }
        result = await runAgent(
          agent,
          mcp,
          options.debug,
          abortController.signal,
          startTime,
          options.debug,
          agentFilePath,
          cliMaxSteps,
          sessionManager,
          { projectRoot: projectContext.projectRoot, cwd: process.cwd() },
          additionalPrompt || undefined
        );

        if (!result.hasTextOutput) {
          logger.warn('Agent completed without producing a final response.');
        }

        if (result.finishReason && result.finishReason !== 'stop') {
          if (result.finishReason === 'unknown') {
            logger.warn('Agent finished without reporting a reason; output may be incomplete.');
          } else {
            logger.warn(`Agent stopped with finish reason: ${result.finishReason}. Output may be incomplete.`);
          }
        }
      } catch (error: unknown) {
        if (abortController.signal.aborted || (error as Error).name === 'AbortError') {
          if (wasInterrupted) {
            // User pressed Ctrl-C - clean exit with standard interrupt code
            logger.info('Agent execution interrupted by user.');
            process.exit(130);
          } else {
            // Actual timeout
            logger.error(`
⚠️  EXECUTION TIMEOUT

Agent execution timed out after ${effectiveTimeoutSeconds} seconds (${Math.floor(effectiveTimeoutSeconds / 60)} minutes).

The task may require more time to complete. Try one of these solutions:

1. Add timeout to your agent YAML file:
   timeout: 600  # 10 minutes
   timeout: 1200  # 20 minutes

2. Or increase timeout using --timeout flag:
   agentuse run --timeout 600 ${file}  (10 minutes)
   agentuse run --timeout 1200 ${file}  (20 minutes)

3. Break your task into smaller sub-agents (see docs on subagents)

4. Optimize your agent to use fewer tool calls

Current timeout: ${effectiveTimeoutSeconds}s`);
            process.exit(1);
          }
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        process.off('SIGINT', sigintHandler);
      }

      // Stop capturing and get console output
      const consoleOutput = logger.stopCapture();
      
      // Emit plugin event for agent completion
      if (pluginManager) {
        try {
          const duration = startTime ? (Date.now() - startTime) / 1000 : 0;
          // agentFilePath already resolved before directory change
          
          await pluginManager.emitAgentComplete({
            agent: {
              name: agent.name,
              model: agent.config.model,
              ...(agent.description && { description: agent.description }),
              ...(agentFilePath && { filePath: agentFilePath })
            },
            result: {
              text: result.text || '',
              duration,
              tokens: result.usage?.totalTokens,
              toolCalls: result.toolCallCount || 0,
              ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces }),
              ...(result.finishReason && { finishReason: result.finishReason }),
              ...(result.finishReasons && { finishReasons: result.finishReasons }),
              hasTextOutput: result.hasTextOutput
            },
            isSubAgent: false,
            consoleOutput
          });
        } catch (pluginError) {
          // Don't fail the agent execution if plugins fail
          logger.warn(`Plugin event error: ${(pluginError as Error).message}`);
        }
      }

      // Restore original working directory if changed
      if (options.directory && originalCwd && originalCwd !== process.cwd()) {
        process.chdir(originalCwd);
        logger.debug(`Restored working directory to ${originalCwd}`);
      }

      // Exit successfully after agent completes
      process.exit(0);
    } catch (error) {
      // Restore original working directory if changed
      if (options.directory && originalCwd && originalCwd !== process.cwd()) {
        process.chdir(originalCwd);
      }

      // Check if it's an authentication error
      if (error instanceof AuthenticationError) {
        console.error(`\n[ERROR] ${error.message}`);
        console.error('');
        console.error('To authenticate, run:');
        console.error('  agentuse auth login');
        console.error('');
        console.error('Or set your API key:');
        console.error(`  export ${error.envVar}='your-key-here'`);
        console.error('');
        console.error('For more options: agentuse auth --help');
        process.exit(1);
      }
      
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