#!/usr/bin/env bun
import { parseAgent, parseAgentContent, ConfigError } from './parser';
import { connectMCP } from './mcp';
import { runAgent, prepareAgentExecution, applyResumeToolResult, restoreResumeToolResult, type PreparedAgentExecution } from './runner';
import { isApprovalEnabled } from './runner/approval';
import { Command } from 'commander';
import { createProviderCommand, createAuthCommand } from './cli/auth';
import { AuthStorage } from './auth/storage';
import { createSessionsCommand } from './cli/sessions';
import { createServeCommand } from './cli/serve';
import { createModelsCommand } from './cli/models';
import { createSkillsCommand } from './cli/skills';
import { createBenchmarkCommand } from './cli/benchmark';
import { createAgentsCommand } from './cli/agents';
import { createAddCommand } from './cli/add';
import { createDoctorCommand } from './cli/doctor';
import { logger, LogLevel } from './utils/logger';
import { basename, resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';
import { PluginManager } from './plugin';
import { version as packageVersion } from '../package.json';
import { existsSync as existsSyncFs } from 'fs';

// Detect if running from a linked/local development build
function getVersionString(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageRoot = join(__dirname, '..');
  const isLocalDev = existsSyncFs(join(packageRoot, '.git'));
  return isLocalDev ? `${packageVersion} (local)` : packageVersion;
}

const version = getVersionString();
import { AuthenticationError } from './models';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolveLocalAgentPath, resolveProjectContext } from './utils/project';
import { loadGlobalEnv } from './utils/global-config';
import { resolveTimeout } from './utils/config';
import { printLogo, type BrandingStyle } from './utils/branding';
import { validateAgentEnvVars, formatEnvValidationError } from './utils/env-validation';
import { telemetry, categorizeError, aggregateToolCalls, countSteps, parseModel } from './telemetry';
import type { SessionInfo, SessionManager as SessionManagerType, SessionTrigger } from './session';
import { findServerForProject } from './utils/server-registry';

const program = new Command();

function hasServeForApprovalRun(projectRoot: string, agentFilePath?: string): boolean {
  return Boolean(
    findServerForProject(projectRoot) ??
    (agentFilePath ? findServerForProject(dirname(resolve(agentFilePath))) : undefined)
  );
}

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

// Add provider command (manages auth + custom providers)
program.addCommand(createProviderCommand());

// Add 'auth' as hidden alias for backward compatibility (creates a second instance)
program.addCommand(createAuthCommand(), { hidden: true });

// Add sessions command
program.addCommand(createSessionsCommand());

// Add serve command (includes ps subcommand)
program.addCommand(createServeCommand());

// Add models command
program.addCommand(createModelsCommand());

// Add skills command
program.addCommand(createSkillsCommand());

// Add agents command
program.addCommand(createAgentsCommand());

// Add add command
program.addCommand(createAddCommand());

// Add doctor command
program.addCommand(createDoctorCommand());

// Add benchmark command (hidden from help)
program.addCommand(createBenchmarkCommand(), { hidden: true });

program
  .command('run <file> [prompt...]')
  .description('Run an AI agent from a markdown file or URL, optionally appending a prompt')
  .option('-q, --quiet', 'Suppress info messages (only show warnings and errors)')
  .option('-d, --debug', 'Enable debug mode with detailed logging and full error messages')
  .option('--no-tty', 'Disable TUI output (spinners, badges) for non-interactive use')
  .option('--compact', 'Use compact single-line header instead of ASCII logo')
  .option('--timeout <seconds>', 'Maximum execution time in seconds (default: 300)', '300')
  .option('-C, --directory <path>', 'Run as if agentuse was started in <path> instead of the current directory')
  .option('--env-file <path>', 'Path to custom .env file')
  .option('-m, --model <model>', 'Override the model specified in the agent file')
  .option('--session-id <id>', 'Resume from an existing session id')
  .option('--json', 'Output result as JSON (implies --quiet --no-tty)')
  .action(async (file: string, promptArgs: string[], options: { quiet: boolean, debug: boolean, tty?: boolean, noTty?: boolean, compact: boolean, timeout: string, directory?: string, envFile?: string, model?: string, sessionId?: string, json?: boolean }) => {
    const startTime = Date.now();
    let originalCwd: string | undefined;

    // Track session info for interrupt handling (needs to be accessible in catch block)
    let interruptSessionInfo: { sessionID: string; agentId: string } | null = null;
    let sessionErrorLogged = false;
    let sessionManager: SessionManagerType | undefined;

    // Helper function for session error logging (needs sessionManager to be set)
    const logSessionInterrupt = async (errorCode: string = 'USER_INTERRUPT', errorMessage: string = 'Agent execution interrupted by user (Ctrl+C)') => {
      if (sessionErrorLogged) return;
      if (sessionManager && interruptSessionInfo) {
        try {
          await sessionManager.setSessionError(
            interruptSessionInfo.sessionID,
            interruptSessionInfo.agentId,
            { code: errorCode, message: errorMessage }
          );
          sessionErrorLogged = true;
        } catch { /* ignore failures */ }
      }
    };

    try {
      // Configure logger based on flags
      // --json implies --quiet and --no-tty
      const jsonMode = options.json === true;
      const effectiveQuiet = options.quiet || jsonMode;

      if (effectiveQuiet && options.debug) {
        throw new Error('Cannot use --quiet/--json and --debug together');
      }

      process.env.AGENTUSE_DEBUG = options.debug ? 'true' : 'false';

      const loggerConfig: { level?: LogLevel; enableDebug?: boolean; disableTUI?: boolean } = {};
      let quietMode = false;

      // Commander maps --no-tty to options.tty === false (noTty isn't guaranteed), so check both
      const disableTUI = options.tty === false || options.noTty === true || (options as any)['no-tty'] === true || jsonMode;

      if (effectiveQuiet) {
        loggerConfig.level = LogLevel.WARN;
        quietMode = true;
      } else if (options.debug) {
        loggerConfig.level = LogLevel.DEBUG;
        loggerConfig.enableDebug = true;
      }
      if (disableTUI) {
        process.env.NO_TTY = 'true';
        loggerConfig.disableTUI = true;
        // Switch to plain mode immediately so no spinner can start before configure()
        logger.forcePlainOutput();
      }
      logger.configure({ ...loggerConfig, ...(quietMode ? { quiet: true } : {}) });

      // Initialize telemetry
      await telemetry.init(packageVersion);

      // Show ASCII logo (unless in quiet/json mode)
      if (!effectiveQuiet) {
        const brandingStyle: BrandingStyle = options.compact ? 'compact' : 'full';
        printLogo(brandingStyle);

        // Show first-run telemetry notice
        if (await telemetry.isFirstRun()) {
          logger.info('agentuse collects anonymous usage data to improve the product.');
          logger.info('Set AGENTUSE_TELEMETRY_DISABLED=true to opt out.\n');
          await telemetry.markFirstRunComplete();
        }
      }

      // Log startup time if debug
      if (options.debug) {
        logger.info(`Starting AgentUse at ${new Date().toISOString()}`);
      }
      
      const loadedGlobalEnvFile = loadGlobalEnv();
      if (loadedGlobalEnvFile) {
        logger.debug(`Loading global environment from: ${loadedGlobalEnvFile}`);
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

      // Detect project root from the working directory. `-C` is the starting
      // scope, not necessarily the state boundary; .agentuse/.git/package.json
      // in a parent directory can own env and plugins.
      //
      // For state (sessions, agentId), we use a separate `stateRoot` derived
      // from the agent file's own project when the agent is a local file.
      // That way sessions follow the agent file across cwds. URL/stdin agents
      // (no resolvable file path) fall back to projectRoot.
      const localAgentFilePath = resolveLocalAgentPath(file);
      const projectContext = resolveProjectContext(process.cwd(), {
        ...(options.envFile && { envFile: options.envFile }),
        ...(localAgentFilePath && { agentFilePath: localAgentFilePath }),
      });
      logger.debug(`Using project root: ${projectContext.projectRoot}`);
      if (projectContext.stateRoot !== projectContext.projectRoot) {
        logger.debug(`Using state root: ${projectContext.stateRoot}`);
      }

      // Initialize storage and session manager
      try {
        const { initStorage } = await import('./storage/index.js');
        const { SessionManager } = await import('./session/index.js');

        await initStorage(projectContext.stateRoot);
        sessionManager = new SessionManager();

        logger.debug('Session storage initialized');
      } catch (storageError) {
        logger.warn(`Failed to initialize session storage: ${(storageError as Error).message}`);
      }

      // Load environment variables from resolved env file
      if (existsSync(projectContext.envFile)) {
        logger.debug(`Loading environment from: ${projectContext.envFile}`);
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
      let agentFilePath: string | undefined;

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

        // Trusted domains that skip the security prompt
        const trustedDomains = ['agentuse.io', 'www.agentuse.io'];
        const urlHost = new URL(file).hostname;
        const isTrustedDomain = trustedDomains.includes(urlHost);

        let content: string;

        if (isTrustedDomain) {
          // Trusted domain - fetch directly without prompt
          logger.info('Fetching agent from trusted source...');
          content = await fetchRemoteAgent(file);
        } else {
          // Show warning and prompt for untrusted domains
          console.log('\n⚠️  WARNING: You are about to execute an agent from:');
          console.log(file);
          console.log('\nOnly continue if you trust the source and have audited the agent.');

          const answer = await prompt('[p]review / [y]es / [N]o: ');

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
        }
        
        // Parse agent from content
        const agentName = basename(file).replace(/\.agentuse$/, '');
        agent = parseAgentContent(content!, agentName);
      } else {
        // Parse agent specification from local markdown file
        // Auto-append .agentuse extension if not specified
        let agentFile = file;
        if (!file.endsWith('.agentuse') && !existsSync(file)) {
          const withExt = `${file}.agentuse`;
          if (existsSync(withExt)) {
            agentFile = withExt;
          }
        }
        agentFilePath = resolve(agentFile);
        agent = await parseAgent(agentFile);
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
        const builtinProviders = ['anthropic', 'openai', 'openrouter', 'demo', 'bedrock'];
        if (!builtinProviders.includes(provider)) {
          // Check if it's a custom provider
          const customProvider = await AuthStorage.getCustomProvider(provider);
          if (!customProvider) {
            throw new Error(`Unknown provider '${provider}'. Built-in: ${builtinProviders.join(', ')}. Add custom providers with: agentuse provider add <name> --url <url>`);
          }
        }

        const originalModel = agent.config.model;
        agent.config.model = options.model;
        logger.info(`Model override: ${originalModel} → ${options.model}`);

        // Warn if provider-specific options don't match the new provider
        if (agent.config.openai && provider !== 'openai') {
          logger.warn(`Warning: OpenAI-specific options in config will be ignored with ${provider} model`);
        }
      }

      // Pre-flight environment variable validation
      const envValidation = validateAgentEnvVars(agent.config);
      if (!envValidation.valid) {
        logger.error(formatEnvValidationError(envValidation));
        process.exit(1);
      }
      if (envValidation.missingOptional.length > 0) {
        logger.warn(formatEnvValidationError(envValidation));
      }

      if (isApprovalEnabled(agent.config) && !hasServeForApprovalRun(projectContext.projectRoot, agentFilePath)) {
        const serveRoot = agentFilePath ? dirname(agentFilePath) : projectContext.projectRoot;
        throw new Error(
          [
            'Approval gates require agentuse serve to be running for this project.',
            'Start it in another terminal, then rerun this agent:',
            `  agentuse serve -C ${serveRoot}`
          ].join('\n')
        );
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

          // Log session interrupt immediately (fire and forget)
          logSessionInterrupt();

          // Give cleanup 2 seconds, then force exit if still hanging
          setTimeout(async () => {
            await logSessionInterrupt();
            console.log('\n⚠️  Force exiting...');
            process.exit(130);
          }, 2000);
        } else {
          // Second Ctrl-C - quick attempt to log, then immediate exit
          logSessionInterrupt().catch(() => {}).finally(() => {
            setTimeout(() => {
              console.log('\n⚠️  Force exiting...');
              process.exit(130);
            }, 100);
          });
        }
      };
      process.on('SIGINT', sigintHandler);

      // Handle SIGTERM (sent by kill command, container shutdown, etc.)
      const sigtermHandler = () => {
        console.log('\n⚠️  Received SIGTERM, shutting down...');
        wasInterrupted = true;
        abortController.abort();
        logSessionInterrupt();
        setTimeout(async () => {
          await logSessionInterrupt();
          process.exit(143);  // 128 + 15 (SIGTERM)
        }, 2000);
      };
      process.on('SIGTERM', sigtermHandler);

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

      /**
       * Prepare execution context BEFORE running the agent.
       *
       * This serves two purposes:
       * 1. Display metadata (tool count, session ID) to the user before execution starts
       * 2. Avoid duplicate preparation work by passing the prepared context to runAgent
       *
       * The preparation includes expensive operations:
       * - MCP tool discovery and validation
       * - Plugin loading and initialization
       * - Session management setup
       *
       * By preparing once and reusing, we avoid doing this work twice.
       */
      const preparedExecution: PreparedAgentExecution = await prepareAgentExecution({
        agent,
        mcpClients: mcp,
        agentFilePath,
        cliMaxSteps,
        sessionManager,
        projectContext: { projectRoot: projectContext.projectRoot, stateRoot: projectContext.stateRoot, cwd: process.cwd() },
        userPrompt: additionalPrompt || undefined,
        abortSignal: abortController.signal,
        verbose: options.debug,
        existingSessionId: options.sessionId
      });

      // Update session info for interrupt handling (now that we have sessionID)
      if (preparedExecution.sessionID && preparedExecution.agentId) {
        interruptSessionInfo = { sessionID: preparedExecution.sessionID, agentId: preparedExecution.agentId };
      }

      // Display agent metadata in clean format
      if (!effectiveQuiet) {
        logger.separator();
        const metadataLines = [
          `Agent: ${agent.name}`,
          `Model: ${agent.config.model}`,
        ];
        if (agent.description) {
          metadataLines.push(`Description: ${agent.description}`);
        }
        // Count available tools from prepared execution (this is why we prepare early)
        const toolCount = Object.keys(preparedExecution.tools).length;
        metadataLines.push(`Tools: ${toolCount} available`);
        // Show learnings count if any were applied
        if (preparedExecution.learningsApplied > 0) {
          metadataLines.push(`Learnings: ${preparedExecution.learningsApplied} applied`);
        }
        logger.metadata(metadataLines);
        logger.separator();
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
          { projectRoot: projectContext.projectRoot, stateRoot: projectContext.stateRoot, cwd: process.cwd() },
          additionalPrompt || undefined,
          preparedExecution,
          false,
          pluginManager,
          true,
          options.sessionId
        );

        if (result.status === 'suspended') {
          const target = result.approvalUrl ?? preparedExecution.sessionID;
          logger.info(`Agent is waiting for approval${target ? ` ${target}` : ''}`);
        } else if (!result.hasTextOutput) {
          logger.warn('Agent completed without producing a final response.');
        } else if (result.finishReason && result.finishReason !== 'stop') {
          if (result.finishReason === 'unknown') {
            logger.warn('Agent finished without reporting a reason; output may be incomplete.');
          } else {
            logger.warn(`Agent stopped with finish reason: ${result.finishReason}. Output may be incomplete.`);
          }
        }
      } catch (error: unknown) {
        if (abortController.signal.aborted || (error as Error).name === 'AbortError') {
          // Clean up sandbox/store before exiting (process.exit skips finally blocks)
          await preparedExecution.cleanup();

          if (wasInterrupted) {
            // User pressed Ctrl-C - clean exit with standard interrupt code
            // Log session error before exiting
            await logSessionInterrupt();

            if (!jsonMode) {
              logger.info('Agent execution interrupted by user.');
            }
            // Capture telemetry for user abort
            telemetry.captureExecution({
              ...parseModel(agent.config.model),
              durationMs: Date.now() - startTime,
              inputTokens: 0,
              outputTokens: 0,
              success: false,
              errorType: 'user_abort',
            });
            await telemetry.shutdown();
            if (jsonMode) {
              console.log(JSON.stringify({
                success: false,
                error: { code: 'USER_INTERRUPT', message: 'Agent execution interrupted by user' },
              }));
            }
            process.exit(130);
          } else {
            // Actual timeout - log session error before exiting
            await logSessionInterrupt('TIMEOUT', `Agent execution timed out after ${effectiveTimeoutSeconds}s`);

            if (!jsonMode) {
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
            }
            // Capture telemetry for timeout
            telemetry.captureExecution({
              ...parseModel(agent.config.model),
              durationMs: Date.now() - startTime,
              inputTokens: 0,
              outputTokens: 0,
              success: false,
              errorType: 'timeout',
            });
            await telemetry.shutdown();
            if (jsonMode) {
              console.log(JSON.stringify({
                success: false,
                error: { code: 'TIMEOUT', message: `Agent execution timed out after ${effectiveTimeoutSeconds}s` },
              }));
            }
            process.exit(1);
          }
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        process.off('SIGINT', sigintHandler);
        process.off('SIGTERM', sigtermHandler);
      }

      // Capture telemetry for successful execution
      telemetry.captureExecution({
        ...parseModel(agent.config.model),
        durationMs: Date.now() - startTime,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        success: true,
        toolCalls: aggregateToolCalls(result.toolCallTraces),
        steps: countSteps(result.toolCallTraces),

        // Performance & Reliability
        finishReason: result.finishReason,
        hasTextOutput: result.hasTextOutput,

        // Feature Adoption
        features: {
          mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
          subagentsConfigured: agent.config.subagents?.length ?? 0,
          skillsUsed: false, // TODO: track skill usage
          mode: 'cli' as const,
        },

        // Configuration Patterns
        config: {
          timeoutCustom: timeoutWasExplicit || (agent.config.timeout !== undefined),
          maxStepsCustom: cliMaxSteps !== undefined || (agent.config.maxSteps !== undefined),
          quietMode: options.quiet,
          debugMode: options.debug,
        },
      });

      // Restore original working directory if changed
      if (options.directory && originalCwd && originalCwd !== process.cwd()) {
        process.chdir(originalCwd);
        logger.debug(`Restored working directory to ${originalCwd}`);
      }

      // Shutdown telemetry before exit
      await telemetry.shutdown();

      // Output JSON result if --json mode
      if (jsonMode) {
        const duration = Date.now() - startTime;
        const jsonOutput = {
          success: true,
          result: {
            text: result.text || '',
            ...(result.finishReason && { finishReason: result.finishReason }),
            duration,
            ...(result.usage && { tokens: { input: result.usage.inputTokens || 0, output: result.usage.outputTokens || 0 } }),
            toolCalls: result.toolCallCount || 0,
          },
        };
        console.log(JSON.stringify(jsonOutput));
      }

      // Exit successfully after agent completes
      process.exit(0);
    } catch (error) {
      // Restore original working directory if changed
      if (options.directory && originalCwd && originalCwd !== process.cwd()) {
        process.chdir(originalCwd);
      }

      // Helper to output JSON error and exit
      const outputJsonError = (code: string, message: string) => {
        if (options.json) {
          console.log(JSON.stringify({
            success: false,
            error: { code, message },
          }));
        }
      };

      // Capture telemetry for startup errors (auth, config) or execution errors
      if (error instanceof AuthenticationError) {
        // Log to session if it exists (auth errors can happen during runAgent)
        await logSessionInterrupt('AUTH_ERROR', error.message);

        telemetry.captureStartupError({
          type: 'auth',
          provider: error.provider,
        });
        await telemetry.shutdown();

        if (options.json) {
          outputJsonError('AUTH_ERROR', error.message);
        } else {
          console.error(`\n[ERROR] ${error.message}`);
          console.error('');
          console.error('To authenticate, run:');
          console.error('  agentuse provider login');
          console.error('');
          console.error('Or set your API key:');
          console.error(`  export ${error.envVar}='your-key-here'`);
          console.error('');
          console.error('For more options: agentuse provider --help');
        }
        process.exit(1);
      }

      if (error instanceof ConfigError) {
        telemetry.captureStartupError({
          type: 'config',
          field: error.field,
          issue: error.issue,
        });
        await telemetry.shutdown();

        if (options.json) {
          outputJsonError('CONFIG_ERROR', error.message);
        } else {
          logger.error('Error', error);
        }
        process.exit(1);
      }

      // For other errors, use the execution event
      const errorType = categorizeError(error);

      // Log to session if it exists
      await logSessionInterrupt(errorType ?? 'EXECUTION_ERROR', (error as Error).message);

      telemetry.captureExecution({
        provider: 'unknown',
        modelName: 'unknown',
        durationMs: Date.now() - startTime,
        inputTokens: 0,
        outputTokens: 0,
        success: false,
        ...(errorType && { errorType }),
      });
      await telemetry.shutdown();

      if (options.json) {
        outputJsonError(errorType ?? 'EXECUTION_ERROR', (error as Error).message);
      } else {
        logger.error('Error', error as Error);
      }
      process.exit(1);
    }
  });


// Handle internal worker mode (used by serve command)
// This must be checked before program.parse() to avoid Commander processing
if (process.argv[2] === '--internal-worker') {
  runInternalWorker();
} else {
  // Parse command line arguments
  program.parse(process.argv);

  // Show help if no command provided
  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
}

/**
 * Internal worker mode for serve command.
 * Listens for JSON requests on stdin, executes agents, returns JSON on stdout.
 * This works around EBADF issues when spawning from async callbacks.
 */
async function runInternalWorker() {
  const { createInterface } = await import('readline');
  const { SessionManager } = await import('./session/index.js');
  const { initStorage } = await import('./storage/index.js');

  // Configure logger to be quiet
  logger.configure({ level: LogLevel.ERROR, quiet: true, disableTUI: true });
  loadGlobalEnv();

  interface ExecuteRequest {
    id: string;
    type: 'execute' | 'resume' | 'continue-session' | 'approval-info' | 'sweep-expired' | 'list-approvals' | 'list-sessions';
    agentPath?: string;
    projectRoot: string;
    prompt?: string;
    model?: string;
    timeout?: number;
    maxSteps?: number;
    debug?: boolean;
    sessionId?: string;
    toolResult?: unknown;
    resumeToken?: string;
    allowHistorical?: boolean;
    approvalCreatedAfter?: number;
    sessionsCreatedAfter?: number;
    // Trusted, server-set only: when the serve process has already authorized
    // the viewer (session token / api key / local), it asks for full approval
    // info regardless of the gate resumeToken. Never derived from client input.
    skipTokenCheck?: boolean;
    trigger?: SessionTrigger;
    runChannelHandles?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
  }

  interface ExpiredApproval {
    sessionId: string;
    agentId: string;
    agentName: string;
    prompt?: string;
    expiresAt: number;
    suspendedAt?: number;
    channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
  }

  type ApprovalSummaryStatus = 'pending' | 'approved' | 'rejected' | 'commented' | 'expired' | 'errored';

  interface ApprovalLogDetails {
    resumeToken?: string;
    prompt?: string;
    input?: string;
    output?: string;
    summary?: string;
    context?: string;
    risk?: string;
    draft?: string;
    draftUrl?: string;
    artifactUrl?: string;
    decisionStatus?: string;
    decisionComment?: string;
    decisionReviewer?: string;
    errorMessage?: string;
  }

  interface ApprovalSummary {
    sessionId: string;
    agentId: string;
    agentName: string;
    agentDescription?: string;
    agentFilePath?: string;
    status: ApprovalSummaryStatus;
    sessionStatus: string;
    prompt?: string;
    summary?: string;
    risk?: string;
    suspendedAt?: number;
    expiresAt?: number;
    createdAt?: number;
    decisionAt?: number;
    decisionStatus?: string;
    decisionComment?: string;
    decisionReviewer?: string;
    resumeToken?: string;
    errorCode?: string;
    errorMessage?: string;
    channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
    channels?: {
      slack?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
    };
  }

  function valueAsRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  function formatApprovalLogValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
  }

  function sessionErrorFields(session: { status?: string; error?: { code?: string; message?: string } }) {
    if (session.status !== 'error' || !session.error) return {};
    return {
      ...(typeof session.error.code === 'string' && session.error.code ? { errorCode: session.error.code } : {}),
      ...(typeof session.error.message === 'string' && session.error.message ? { errorMessage: session.error.message } : {})
    };
  }

  function isRejectDecision(toolResult: unknown): boolean {
    const result = valueAsRecord(toolResult);
    const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
    return status === 'reject' || status === 'rejected';
  }

  function approvalRejectionText(toolResult: unknown): string {
    const result = valueAsRecord(toolResult);
    const reviewer = valueAsRecord(result.reviewer);
    const reviewerName = typeof reviewer.username === 'string'
      ? reviewer.username
      : typeof reviewer.name === 'string'
        ? reviewer.name
        : typeof reviewer.id === 'string'
          ? reviewer.id
          : undefined;
    const comment = typeof result.comment === 'string' && result.comment.trim()
      ? result.comment.trim()
      : undefined;

    return [
      `❌ **Rejected**${reviewerName ? ` by ${reviewerName}` : ''}`,
      comment ? `\n${comment}` : undefined
    ].filter(Boolean).join('\n');
  }

  async function lastAssistantText(sessionManager: InstanceType<typeof SessionManager>, sessionId: string, agentId: string): Promise<string | undefined> {
    const messages = await sessionManager.getSessionMessages(sessionId, agentId);
    for (const message of [...messages].reverse()) {
      const parts = await sessionManager.getMessageParts(sessionId, agentId, message.id);
      const text = [...parts].reverse().find((part: any) =>
        part?.type === 'text' &&
        part?.role !== 'user' &&
        typeof part.text === 'string' &&
        part.text.trim().length > 0
      ) as any;
      if (text) return text.text.trim();
    }
    return undefined;
  }

  async function buildContinuationPrompt(
    sessionManager: InstanceType<typeof SessionManager>,
    sessionId: string,
    agentId: string,
    session: { id: string; status: string },
    prompt?: string
  ): Promise<string> {
    const previous = await lastAssistantText(sessionManager, sessionId, agentId);
    return [
      `Continue from previous AgentUse session ${session.id}.`,
      `Previous session status: ${session.status}.`,
      previous ? `Previous final assistant output:\n${previous}` : undefined,
      prompt?.trim()
        ? `New instruction:\n${prompt.trim()}`
        : 'New instruction:\nContinue from where the previous session left off.'
    ].filter(Boolean).join('\n\n');
  }

  function buildApprovalLogs(parts: any[]): Array<{ id: string; type: string; tool?: string; status?: string; title: string; message?: string; time?: number; details?: ApprovalLogDetails }> {
    return parts.map((part: any) => {
      if (part?.type === 'text') {
        const message = formatApprovalLogValue(part.text);
        const isUser = part.role === 'user';
        return {
          id: String(part.id),
          type: 'text',
          ...(typeof part.time?.end === 'number' ? { status: 'completed' } : { status: 'streaming' }),
          title: isUser ? 'User response' : 'Assistant response',
          ...(message !== undefined && { message }),
          ...(typeof part.time?.start === 'number' && { time: part.time.start })
        };
      }
      if (part?.type === 'reasoning') {
        const message = formatApprovalLogValue(part.text);
        return {
          id: String(part.id),
          type: 'reasoning',
          title: 'Reasoning',
          ...(message !== undefined && { message }),
          ...(typeof part.time?.start === 'number' && { time: part.time.start })
        };
      }
      if (part?.type === 'tool') {
        const state = part.state ?? {};
        const isAwaitHuman = part.tool === 'await_human';
        const details = isAwaitHuman ? buildAwaitHumanDetails(state) : buildToolDetails(state);
        const message = details
          ? undefined
          : state.status === 'completed'
            ? formatApprovalLogValue(state.output)
            : state.status === 'error'
              ? formatApprovalLogValue(state.error)
              : state.status === 'pending'
                ? formatApprovalLogValue(state.input)
                : undefined;
        const title = isAwaitHuman
          ? approvalLogTitle(state)
          : `${part.tool ?? 'tool'} ${state.status ?? ''}`.trim();
        return {
          id: String(part.id),
          type: 'tool',
          ...(part.tool && { tool: String(part.tool) }),
          ...(typeof state.status === 'string' && { status: state.status }),
          title,
          ...(message !== undefined && { message }),
          ...(details && { details }),
          ...(typeof state.time?.start === 'number'
            ? { time: state.time.start }
            : typeof state.suspendedAt === 'number'
              ? { time: state.suspendedAt }
              : {})
        };
      }
      return {
        id: String(part?.id ?? 'unknown'),
        type: String(part?.type ?? 'part'),
        title: String(part?.type ?? 'Session event')
      };
    });
  }

  function approvalLogTitle(state: any): string {
    if (state?.status === 'pending') return 'Pending for approval';
    if (state?.status === 'completed') {
      const output = valueAsRecord(state.output);
      const decision = typeof output.status === 'string' ? output.status.toLowerCase() : '';
      if (decision === 'approve' || decision === 'approved') return 'Approved';
      if (decision === 'reject' || decision === 'rejected') return 'Rejected';
      if (decision === 'comment' || decision === 'commented') return 'Comment sent';
      return 'Approval resolved';
    }
    if (state?.status === 'error') return 'Approval failed';
    return 'Approval';
  }

  function buildAwaitHumanDetails(state: any): ApprovalLogDetails | undefined {
    const input = valueAsRecord(state?.input);
    const output = valueAsRecord(state?.output);
    const metadata = valueAsRecord(state?.metadata);
    const resumePayload = state?.status === 'pending'
      ? valueAsRecord(state?.resumePayload)
      : valueAsRecord(metadata.resumePayload);
    const fields: ApprovalLogDetails = {};
    if (typeof resumePayload.resumeToken === 'string' && resumePayload.resumeToken) {
      fields.resumeToken = resumePayload.resumeToken;
    }
    if (typeof input.prompt === 'string' && input.prompt) fields.prompt = input.prompt;
    if (typeof input.summary === 'string' && input.summary) fields.summary = input.summary;
    if (typeof input.context === 'string' && input.context) fields.context = input.context;
    if (typeof input.risk === 'string' && input.risk) fields.risk = input.risk;
    if (typeof input.draft === 'string' && input.draft) fields.draft = input.draft;
    if (typeof input.draft_url === 'string' && input.draft_url) fields.draftUrl = input.draft_url;
    if (typeof input.artifact_url === 'string' && input.artifact_url) fields.artifactUrl = input.artifact_url;

    if (state?.status === 'completed') {
      const decisionStatus = typeof output.status === 'string' ? output.status : undefined;
      const decisionComment = typeof output.comment === 'string' ? output.comment : undefined;
      const reviewer = valueAsRecord(output.reviewer);
      const reviewerLabel = typeof reviewer.name === 'string'
        ? reviewer.name
        : typeof reviewer.id === 'string'
          ? reviewer.id
          : undefined;
      if (decisionStatus) fields.decisionStatus = decisionStatus;
      if (decisionComment) fields.decisionComment = decisionComment;
      if (reviewerLabel) fields.decisionReviewer = reviewerLabel;
    } else if (state?.status === 'error') {
      const errText = typeof state.error === 'string' ? state.error : undefined;
      if (errText) fields.errorMessage = errText;
    }

    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  function buildToolDetails(state: any): ApprovalLogDetails | undefined {
    const fields: ApprovalLogDetails = {};
    const input = formatApprovalLogValue(state?.input);
    if (input !== undefined) fields.input = input;

    if (state?.status === 'completed') {
      const output = formatApprovalLogValue(state.output);
      if (output !== undefined) fields.output = output;
    } else if (state?.status === 'error') {
      const error = formatApprovalLogValue(state.error);
      if (error !== undefined) fields.errorMessage = error;
    }

    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  async function getApprovalInfo(req: ExecuteRequest) {
    try {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for approval request' },
        };
      }

      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const found = await sessionManager.findSession(req.sessionId);
      if (!found) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
        };
      }

      const messages = await sessionManager.getSessionMessages(req.sessionId, found.agentId);
      const parts = (await Promise.all(
        messages.map((message) => sessionManager.getMessageParts(req.sessionId!, found.agentId, message.id))
      )).flat();
      const logs = buildApprovalLogs(parts);
      const approvalParts = parts.filter((part: any) =>
        part?.type === 'tool' &&
        part?.tool === 'await_human' &&
        (
          part?.state?.resumePayload?.kind === 'await_human' ||
          part?.state?.status === 'completed' ||
          part?.state?.status === 'running' ||
          part?.state?.metadata?.resumePayload?.kind === 'await_human'
        )
      ) as any;
      const pendingApprovalPart = [...approvalParts].reverse().find((part: any) =>
        part?.state?.status === 'pending'
      );
      const latestApprovalPart = [...approvalParts].reverse()[0];
      const approvalPart = pendingApprovalPart ?? latestApprovalPart;

      if (!approvalPart) {
        return {
          id: req.id,
          success: true,
          approval: {
            sessionId: req.sessionId,
            sessionStatus: found.session.status,
            ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
            ...sessionErrorFields(found.session),
            agent: {
              id: found.session.agent.id,
              name: found.session.agent.name,
              ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
              ...(found.session.agent.description && { description: found.session.agent.description })
            },
            logs
          },
        };
      }

      const state = approvalPart.state;
      const input = valueAsRecord(state.input);
      const metadata = valueAsRecord(state.metadata);
      const resumePayload = state.status === 'pending'
        ? valueAsRecord(state.resumePayload)
        : valueAsRecord(metadata.resumePayload);
      const expectedToken = typeof resumePayload.resumeToken === 'string' ? resumePayload.resumeToken : undefined;
      // For read-only views (e.g. /status polling, page render via an old Slack
      // link), accept any resumeToken that was issued for any await_human gate
      // in this session. /decision and resume.ts keep strict latest-token
      // checks, so authorization to act is not weakened.
      const tokenMatchesHistory = (() => {
        if (!req.allowHistorical || !req.resumeToken) return false;
        for (const part of approvalParts) {
          const partState = (part as any).state ?? {};
          const partMeta = valueAsRecord(partState.metadata);
          const partPayload = partState.status === 'pending'
            ? valueAsRecord(partState.resumePayload)
            : valueAsRecord(partMeta.resumePayload);
          if (typeof partPayload.resumeToken === 'string' && partPayload.resumeToken === req.resumeToken) {
            return true;
          }
        }
        return false;
      })();
      // skipTokenCheck is set only by the serve process after it has already
      // authorized the viewer; it lets the unified /sessions/:id page resolve
      // the current gate's resumeToken without the caller knowing it.
      if (expectedToken && expectedToken !== req.resumeToken && !tokenMatchesHistory && !req.skipTokenCheck) {
        return {
          id: req.id,
          success: false,
          error: { code: 'RESUME_TOKEN_INVALID', message: 'Invalid approval token' },
        };
      }
      if (!expectedToken) {
        return {
          id: req.id,
          success: true,
          approval: {
            sessionId: req.sessionId,
            sessionStatus: found.session.status,
            ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
            ...sessionErrorFields(found.session),
            agent: {
              id: found.session.agent.id,
              name: found.session.agent.name,
              ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
              ...(found.session.agent.description && { description: found.session.agent.description })
            },
            logs
          },
        };
      }

      const channelMessage = valueAsRecord(resumePayload.channelMessage);
      const approvalUrl = typeof resumePayload.approvalUrl === 'string'
        ? resumePayload.approvalUrl
        : typeof channelMessage.url === 'string'
          ? channelMessage.url
          : undefined;
      return {
        id: req.id,
        success: true,
        approval: {
          sessionId: req.sessionId,
          sessionStatus: found.session.status,
          ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
          ...sessionErrorFields(found.session),
          agent: {
            id: found.session.agent.id,
            name: found.session.agent.name,
            ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
            ...(found.session.agent.description && { description: found.session.agent.description })
          },
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
          ...(typeof input.summary === 'string' && { summary: input.summary }),
          ...(typeof input.draft === 'string' && { draft: input.draft }),
          ...(typeof input.draft_url === 'string' && { draftUrl: input.draft_url }),
          ...(typeof input.artifact_url === 'string' && { artifactUrl: input.artifact_url }),
          ...(typeof input.context === 'string' && { context: input.context }),
          ...(typeof input.risk === 'string' && { risk: input.risk }),
          ...(typeof resumePayload.surface === 'string' && { surface: resumePayload.surface }),
          ...(approvalUrl && { approvalUrl }),
          ...(state.status === 'pending' && expectedToken && { currentResumeToken: expectedToken }),
          ...(typeof resumePayload.expiresAt === 'number' && { expiresAt: resumePayload.expiresAt }),
          ...(typeof state.suspendedAt === 'number' && { suspendedAt: state.suspendedAt }),
          ...(Object.keys(channelMessage).length > 0 && { channelMessage }),
          ...(state.status === 'completed' && { decision: state.output }),
          logs
        },
      };
    } catch (err) {
      return {
        id: req.id,
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
      };
    }
  }

  async function sweepExpiredApprovals(req: ExecuteRequest) {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const suspended = await sessionManager.getSuspendedSessions();
      const now = Date.now();
      const expired: ExpiredApproval[] = [];

      for (const { session, agentId } of suspended) {
        const pending = await sessionManager.findPendingTool(session.id, agentId);
        if (!pending) continue;
        const state = pending.part.state;
        if (state.status !== 'pending') continue;
        const resumePayload = state.resumePayload;
        const expiresAt = typeof resumePayload?.expiresAt === 'number' ? resumePayload.expiresAt : undefined;
        if (!expiresAt || expiresAt > now) continue;

        const start = state.suspendedAt ?? expiresAt;
        await sessionManager.updatePart(
          session.id,
          agentId,
          pending.message.id,
          pending.part.id,
          {
            state: {
              status: 'error',
              input: state.input,
              error: 'Approval timed out',
              ...(resumePayload && { metadata: { resumePayload } }),
              time: { start, end: now }
            }
          } as any
        ).catch(() => {});

        await sessionManager.setSessionError(session.id, agentId, {
          code: 'APPROVAL_TIMEOUT',
          message: `Approval not received before ${new Date(expiresAt).toISOString()}`
        }).catch(() => {});

        const input = valueAsRecord(state.input);
        const channelMessage = valueAsRecord(resumePayload?.channelMessage);
        expired.push({
          sessionId: session.id,
          agentId,
          agentName: session.agent.name || session.agent.id,
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
          expiresAt,
          ...(typeof state.suspendedAt === 'number' && { suspendedAt: state.suspendedAt }),
          ...(Object.keys(channelMessage).length > 0 && {
            channelMessage: {
              ...(typeof channelMessage.type === 'string' && { type: channelMessage.type }),
              ...(typeof channelMessage.channel === 'string' && { channel: channelMessage.channel }),
              ...(typeof channelMessage.ts === 'string' && { ts: channelMessage.ts }),
              ...(typeof channelMessage.actionTs === 'string' && { actionTs: channelMessage.actionTs }),
              ...(typeof channelMessage.url === 'string' && { url: channelMessage.url })
            }
          }),
          ...(session.channels && { channels: session.channels })
        });
      }

      return {
        id: req.id,
        success: true as const,
        expired
      };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'SWEEP_ERROR', message: (err as Error).message }
      };
    }
  }

  async function listAllApprovals(req: ExecuteRequest) {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const sessions = typeof req.approvalCreatedAfter === 'number'
        ? await sessionManager.listSessionsCreatedAfter(req.approvalCreatedAfter)
        : await sessionManager.listAllSessions();
      const approvals: ApprovalSummary[] = [];
      const sessionBatchSize = 16;

      const summarizeApproval = async (
        { session, agentId }: { session: SessionInfo; agentId: string }
      ): Promise<ApprovalSummary | null> => {
        const approvalPart = await sessionManager.getLatestApprovalPart(session.id, agentId) as any;
        if (!approvalPart) return null;

        const state = approvalPart.state ?? {};
        const input = valueAsRecord(state.input);
        const metadata = valueAsRecord(state.metadata);
        const resumePayload = state.status === 'pending'
          ? valueAsRecord(state.resumePayload)
          : valueAsRecord(metadata.resumePayload);
        const channelMessage = valueAsRecord(resumePayload.channelMessage);
        const output = valueAsRecord(state.output);
        const reviewer = valueAsRecord(output.reviewer);

        let status: ApprovalSummaryStatus;
        let errorMessage: string | undefined;
        if (state.status === 'pending') {
          status = 'pending';
        } else if (state.status === 'completed') {
          const decisionStatus = typeof output.status === 'string' ? output.status.toLowerCase() : '';
          status = decisionStatus === 'approve' || decisionStatus === 'approved'
            ? 'approved'
            : decisionStatus === 'reject' || decisionStatus === 'rejected'
              ? 'rejected'
              : decisionStatus === 'comment' || decisionStatus === 'commented'
                ? 'commented'
                : 'approved';
        } else if (state.status === 'error') {
          const errText = typeof state.error === 'string' ? state.error : '';
          status = /timed out|timeout|APPROVAL_TIMEOUT/i.test(errText) ||
            session.error?.code === 'APPROVAL_TIMEOUT'
            ? 'expired'
            : 'errored';
          errorMessage = errText || session.error?.message;
        } else {
          status = 'errored';
        }
        const sessionError = sessionErrorFields(session) as { errorCode?: string; errorMessage?: string };
        if (sessionError.errorMessage) errorMessage = sessionError.errorMessage;

        const decisionAt = state.status === 'completed' || state.status === 'error'
          ? (typeof state.time?.end === 'number' ? state.time.end : undefined)
          : undefined;

        return {
          sessionId: session.id,
          agentId,
          agentName: session.agent.name || session.agent.id,
          ...(session.agent.description && { agentDescription: session.agent.description }),
          ...(session.agent.filePath && { agentFilePath: session.agent.filePath }),
          status,
          sessionStatus: session.status,
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
          ...(typeof input.summary === 'string' && { summary: input.summary }),
          ...(typeof input.risk === 'string' && { risk: input.risk }),
          ...(typeof state.suspendedAt === 'number' && { suspendedAt: state.suspendedAt }),
          ...(typeof resumePayload.expiresAt === 'number' && { expiresAt: resumePayload.expiresAt }),
          ...(typeof session.time?.created === 'number' && { createdAt: session.time.created }),
          ...(decisionAt !== undefined && { decisionAt }),
          ...(typeof output.status === 'string' && { decisionStatus: output.status }),
          ...(typeof output.comment === 'string' && { decisionComment: output.comment }),
          ...(typeof reviewer.username === 'string' && { decisionReviewer: reviewer.username }),
          ...(typeof resumePayload.resumeToken === 'string' && { resumeToken: resumePayload.resumeToken }),
          ...(sessionError.errorCode && { errorCode: sessionError.errorCode }),
          ...(errorMessage && { errorMessage }),
          ...(Object.keys(channelMessage).length > 0 && {
            channelMessage: {
              ...(typeof channelMessage.type === 'string' && { type: channelMessage.type }),
              ...(typeof channelMessage.channel === 'string' && { channel: channelMessage.channel }),
              ...(typeof channelMessage.ts === 'string' && { ts: channelMessage.ts }),
              ...(typeof channelMessage.actionTs === 'string' && { actionTs: channelMessage.actionTs }),
              ...(typeof channelMessage.url === 'string' && { url: channelMessage.url })
            }
          }),
          ...(session.channels && { channels: session.channels })
        };
      };

      for (let i = 0; i < sessions.length; i += sessionBatchSize) {
        const batch = sessions.slice(i, i + sessionBatchSize);
        const summaries = await Promise.all(batch.map(summarizeApproval));
        approvals.push(...summaries.filter((approval): approval is ApprovalSummary => approval !== null));
      }

      return {
        id: req.id,
        success: true as const,
        approvals
      };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'LIST_APPROVALS_ERROR', message: (err as Error).message }
      };
    }
  }

  async function listSessions(req: ExecuteRequest) {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const sessions = typeof req.sessionsCreatedAfter === 'number'
        ? await sessionManager.listSessionsCreatedAfter(req.sessionsCreatedAfter)
        : await sessionManager.listAllSessions();

      // Top-level runs only; subagent sessions are an implementation detail of a
      // parent run and would clutter the operator surface.
      const summaries = sessions
        .filter(({ session }) => !session.parentSessionID && !session.agent.isSubAgent)
        .map(({ session }) => ({
          sessionId: session.id,
          agent: {
            id: session.agent.id,
            name: session.agent.name,
            ...(session.agent.description && { description: session.agent.description }),
            ...(session.agent.filePath && { filePath: session.agent.filePath }),
          },
          status: session.status,
          trigger: session.trigger ?? 'manual',
          createdAt: session.time.created,
          updatedAt: session.time.updated,
          ...sessionErrorFields(session),
        }))
        .sort((a, b) => b.createdAt - a.createdAt);

      return {
        id: req.id,
        success: true as const,
        sessions: summaries
      };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'LIST_SESSIONS_ERROR', message: (err as Error).message }
      };
    }
  }

  async function executeAgent(req: ExecuteRequest) {
    const startTime = Date.now();
    let mcp: Awaited<ReturnType<typeof connectMCP>> = [];
    let sessionManager: InstanceType<typeof SessionManager> | undefined;
    let resumeRollback: Awaited<ReturnType<typeof applyResumeToolResult>>['rollback'] | undefined;
    let continuationSession: { sessionId: string; agentId: string } | undefined;

    const restoreResumeAndReturn = async <T>(response: T): Promise<T> => {
      if (sessionManager && resumeRollback) {
        await restoreResumeToolResult({ sessionManager, rollback: resumeRollback }).catch((restoreErr) => {
          logger.warn(`Failed to restore pending approval after resume error: ${(restoreErr as Error).message}`);
        });
        resumeRollback = undefined;
      }
      return response;
    };

    try {
      let agentPath = req.agentPath ? resolve(req.projectRoot, req.agentPath) : '';
      if (req.type === 'execute' && (!req.agentPath || !existsSync(agentPath))) {
        return {
          id: req.id,
          success: false,
          error: { code: 'AGENT_NOT_FOUND', message: `Agent file not found: ${req.agentPath}` },
        };
      }

      // Load environment from project root
      const envFile = resolve(req.projectRoot, '.env');
      const envLocalFile = resolve(req.projectRoot, '.env.local');
      if (existsSync(envLocalFile)) {
        dotenv.config({ path: envLocalFile });
      } else if (existsSync(envFile)) {
        dotenv.config({ path: envFile });
      }

      try {
        await initStorage(req.projectRoot);
      } catch {
        // Ignore storage init errors
      }

      sessionManager = new SessionManager();
      let existingSessionId: string | undefined = req.sessionId;
      let runPrompt = req.prompt;
      let runCwd = req.projectRoot;
      if (req.type === 'resume') {
        if (!req.sessionId) {
          return {
            id: req.id,
            success: false,
            error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for resume request' },
          };
        }

        const resumed = await applyResumeToolResult({
          sessionManager,
          sessionId: req.sessionId,
          toolResult: req.toolResult,
          ...(req.resumeToken && { resumeToken: req.resumeToken })
        });
        resumeRollback = resumed.rollback;
        if (!resumed.agentFilePath) {
          return restoreResumeAndReturn({
            id: req.id,
            success: false,
            error: { code: 'AGENT_NOT_FOUND', message: `Session ${req.sessionId} does not record an agent file path` },
          });
        }
        if (isRejectDecision(req.toolResult)) {
          resumeRollback = undefined;
          const message = await sessionManager.getPrimaryMessage(req.sessionId, resumed.agentId);
          const text = approvalRejectionText(req.toolResult);
          if (message) {
            const now = Date.now();
            await sessionManager.addPart(req.sessionId, resumed.agentId, message.id, {
              type: 'text',
              synthetic: true,
              text,
              time: { start: now, end: now }
            } as any);
            await sessionManager.updateMessage(req.sessionId, resumed.agentId, message.id, {
              time: { completed: now }
            });
          }
          await sessionManager.setSessionCompleted(req.sessionId, resumed.agentId);
          return {
            id: req.id,
            success: true,
            result: {
              text,
              finishReason: 'rejected',
              duration: Date.now() - startTime,
              toolCalls: 0,
              sessionId: req.sessionId
            }
          };
        }
        agentPath = resumed.agentFilePath;
        existingSessionId = req.sessionId;
      } else if (req.type === 'continue-session') {
        if (!req.sessionId) {
          return {
            id: req.id,
            success: false,
            error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for continue request' },
          };
        }

        const found = await sessionManager.findSession(req.sessionId);
        if (!found) {
          return {
            id: req.id,
            success: false,
            error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
          };
        }
        if (found.session.status === 'running') {
          return {
            id: req.id,
            success: false,
            error: { code: 'SESSION_RUNNING', message: `Session ${req.sessionId} is already running` },
          };
        }
        if (found.session.status === 'suspended') {
          return {
            id: req.id,
            success: false,
            error: { code: 'SESSION_SUSPENDED', message: `Session ${req.sessionId} is suspended; submit an approval decision instead` },
          };
        }
        if (!found.session.agent.filePath) {
          return {
            id: req.id,
            success: false,
            error: { code: 'AGENT_NOT_FOUND', message: `Session ${req.sessionId} does not record an agent file path` },
          };
        }

        agentPath = found.session.agent.filePath;
        existingSessionId = req.sessionId;
        runCwd = found.session.project.cwd || req.projectRoot;
        continuationSession = { sessionId: req.sessionId, agentId: found.agentId };
        runPrompt = await buildContinuationPrompt(
          sessionManager,
          req.sessionId,
          found.agentId,
          found.session,
          req.prompt
        );
      }

      const agent = await parseAgent(agentPath);

      const envValidation = validateAgentEnvVars(agent.config);
      if (!envValidation.valid) {
        return restoreResumeAndReturn({
          id: req.id,
          success: false,
          error: { code: 'ENV_MISSING', message: formatEnvValidationError(envValidation) },
        });
      }

      if (req.model) {
        agent.config.model = req.model;
      }

      const mcpBasePath = dirname(agentPath);
      mcp = await connectMCP(agent.config.mcpServers, req.debug ?? false, mcpBasePath);

      const timeoutSeconds = req.timeout ?? agent.config.timeout ?? 300;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);
      let pluginManager: PluginManager | null = null;
      try {
        const projectContext = resolveProjectContext(req.projectRoot, { projectRoot: req.projectRoot });
        pluginManager = new PluginManager();
        await pluginManager.loadPlugins(projectContext.pluginDirs);
      } catch {
        pluginManager = null;
      }

      if (continuationSession) {
        await sessionManager.setSessionRunning(continuationSession.sessionId, continuationSession.agentId);
      }

      try {
        const result = await runAgent(
          agent,
          mcp,
          req.debug ?? false,
          abortController.signal,
          startTime,
          false,
          agentPath,
          req.maxSteps,
          sessionManager,
          // Serve registers projects explicitly; agents live in their registered
          // project so stateRoot equals projectRoot here.
          { projectRoot: req.projectRoot, stateRoot: req.projectRoot, cwd: runCwd },
          runPrompt,
          undefined,
          true,
          pluginManager,
          true,
          existingSessionId,
          req.runChannelHandles,
          req.type === 'continue-session' ? req.prompt : undefined,
          req.trigger
        );

        clearTimeout(timeoutId);
        resumeRollback = undefined;
        const duration = Date.now() - startTime;

        return {
          id: req.id,
          success: true,
          result: {
            text: result.text || '',
            ...(result.finishReason && { finishReason: result.finishReason }),
            duration,
            ...(result.usage && {
              tokens: {
                input: result.usage.inputTokens || 0,
                output: result.usage.outputTokens || 0,
              },
            }),
            toolCalls: result.toolCallCount || 0,
            ...(result.sessionId && { sessionId: result.sessionId }),
            ...(result.approvalUrl && { approvalUrl: result.approvalUrl }),
          },
        };
      } catch (err) {
        clearTimeout(timeoutId);
        if (sessionManager && resumeRollback) {
          await restoreResumeToolResult({ sessionManager, rollback: resumeRollback }).catch((restoreErr) => {
            logger.warn(`Failed to restore pending approval after resume error: ${(restoreErr as Error).message}`);
          });
          resumeRollback = undefined;
        }
        if (abortController.signal.aborted) {
          return {
            id: req.id,
            success: false,
            error: { code: 'TIMEOUT', message: `Agent execution timed out after ${timeoutSeconds}s` },
          };
        }
        return {
          id: req.id,
          success: false,
          error: { code: 'EXECUTION_ERROR', message: (err as Error).message },
        };
      }
    } catch (err) {
      if (sessionManager && resumeRollback) {
        await restoreResumeToolResult({ sessionManager, rollback: resumeRollback }).catch((restoreErr) => {
          logger.warn(`Failed to restore pending approval after resume error: ${(restoreErr as Error).message}`);
        });
      }
      return {
        id: req.id,
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
      };
    } finally {
      for (const conn of mcp) {
        try {
          await conn.client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Signal ready
  console.log(JSON.stringify({ type: 'ready' }));

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line) as ExecuteRequest;
      if (request.type === 'approval-info') {
        getApprovalInfo(request).then((response) => {
          console.log(JSON.stringify(response));
        });
      } else if (request.type === 'sweep-expired') {
        sweepExpiredApprovals(request).then((response) => {
          console.log(JSON.stringify(response));
        });
      } else if (request.type === 'list-approvals') {
        listAllApprovals(request).then((response) => {
          console.log(JSON.stringify(response));
        });
      } else if (request.type === 'list-sessions') {
        listSessions(request).then((response) => {
          console.log(JSON.stringify(response));
        });
      } else if (request.type === 'execute' || request.type === 'resume' || request.type === 'continue-session') {
        // Don't await - handle requests concurrently
        // Each request runs in parallel, response sent when complete
        executeAgent(request).then((response) => {
          console.log(JSON.stringify(response));
        });
      } else {
        console.log(JSON.stringify({
          id: (request as any).id || 'unknown',
          success: false,
          error: { code: 'UNKNOWN_REQUEST', message: 'Unknown request type' },
        }));
      }
    } catch (err) {
      console.log(JSON.stringify({
        id: 'unknown',
        success: false,
        error: { code: 'PARSE_ERROR', message: (err as Error).message },
      }));
    }
  }
}
