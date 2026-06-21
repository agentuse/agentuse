#!/usr/bin/env bun
import { parseAgent, parseAgentContent, ConfigError } from './parser';
import { connectMCP } from './mcp';
import { runAgent, prepareAgentExecution, applyResumeToolResult, restoreResumeToolResult, describeErrorPart, describeLogPart, type PreparedAgentExecution } from './runner';
import { describeLearningOutcome } from './learning';
import { isApprovalEnabled } from './runner/approval';
import { findPendingSubagentWaitChildId, findPendingAwaitHumanPart, loadSessionPartsFlat, descendToLeafGate, findRootSessionId, MAX_CASCADE_DEPTH } from './runner/subagent-cascade';
import { contextUsageFromSnapshot } from './session/usage';
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
import { OPENCODE_GO_PROVIDER_ID } from './providers/opencode-go';
import { logger, LogLevel } from './utils/logger';
import { safeHttpUrl } from './utils/url';
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
import type { ActiveContextUsage, LogPartLevel, SessionInfo, SessionManager as SessionManagerType, SessionTrigger, ToolPart } from './session';
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
        const builtinProviders = ['anthropic', 'openai', 'openrouter', OPENCODE_GO_PROVIDER_ID, 'demo', 'bedrock'];
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
  const { initStorage, CorruptStorageError } = await import('./storage/index.js');

  // Configure logger to be quiet
  logger.configure({ level: LogLevel.ERROR, quiet: true, disableTUI: true });
  loadGlobalEnv();

  interface ExecuteRequest {
    id: string;
    type: 'execute' | 'resume' | 'continue-session' | 'approval-info' | 'session-status' | 'sweep-expired' | 'list-approvals' | 'list-sessions' | 'stop-session';
    agentPath?: string;
    projectRoot: string;
    prompt?: string;
    model?: string;
    timeout?: number;
    maxSteps?: number;
    debug?: boolean;
    sessionId?: string;
    /** Pre-assigned id for a fresh `execute` (serve detached run). */
    newSessionId?: string;
    toolResult?: unknown;
    resumeToken?: string;
    allowHistorical?: boolean;
    approvalCreatedAfter?: number;
    sessionsCreatedAfter?: number;
    includeSubagents?: boolean;
    // Trusted, server-set only: when the serve process has already authorized
    // the viewer (session token / api key / local), it asks for full approval
    // info regardless of the gate resumeToken. Never derived from client input.
    skipTokenCheck?: boolean;
    trigger?: SessionTrigger;
    runChannelHandles?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
    reason?: string;
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

  interface SessionTokenUsage {
    input: number;
    cachedInput: number;
    output: number;
    context?: ActiveContextUsage;
  }

  const activeExecutionControllers = new Map<string, AbortController>();
  const activeStoppedSessions = new Set<string>();

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
    artifactPaths?: string[];
    toolOutputArtifact?: {
      path: string;
      bytes?: number;
      originalChars?: number;
    };
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
    if (!session.error) return {};
    return {
      ...(typeof session.error.code === 'string' && session.error.code ? { errorCode: session.error.code } : {}),
      ...(typeof session.error.message === 'string' && session.error.message ? { errorMessage: session.error.message } : {})
    };
  }

  function aggregateSessionTokenUsage(
    messages: Array<{ assistant?: { tokens?: { input?: number; output?: number; cache?: { read?: number } }; context?: ActiveContextUsage } }>,
    contextOverride?: ActiveContextUsage
  ): SessionTokenUsage | undefined {
    if (messages.length === 0) return undefined;
    const usage = messages.reduce<SessionTokenUsage>((total, message) => {
      const tokens = message.assistant?.tokens;
      return {
        input: total.input + (typeof tokens?.input === 'number' ? tokens.input : 0),
        cachedInput: total.cachedInput + (typeof tokens?.cache?.read === 'number' ? tokens.cache.read : 0),
        output: total.output + (typeof tokens?.output === 'number' ? tokens.output : 0),
        ...(message.assistant?.context
          ? { context: message.assistant.context }
          : total.context
            ? { context: total.context }
            : {}),
      };
    }, { input: 0, cachedInput: 0, output: 0 });
    if (contextOverride) {
      usage.context = contextOverride;
    }
    return usage.input + usage.cachedInput + usage.output > 0 || usage.context ? usage : undefined;
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

  function formatTokenCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
  }

  function buildApprovalLogs(parts: any[]): Array<{ id: string; type: string; tool?: string; callId?: string; toolId?: string; status?: string; level?: LogPartLevel; title: string; message?: string; time?: number; details?: ApprovalLogDetails }> {
    return parts.map((part: any) => {
      if (part?.type === 'log') {
        const view = describeLogPart(part);
        return {
          id: String(part.id),
          type: 'log',
          level: view.level,
          ...(part.toolId && { toolId: String(part.toolId) }),
          title: view.title,
          ...(view.message !== undefined && { message: view.message }),
          ...(typeof part.time?.start === 'number' && { time: part.time.start })
        };
      }
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
          ...(typeof part.time?.end === 'number' ? { status: 'completed' } : { status: 'streaming' }),
          title: 'Reasoning',
          ...(message !== undefined && { message }),
          ...(typeof part.time?.start === 'number' && { time: part.time.start })
        };
      }
      if (part?.type === 'compaction') {
        const before = typeof part.tokensBefore === 'number' ? part.tokensBefore : 0;
        const after = typeof part.tokensAfter === 'number' ? part.tokensAfter : 0;
        const saved = before - after;
        const pct = before > 0 ? Math.round((saved / before) * 100) : 0;
        const reasonLabel = part.reason === 'approval'
          ? 'at approval gate'
          : part.reason === 'step'
            ? 'at step boundary'
            : 'near context limit';
        const message = before > 0
          ? `${formatTokenCount(before)} → ${formatTokenCount(after)} tokens (−${pct}%), ${reasonLabel}`
          : `Compacted ${reasonLabel}`;
        return {
          id: String(part.id),
          type: 'compaction',
          title: 'Context compacted',
          message,
          ...(typeof part.time?.start === 'number' && { time: part.time.start })
        };
      }
      if (part?.type === 'learning') {
        const { title, message } = describeLearningOutcome({
          status: part.status,
          source: part.source,
          count: typeof part.count === 'number' ? part.count : 0,
          titles: Array.isArray(part.titles) ? part.titles : undefined,
          detail: typeof part.detail === 'string' ? part.detail : undefined,
        });
        return {
          id: String(part.id),
          type: 'learning',
          // 'error' drives the warning styling for a failed capture; both other
          // outcomes are terminal/non-live.
          status: part.status === 'failed' ? 'error' : 'completed',
          title,
          message,
          ...(typeof part.time?.start === 'number' && { time: part.time.start })
        };
      }
      if (part?.type === 'error') {
        const { title, message } = describeErrorPart({
          source: part.source === 'compaction' ? 'compaction' : 'agent',
          code: typeof part.code === 'string' ? part.code : undefined,
          message: typeof part.message === 'string' ? part.message : 'Error',
          detail: typeof part.detail === 'string' ? part.detail : undefined,
          statusCode: typeof part.statusCode === 'number' ? part.statusCode : undefined,
        });
        return {
          id: String(part.id),
          type: 'error',
          status: 'error',
          title,
          message,
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
          ...(part.callID && { callId: String(part.callID) }),
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
    const safeDraftUrl = safeHttpUrl(input.draft_url);
    if (safeDraftUrl) fields.draftUrl = safeDraftUrl;
    const safeArtifactUrl = safeHttpUrl(input.artifact_url);
    if (safeArtifactUrl) fields.artifactUrl = safeArtifactUrl;
    const artifactPaths: string[] = [];
    if (typeof input.artifact_path === 'string' && input.artifact_path.trim()) artifactPaths.push(input.artifact_path.trim());
    if (Array.isArray(input.artifact_paths)) {
      for (const p of input.artifact_paths) {
        if (typeof p === 'string' && p.trim()) artifactPaths.push(p.trim());
      }
    }
    const uniqueArtifactPaths = [...new Set(artifactPaths)];
    if (uniqueArtifactPaths.length > 0) fields.artifactPaths = uniqueArtifactPaths;

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

  function normalizeToolOutputArtifact(value: unknown): ApprovalLogDetails['toolOutputArtifact'] | undefined {
    const artifact = valueAsRecord(value);
    if (artifact.kind !== 'tool-output' || typeof artifact.path !== 'string' || !artifact.path.trim()) {
      return undefined;
    }
    return {
      path: artifact.path.trim(),
      ...(typeof artifact.bytes === 'number' && { bytes: artifact.bytes }),
      ...(typeof artifact.originalChars === 'number' && { originalChars: artifact.originalChars }),
    };
  }

  function toolOutputArtifactFromText(text: string | undefined): ApprovalLogDetails['toolOutputArtifact'] | undefined {
    if (!text) return undefined;
    const match = text.match(/full tool output saved to session artifact:\s+([^\s)]+)(?:\s+\((\d+)\s+bytes\))?/i)
      ?? text.match(/full output saved to session artifact:\s+([^\s)]+)(?:\s+\((\d+)\s+bytes\))?/i);
    if (!match?.[1]) return undefined;
    return {
      path: match[1],
      ...(match[2] ? { bytes: Number.parseInt(match[2], 10) } : {}),
    };
  }

  function toolOutputArtifactFromState(state: any): ApprovalLogDetails['toolOutputArtifact'] | undefined {
    const stateMetadata = valueAsRecord(state?.metadata);
    const stateArtifact = normalizeToolOutputArtifact(stateMetadata.fullOutputArtifact);
    if (stateArtifact) return stateArtifact;

    const output = valueAsRecord(state?.output);
    const outputMetadata = valueAsRecord(output.metadata);
    const outputArtifact = normalizeToolOutputArtifact(outputMetadata.fullOutputArtifact);
    if (outputArtifact) return outputArtifact;

    const outputText = typeof state?.output === 'string'
      ? state.output
      : typeof output.output === 'string'
        ? output.output
        : undefined;
    return toolOutputArtifactFromText(outputText);
  }

  function buildToolDetails(state: any): ApprovalLogDetails | undefined {
    const fields: ApprovalLogDetails = {};
    const input = formatApprovalLogValue(state?.input);
    if (input !== undefined) fields.input = input;

    if (state?.status === 'completed') {
      const output = formatApprovalLogValue(state.output);
      if (output !== undefined) fields.output = output;
      const artifact = toolOutputArtifactFromState(state);
      if (artifact) fields.toolOutputArtifact = artifact;
    } else if (state?.status === 'error') {
      const error = formatApprovalLogValue(state.error);
      if (error !== undefined) fields.errorMessage = error;
    }

    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  function toolPartStartedAt(part: any): number | undefined {
    const state = part?.state ?? {};
    if (state.status === 'pending' && typeof state.suspendedAt === 'number') return state.suspendedAt;
    if (typeof state.time?.start === 'number') return state.time.start;
    return undefined;
  }

  function approvalWasRolledBackAfterResume(session: SessionInfo, approvalPart: any, parts: any[]): boolean {
    const state = approvalPart?.state ?? {};
    if (state.status !== 'pending' || !session.error) return false;
    const boundary = typeof state.suspendedAt === 'number' ? state.suspendedAt : undefined;
    if (boundary === undefined) return false;
    return parts.some((part) =>
      part?.type === 'tool' &&
      part?.id !== approvalPart.id &&
      (toolPartStartedAt(part) ?? 0) > boundary
    );
  }

  function logsWithRecoveredApprovalDecision(
    logs: ReturnType<typeof buildApprovalLogs>,
    approvalPart: any
  ): ReturnType<typeof buildApprovalLogs> {
    return logs.map((entry) => {
      if (entry.id !== String(approvalPart?.id)) return entry;
      const { resumeToken: _resumeToken, ...detailsWithoutResume } = entry.details ?? {};
      return {
        ...entry,
        status: 'completed',
        title: 'Approved',
        details: {
          ...detailsWithoutResume,
          decisionStatus: 'approved'
        }
      };
    });
  }

  function logsWithSessionError(
    logs: ReturnType<typeof buildApprovalLogs>,
    session: SessionInfo
  ): ReturnType<typeof buildApprovalLogs> {
    if (!session.error) return logs;
    const id = `session-error:${session.id}`;
    if (logs.some((entry) => entry.id === id)) return logs;
    const message = session.error.message || session.error.code || 'Session failed';
    const lastLogTime = logs.reduce((max, entry) => Math.max(max, entry.time ?? 0), 0);
    const errorTime = typeof (session.error as any).time === 'number' ? (session.error as any).time : undefined;
    const sessionTime = typeof session.time?.updated === 'number' ? session.time.updated : undefined;
    return [
      ...logs,
      {
        id,
        type: 'session',
        status: 'error',
        title: 'Session failed',
        time: Math.max(lastLogTime, errorTime ?? 0, sessionTime ?? 0) + 1,
        details: {
          errorMessage: message
        }
      }
    ];
  }

  async function childSessionSummaries(
    sessionManager: InstanceType<typeof SessionManager>,
    sessionId: string,
    sessionPath?: string
  ) {
    const children = await sessionManager.listChildSessions(sessionId, sessionPath);
    return children.map(({ session }) => ({
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
    }));
  }

  // Resume one existing (suspended) session to completion or re-suspension, reusing
  // the same prepare/run machinery as a top-level resume. The caller must already
  // have flipped the session to a resumable state (leaf gate resolved, or the
  // parent's subagent_wait bookmark completed + session set running). runAgent
  // closes the MCP clients in its own finally; we close them too if it never runs.
  async function runExistingSession(opts: {
    sessionManager: InstanceType<typeof SessionManager>;
    sessionId: string;
    projectRoot: string;
    abortController: AbortController;
    startTime: number;
    debug?: boolean;
    maxSteps?: number;
  }): Promise<Awaited<ReturnType<typeof runAgent>>> {
    const { sessionManager, sessionId, projectRoot, abortController, startTime, debug, maxSteps } = opts;
    const existingSessionPreRunError = Symbol.for('agentuse.existingSessionPreRunError');
    const markPreRunError = (error: unknown): unknown => {
      if (error && typeof error === 'object') {
        try {
          Object.defineProperty(error, existingSessionPreRunError, { value: true });
        } catch {
          // Non-extensible errors still propagate normally; they just won't be rollback-marked.
        }
      }
      return error;
    };
    let mcp: Awaited<ReturnType<typeof connectMCP>> = [];
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let enteredRunAgent = false;
    try {
      const found = await sessionManager.findSession(sessionId);
      if (!found || !found.session.agent.filePath) {
        throw new Error(`Cannot resume session ${sessionId}: missing agent file path`);
      }
      const agentPath = found.session.agent.filePath;
      const runCwd = found.session.project.cwd || projectRoot;
      const agent = await parseAgent(agentPath);
      mcp = await connectMCP(agent.config.mcpServers, debug ?? false, dirname(agentPath));
      const projectContext = { projectRoot, stateRoot: projectRoot, cwd: runCwd };
      let pluginManager: PluginManager | null = null;
      try {
        const pluginContext = resolveProjectContext(projectRoot, { projectRoot });
        pluginManager = new PluginManager();
        await pluginManager.loadPlugins(pluginContext.pluginDirs);
      } catch {
        pluginManager = null;
      }
      const timeoutSeconds = agent.config.timeout ?? 300;
      timeoutId = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);
      activeExecutionControllers.set(sessionId, abortController);
      const preparedExecution = await prepareAgentExecution({
        agent,
        mcpClients: mcp,
        agentFilePath: agentPath,
        cliMaxSteps: maxSteps,
        sessionManager,
        projectContext,
        abortSignal: abortController.signal,
        verbose: debug ?? false,
        existingSessionId: sessionId,
      });
      enteredRunAgent = true;
      return await runAgent(
        agent, mcp, debug ?? false, abortController.signal, startTime, false, agentPath,
        maxSteps, sessionManager, projectContext, undefined, preparedExecution, true,
        pluginManager, true, sessionId,
      );
    } catch (err) {
      // runAgent closes MCP in its own finally; if we threw before/around it, close
      // here so a failed cascade level does not leak stdio MCP subprocesses.
      for (const conn of mcp) {
        try { await conn.client.close(); } catch { /* ignore */ }
      }
      throw enteredRunAgent ? err : markPreRunError(err);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      activeExecutionControllers.delete(sessionId);
    }
  }

  function isExistingSessionPreRunError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as any)[Symbol.for('agentuse.existingSessionPreRunError')]);
  }

  // Complete a parent's parked subagent__* step with the resumed child's real output,
  // matching the shape the sub-agent tool returns on a normal run, so rehydration can
  // replay the tool result and the parent can resume.
  async function completeSubagentBookmark(
    sessionManager: InstanceType<typeof SessionManager>,
    parentSessionId: string,
    parentAgentId: string,
    childSessionId: string,
    childAgentName: string,
    childResult: Awaited<ReturnType<typeof runAgent>>
  ): Promise<NonNullable<Awaited<ReturnType<typeof applyResumeToolResult>>['rollback']>> {
    const parts = await loadSessionPartsFlat(sessionManager, parentSessionId, parentAgentId);
    const part = [...parts].reverse().find((p: any) =>
      p?.type === 'tool' &&
      p?.state?.status === 'pending' &&
      p?.state?.resumePayload?.kind === 'subagent_wait' &&
      p?.state?.resumePayload?.childSessionID === childSessionId
    ) as any;
    if (!part) {
      throw new Error(`No pending subagent_wait bookmark for child ${childSessionId} in ${parentSessionId}`);
    }
    const rollback = {
      sessionId: parentSessionId,
      agentId: parentAgentId,
      messageId: part.messageID,
      partId: part.id,
      state: part.state,
    };
    const start = typeof part.state?.suspendedAt === 'number' ? part.state.suspendedAt : Date.now();
    await sessionManager.updatePart(parentSessionId, parentAgentId, part.messageID, part.id, {
      state: {
        status: 'completed',
        input: part.state?.input ?? {},
        output: {
          output: childResult.text || 'Sub-agent completed without text response',
          metadata: {
            agent: childAgentName,
            ...(childResult.usage?.totalTokens && { tokensUsed: childResult.usage.totalTokens }),
          },
        },
        time: { start, end: Date.now() },
      },
    } as any);
    return rollback;
  }

  function cascadeReparkedResponse(reqId: string, rootSessionId: string) {
    // A level re-suspended on a new gate; the root chain stays durably parked and the
    // gate re-surfaces at the root on the next poll. Report 'suspended' so serve keeps
    // the session in its suspended/awaiting-approval handling.
    return {
      id: reqId,
      success: true as const,
      result: { text: '', finishReason: 'suspended', duration: 0, toolCalls: 0, sessionId: rootSessionId },
    };
  }

  // Resolve a delegated approval gate by descending to the leaf, resolving it, then
  // resuming child→…→root: run the leaf, complete each ancestor's bookmark with the
  // child's output and resume it, stopping if any level re-suspends. Returns
  // { handled: false } when the session is not a cascade root (caller does the normal
  // single-session resume).
  async function resumeApprovalCascade(opts: {
    sessionManager: InstanceType<typeof SessionManager>;
    rootSessionId: string;
    toolResult: unknown;
    resumeToken?: string;
    projectRoot: string;
    abortController: AbortController;
    startTime: number;
    reqId: string;
    debug?: boolean;
    maxSteps?: number;
  }): Promise<{ handled: false } | { handled: true; response: any }> {
    const { sessionManager, rootSessionId, toolResult, resumeToken, projectRoot, abortController, startTime, reqId, debug, maxSteps } = opts;

    const rootFound = await sessionManager.findSession(rootSessionId);
    if (!rootFound) return { handled: false };
    const rootParts = await loadSessionPartsFlat(sessionManager, rootSessionId, rootFound.agentId);
    let cursorChildId = findPendingSubagentWaitChildId(rootParts);
    if (!cursorChildId) return { handled: false };

    // Build the chain root → … → leaf following pending subagent_wait bookmarks.
    const chain: Array<{ sessionId: string; agentId: string; agentName: string }> = [
      { sessionId: rootSessionId, agentId: rootFound.agentId, agentName: rootFound.session.agent.name },
    ];
    let leafFound = false;
    for (let i = 0; i < MAX_CASCADE_DEPTH && cursorChildId; i++) {
      const f = await sessionManager.findSession(cursorChildId);
      if (!f || f.session.status !== 'suspended') break;
      chain.push({ sessionId: cursorChildId, agentId: f.agentId, agentName: f.session.agent.name });
      const parts = await loadSessionPartsFlat(sessionManager, cursorChildId, f.agentId);
      if (findPendingAwaitHumanPart(parts)) { leafFound = true; break; }
      cursorChildId = findPendingSubagentWaitChildId(parts);
    }
    if (!leafFound) return { handled: false };

    const leaf = chain[chain.length - 1];

    // 1. Resolve the leaf's human gate with the decision.
    let leafRollback: Awaited<ReturnType<typeof applyResumeToolResult>>['rollback'] | undefined;
    const appliedLeaf = await applyResumeToolResult({
      sessionManager,
      sessionId: leaf.sessionId,
      toolResult,
      ...(resumeToken && { resumeToken }),
    });
    leafRollback = appliedLeaf.rollback;

    // 2. Run the leaf to completion (or re-suspension on a new gate).
    let childResult: Awaited<ReturnType<typeof runAgent>>;
    try {
      childResult = await runExistingSession({ sessionManager, sessionId: leaf.sessionId, projectRoot, abortController, startTime, ...(debug !== undefined && { debug }), ...(maxSteps !== undefined && { maxSteps }) });
      leafRollback = undefined;
    } catch (error) {
      if (leafRollback && isExistingSessionPreRunError(error)) {
        await restoreResumeToolResult({ sessionManager, rollback: leafRollback }).catch((restoreErr) => {
          logger.warn(`Failed to restore delegated approval after resume setup error: ${(restoreErr as Error).message}`);
        });
      }
      throw error;
    }
    let childSessionId = leaf.sessionId;
    let childAgentName = leaf.agentName;
    if (childResult.status === 'suspended') {
      return { handled: true, response: cascadeReparkedResponse(reqId, rootSessionId) };
    }

    // 3. Walk up: complete each ancestor's bookmark with the child's output, resume it,
    //    stopping if it re-suspends (its gate re-surfaces at the root next poll).
    for (let i = chain.length - 2; i >= 0; i--) {
      const parent = chain[i];
      let parentRollback: Awaited<ReturnType<typeof completeSubagentBookmark>> | undefined;
      let enteredParentRun = false;
      let parentResult: Awaited<ReturnType<typeof runAgent>>;
      try {
        parentRollback = await completeSubagentBookmark(sessionManager, parent.sessionId, parent.agentId, childSessionId, childAgentName, childResult);
        await sessionManager.setSessionRunning(parent.sessionId, parent.agentId);
        enteredParentRun = true;
        parentResult = await runExistingSession({ sessionManager, sessionId: parent.sessionId, projectRoot, abortController, startTime, ...(debug !== undefined && { debug }), ...(maxSteps !== undefined && { maxSteps }) });
        parentRollback = undefined;
      } catch (error) {
        if (parentRollback && (!enteredParentRun || isExistingSessionPreRunError(error))) {
          await restoreResumeToolResult({ sessionManager, rollback: parentRollback }).catch((restoreErr) => {
            logger.warn(`Failed to restore sub-agent bookmark after resume setup error: ${(restoreErr as Error).message}`);
          });
        }
        throw error;
      }
      if (parentResult.status === 'suspended') {
        return { handled: true, response: cascadeReparkedResponse(reqId, rootSessionId) };
      }
      childResult = parentResult;
      childSessionId = parent.sessionId;
      childAgentName = parent.agentName;
    }

    const duration = Date.now() - startTime;
    return {
      handled: true,
      response: {
        id: reqId,
        success: true as const,
        result: {
          text: childResult.text || '',
          ...(childResult.finishReason && { finishReason: childResult.finishReason }),
          duration,
          ...(childResult.usage && { tokens: { input: childResult.usage.inputTokens || 0, output: childResult.usage.outputTokens || 0 } }),
          toolCalls: childResult.toolCallCount || 0,
          sessionId: rootSessionId,
        },
      },
    };
  }

  async function getApprovalInfo(req: ExecuteRequest) {
    return withApprovalInfoCache(approvalInfoCacheKey(req), req.id, async () => getApprovalInfoUncached(req));
  }

  async function getApprovalInfoUncached(req: ExecuteRequest) {
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
      const contextOverride = contextUsageFromSnapshot(await sessionManager.readContextSnapshot(req.sessionId, found.agentId));
      const tokenUsage = aggregateSessionTokenUsage(messages, contextOverride);
      // The per-run instruction this session was started with (CLI args / the
      // "run with custom instruction" composer), kept separate from the agent's
      // own body. It lives in the first message's metadata, not in the parts the
      // log is built from, so surface it here for the session page to display.
      const firstUserPrompt = messages[0]?.user?.prompt?.user;
      const additionalInstruction = typeof firstUserPrompt === 'string' && firstUserPrompt.trim()
        ? firstUserPrompt
        : undefined;
      const parts = (await Promise.all(
        messages.map((message) => sessionManager.getMessageParts(req.sessionId!, found.agentId, message.id))
      )).flat();
      let logs = logsWithSessionError(buildApprovalLogs(parts), found.session);
      const childSessions = await childSessionSummaries(
        sessionManager,
        req.sessionId,
        found.path
      );
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
      let effectiveApprovalPart = pendingApprovalPart ?? latestApprovalPart;

      // Cascade: this session may have no human gate of its own but be parked on a
      // delegated child (subagent_wait). Descend to the leaf holding the real gate
      // and surface it here, addressed at this (root/intermediate) session.
      let cascadeLeaf: { session: SessionInfo; agentId: string; parts: any[]; approvalPart: any } | null = null;
      if (!pendingApprovalPart) {
        const childSessionId = findPendingSubagentWaitChildId(parts);
        if (childSessionId) {
          cascadeLeaf = await descendToLeafGate(sessionManager, childSessionId);
          if (cascadeLeaf) effectiveApprovalPart = cascadeLeaf.approvalPart;
        }
      }

      // A delegated child viewed directly is view-only: approval happens at the root.
      const isDelegatedChild = typeof found.session.parentSessionID === 'string' && found.session.parentSessionID.length > 0;
      const parentSessionId = isDelegatedChild ? found.session.parentSessionID : undefined;
      const viewOnlyRootSessionId = isDelegatedChild
        ? await findRootSessionId(sessionManager, req.sessionId)
        : undefined;
      // Resolve the immediate parent's agent name so the child page can render a
      // readable breadcrumb back to it.
      let parentAgentName: string | undefined;
      if (parentSessionId) {
        const parentFound = await sessionManager.findSession(parentSessionId);
        parentAgentName = parentFound?.session.agent.name;
      }
      const viewOnlyFields = isDelegatedChild
        ? {
            viewOnly: true as const,
            ...(parentSessionId && { parentSessionId }),
            ...(parentAgentName && { parentAgentName }),
            ...(viewOnlyRootSessionId && { rootSessionId: viewOnlyRootSessionId }),
          }
        : {};
      const originAgentFields = cascadeLeaf
        ? { originAgent: {
            id: cascadeLeaf.session.agent.id,
            name: cascadeLeaf.session.agent.name,
            ...(cascadeLeaf.session.agent.filePath && { filePath: cascadeLeaf.session.agent.filePath }),
            ...(cascadeLeaf.session.agent.description && { description: cascadeLeaf.session.agent.description }),
          } }
        : {};

      if (!effectiveApprovalPart) {
        return {
          id: req.id,
          success: true,
          approval: {
            sessionId: req.sessionId,
            sessionStatus: found.session.status,
            ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
            model: found.session.model,
            ...sessionErrorFields(found.session),
            agent: {
              id: found.session.agent.id,
              name: found.session.agent.name,
              ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
              ...(found.session.agent.description && { description: found.session.agent.description })
            },
            ...viewOnlyFields,
            ...(additionalInstruction && { additionalInstruction }),
            ...(childSessions.length > 0 && { childSessions }),
            ...(tokenUsage && { tokenUsage }),
            logs
          },
        };
      }

      const state = effectiveApprovalPart.state;
      const rolledBackAfterResume = cascadeLeaf
        ? approvalWasRolledBackAfterResume(cascadeLeaf.session, effectiveApprovalPart, cascadeLeaf.parts)
        : approvalWasRolledBackAfterResume(found.session, effectiveApprovalPart, parts);
      const sessionStatus = rolledBackAfterResume ? 'error' : found.session.status;
      if (rolledBackAfterResume) {
        logs = logsWithRecoveredApprovalDecision(logs, effectiveApprovalPart);
      }
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
            sessionStatus,
            ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
            model: found.session.model,
            ...sessionErrorFields(found.session),
            agent: {
              id: found.session.agent.id,
              name: found.session.agent.name,
              ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
              ...(found.session.agent.description && { description: found.session.agent.description })
            },
            ...originAgentFields,
            ...viewOnlyFields,
            ...(additionalInstruction && { additionalInstruction }),
            ...(childSessions.length > 0 && { childSessions }),
            ...(tokenUsage && { tokenUsage }),
            logs
          },
        };
      }

      // Cascade: the gate lives on the leaf, but the root's log shows only its
      // pending `subagent__*` bookmark entry. Surface the leaf's full gate on
      // that bookmark entry (prompt/summary/draft/risk + resume token) so the
      // session page renders it as one actionable approval box. Without the
      // gate content the entry renders an empty approval card; without the
      // token the approve/reject/comment actions never attach. Skip for a
      // delegated child (its own page is view-only).
      if (cascadeLeaf && !isDelegatedChild && state.status === 'pending' && expectedToken && !rolledBackAfterResume) {
        const bookmarkPart = parts.find((part: any) =>
          part?.type === 'tool' &&
          part?.state?.status === 'pending' &&
          part?.state?.resumePayload?.kind === 'subagent_wait'
        );
        if (bookmarkPart) {
          const bookmarkId = String(bookmarkPart.id);
          const leafGateDetails = buildAwaitHumanDetails(state);
          if (leafGateDetails) {
            logs = logs.map((entry) => entry.id === bookmarkId
              ? { ...entry, details: { ...(entry.details ?? {}), ...leafGateDetails } }
              : entry);
          }
        }
      }

      const channelMessage = valueAsRecord(resumePayload.channelMessage);
      let approvalUrl: string | undefined;
      if (cascadeLeaf) {
        // The leaf minted a URL to its own (view-only) child page; the human acts at
        // the root, so rewrite the gate URL to this session.
        const { getSessionUrl } = await import('./tools/await-human.js');
        approvalUrl = getSessionUrl(req.sessionId, req.projectRoot);
      } else {
        approvalUrl = typeof resumePayload.approvalUrl === 'string'
          ? resumePayload.approvalUrl
          : typeof channelMessage.url === 'string'
            ? channelMessage.url
            : undefined;
      }
      const detailDraftUrl = safeHttpUrl(input.draft_url);
      const detailArtifactUrl = safeHttpUrl(input.artifact_url);
      return {
        id: req.id,
        success: true,
        approval: {
          sessionId: req.sessionId,
          sessionStatus,
          ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
          model: found.session.model,
          ...sessionErrorFields(found.session),
          agent: {
            id: found.session.agent.id,
            name: found.session.agent.name,
            ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
            ...(found.session.agent.description && { description: found.session.agent.description })
          },
          ...originAgentFields,
          ...viewOnlyFields,
          ...(additionalInstruction && { additionalInstruction }),
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
          ...(typeof input.summary === 'string' && { summary: input.summary }),
          ...(typeof input.draft === 'string' && { draft: input.draft }),
          ...(detailDraftUrl && { draftUrl: detailDraftUrl }),
          ...(detailArtifactUrl && { artifactUrl: detailArtifactUrl }),
          ...(typeof input.context === 'string' && { context: input.context }),
          ...(typeof input.risk === 'string' && { risk: input.risk }),
          ...(typeof resumePayload.surface === 'string' && { surface: resumePayload.surface }),
          ...(approvalUrl && { approvalUrl }),
          // Delegated children are view-only: never surface an actionable token; the
          // root surfaces the gate (with this same leaf token) for the human to act.
          ...(state.status === 'pending' && expectedToken && !rolledBackAfterResume && !isDelegatedChild && { currentResumeToken: expectedToken }),
          ...(typeof resumePayload.expiresAt === 'number' && { expiresAt: resumePayload.expiresAt }),
          ...(typeof state.suspendedAt === 'number' && { suspendedAt: state.suspendedAt }),
          ...(Object.keys(channelMessage).length > 0 && { channelMessage }),
          ...(state.status === 'completed' && { decision: state.output }),
          ...(childSessions.length > 0 && { childSessions }),
          ...(tokenUsage && { tokenUsage }),
          logs
        },
      };
    } catch (err) {
      // Corruption in the *requested* session's own files (session.json,
      // message, or part) can't be silently skipped like an unrelated session
      // in a list scan: it's the thing being viewed. Surface a distinct code so
      // the session page renders a clear "this session's data is corrupted"
      // error instead of spinning on a generic 500.
      if (err instanceof CorruptStorageError) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_CORRUPTED', message: `This session's stored data is corrupted and cannot be displayed (${err.message}).` },
        };
      }
      return {
        id: req.id,
        success: false,
        error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
      };
    }
  }

  async function getSessionStatusInfo(req: ExecuteRequest) {
    try {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for status request' },
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

      return {
        id: req.id,
        success: true,
        session: {
          sessionId: found.session.id,
          sessionStatus: found.session.status,
          ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
          ...(typeof found.session.time?.updated === 'number' && { updatedAt: found.session.time.updated }),
          model: found.session.model,
          ...sessionErrorFields(found.session),
          agent: {
            id: found.session.agent.id,
            name: found.session.agent.name,
            ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
            ...(found.session.agent.description && { description: found.session.agent.description })
          }
        }
      };
    } catch (err) {
      if (err instanceof CorruptStorageError) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_CORRUPTED', message: `This session's stored data is corrupted and cannot be displayed (${err.message}).` },
        };
      }
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
      const now = Date.now();
      const sweepCreatedAfter = now - 30 * 24 * 60 * 60 * 1000;
      const suspended = (await sessionManager.listSessionsCreatedAfter(sweepCreatedAfter, {
        includeSubagents: true
      })).filter(({ session }) => session.status === 'suspended');
      const expired: ExpiredApproval[] = [];

      for (const { session, agentId } of suspended) {
        const pendingPart = await sessionManager.getLatestApprovalPart(session.id, agentId);
        if (!pendingPart) continue;
        const state = pendingPart.state;
        if (state.status !== 'pending') continue;
        const resumePayload = state.resumePayload;
        const expiresAt = typeof resumePayload?.expiresAt === 'number' ? resumePayload.expiresAt : undefined;
        if (!expiresAt || expiresAt > now) continue;

        const start = state.suspendedAt ?? expiresAt;
        const timeoutMessage = `Approval not received before ${new Date(expiresAt).toISOString()}`;
        await sessionManager.updatePart(
          session.id,
          agentId,
          pendingPart.messageID,
          pendingPart.id,
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
          message: timeoutMessage
        }).catch(() => {});

        const rootSessionId = typeof session.parentSessionID === 'string' && session.parentSessionID.length > 0
          ? await findRootSessionId(sessionManager, session.id)
          : session.id;
        if (rootSessionId !== session.id) {
          await sessionManager.stopSessionTree(rootSessionId, {
            code: 'APPROVAL_TIMEOUT',
            message: timeoutMessage
          }).catch(() => {});
        }

        const input = valueAsRecord(state.input);
        const channelMessage = valueAsRecord(resumePayload?.channelMessage);
        expired.push({
          sessionId: rootSessionId,
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

      if (expired.length > 0) invalidateListCaches(req.projectRoot);

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

  function approvalPartCreatedAt(state: any, session: SessionInfo): number {
    const suspendedAt = typeof state?.suspendedAt === 'number' ? state.suspendedAt : undefined;
    const startedAt = typeof state?.time?.start === 'number' ? state.time.start : undefined;
    const endedAt = typeof state?.time?.end === 'number' ? state.time.end : undefined;
    return suspendedAt ?? startedAt ?? endedAt ?? session.time.created;
  }

  const approvalPartCache = new Map<string, {
    updatedAt: number;
    part: ToolPart | null;
  }>();
  const APPROVAL_INFO_CACHE_TTL_MS = 10_000;
  const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
  type ApprovalInfoResponse = Awaited<ReturnType<typeof getApprovalInfoUncached>>;
  type ApprovalInfoCacheEntry = {
    expiresAt: number;
    response?: Omit<ApprovalInfoResponse, 'id'>;
    promise?: Promise<ApprovalInfoResponse>;
  };
  type ListResponse = { id: string; success: boolean; [key: string]: unknown };
  type ListCacheEntry<T extends ListResponse> = {
    expiresAt: number;
    response?: Omit<T, 'id'>;
    promise?: Promise<T>;
  };
  const approvalInfoResponseCache = new Map<string, ApprovalInfoCacheEntry>();
  const listResponseCache = new Map<string, ListCacheEntry<ListResponse>>();

  function approvalPartCacheKey(projectRoot: string, session: SessionInfo, agentId: string): string {
    return `${projectRoot}\0${session.id}\0${agentId}`;
  }

  function approvalInfoCacheKey(req: ExecuteRequest): string {
    return [
      'approval-info',
      req.projectRoot,
      req.sessionId ?? '',
      req.resumeToken ?? '',
      req.allowHistorical ? 'historical' : 'latest',
      req.skipTokenCheck ? 'trusted' : 'token'
    ].join('\0');
  }

  function listCacheKey(req: ExecuteRequest, kind: 'approvals' | 'sessions'): string {
    return [
      kind,
      req.projectRoot,
      req.approvalCreatedAfter ?? '',
      req.sessionsCreatedAfter ?? '',
      req.includeSubagents ? 'subagents' : 'top'
    ].join('\0');
  }

  function invalidateListCaches(projectRoot?: string): void {
    approvalPartCache.clear();
    if (!projectRoot) {
      approvalInfoResponseCache.clear();
      listResponseCache.clear();
      return;
    }
    for (const key of [...approvalInfoResponseCache.keys()]) {
      if (key.includes(`\0${projectRoot}\0`)) approvalInfoResponseCache.delete(key);
    }
    for (const key of [...listResponseCache.keys()]) {
      if (key.includes(`\0${projectRoot}\0`)) listResponseCache.delete(key);
    }
  }

  function shouldCacheApprovalInfoResponse(
    response: ApprovalInfoResponse
  ): response is ApprovalInfoResponse & { success: true; approval: { sessionStatus: string } } {
    if (!response.success || !response.approval) return false;
    const status = response.approval.sessionStatus;
    return status === 'completed' || status === 'error';
  }

  async function withApprovalInfoCache(
    key: string,
    requestId: string,
    loader: () => Promise<ApprovalInfoResponse>
  ): Promise<ApprovalInfoResponse> {
    const now = Date.now();
    const cached = approvalInfoResponseCache.get(key);
    if (cached?.response && cached.expiresAt > now) {
      return { ...cached.response, id: requestId } as ApprovalInfoResponse;
    }
    if (cached?.promise) {
      const response = await cached.promise;
      return { ...response, id: requestId } as ApprovalInfoResponse;
    }

    const promise = loader();
    approvalInfoResponseCache.set(key, { expiresAt: now + APPROVAL_INFO_CACHE_TTL_MS, promise });
    try {
      const response = await promise;
      if (shouldCacheApprovalInfoResponse(response)) {
        const { id: _id, ...rest } = response;
        approvalInfoResponseCache.set(key, {
          expiresAt: Date.now() + APPROVAL_INFO_CACHE_TTL_MS,
          response: rest as Omit<ApprovalInfoResponse, 'id'>
        });
      } else {
        approvalInfoResponseCache.delete(key);
      }
      return response;
    } catch (error) {
      approvalInfoResponseCache.delete(key);
      throw error;
    }
  }

  async function withListCache<T extends ListResponse>(
    key: string,
    requestId: string,
    loader: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const cached = listResponseCache.get(key) as ListCacheEntry<T> | undefined;
    if (cached?.response && cached.expiresAt > now) {
      return { ...cached.response, id: requestId } as T;
    }
    if (cached?.promise) {
      const response = await cached.promise;
      return { ...response, id: requestId };
    }

    const promise = loader();
    listResponseCache.set(key, { expiresAt: now + LIST_CACHE_TTL_MS, promise } as ListCacheEntry<ListResponse>);
    try {
      const response = await promise;
      if (response.success) {
        const { id: _id, ...rest } = response;
        listResponseCache.set(key, {
          expiresAt: Date.now() + LIST_CACHE_TTL_MS,
          response: rest as Omit<T, 'id'>
        } as ListCacheEntry<ListResponse>);
      } else {
        listResponseCache.delete(key);
      }
      return response;
    } catch (error) {
      listResponseCache.delete(key);
      throw error;
    }
  }

  async function listAllApprovals(req: ExecuteRequest) {
    return withListCache(listCacheKey(req, 'approvals'), req.id, async () => {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const sessions = typeof req.approvalCreatedAfter === 'number'
        ? await sessionManager.listSessionsCreatedAfter(req.approvalCreatedAfter, {
            includeSubagents: true
          })
        : await sessionManager.listAllSessions();
      const approvals: ApprovalSummary[] = [];
      const sessionBatchSize = 16;

      const summarizeApproval = async (
        { session, agentId }: { session: SessionInfo; agentId: string }
      ): Promise<ApprovalSummary | null> => {
        // Delegated children surface through their root manager's single cascade
        // entry, not as separate approvals. Skip them here to avoid double-counting.
        if (typeof session.parentSessionID === 'string' && session.parentSessionID.length > 0) {
          return null;
        }
        const cacheKey = approvalPartCacheKey(req.projectRoot, session, agentId);
        const updatedAt = session.time.updated;
        const cached = approvalPartCache.get(cacheKey);
        let approvalPart = cached && cached.updatedAt === updatedAt
          ? cached.part
          : await sessionManager.getLatestApprovalPart(session.id, agentId);
        if (!cached || cached.updatedAt !== updatedAt) {
          approvalPartCache.set(cacheKey, { updatedAt, part: approvalPart });
        }
        // Cascade: a root parked on a delegated child's gate (subagent_wait) has no
        // await_human part of its own. Descend to the leaf and surface its gate here,
        // labeled with the leaf but addressed at the root session.
        let originAgentName: string | undefined;
        let originAgentFilePath: string | undefined;
        if (!approvalPart && session.status === 'suspended') {
          const rootParts = await loadSessionPartsFlat(sessionManager, session.id, agentId);
          const childId = findPendingSubagentWaitChildId(rootParts);
          if (childId) {
            const leaf = await descendToLeafGate(sessionManager, childId);
            if (leaf) {
              approvalPart = leaf.approvalPart;
              originAgentName = leaf.session.agent.name;
              originAgentFilePath = leaf.session.agent.filePath;
            }
          }
        }
        if (!approvalPart) return null;

        const state = approvalPart.state;
        const approvalCreatedAt = approvalPartCreatedAt(state, session);
        if (typeof req.approvalCreatedAfter === 'number' && approvalCreatedAt < req.approvalCreatedAfter) {
          return null;
        }
        const input = valueAsRecord(state.input);
        const metadata = 'metadata' in state ? valueAsRecord(state.metadata) : {};
        const resumePayload = state.status === 'pending'
          ? valueAsRecord(state.resumePayload)
          : valueAsRecord(metadata.resumePayload);
        const channelMessage = valueAsRecord(resumePayload.channelMessage);
        const output = state.status === 'completed' ? valueAsRecord(state.output) : {};
        const reviewer = valueAsRecord(output.reviewer);
        const suspendedAt = state.status === 'pending' && typeof state.suspendedAt === 'number'
          ? state.suspendedAt
          : undefined;

        let status: ApprovalSummaryStatus;
        let errorMessage: string | undefined;
        const sessionError = sessionErrorFields(session) as { errorCode?: string; errorMessage?: string };
        if (state.status === 'pending' && session.error?.code === 'USER_STOPPED') {
          status = 'errored';
          errorMessage = session.error.message || 'Session stopped by user';
        } else if (state.status === 'pending' && session.error?.code === 'TIMEOUT') {
          status = 'expired';
          errorMessage = session.error.message || 'Session timed out';
        } else if (state.status === 'pending' && session.status !== 'suspended' && session.status !== 'running') {
          // The gate part is still 'pending' but the run terminally ended (errored,
          // completed, stopped, timed out) without resolving it. An orphaned gate on a
          // dead session is not an actionable approval - classify it as errored so it
          // drops out of the pending bucket instead of lingering as unclearable forever.
          status = 'errored';
          errorMessage = session.error?.message || sessionError.errorMessage;
        } else if (state.status === 'pending') {
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
        if (sessionError.errorMessage) errorMessage = sessionError.errorMessage;

        const decisionAt = state.status === 'completed' || state.status === 'error'
          ? (typeof state.time?.end === 'number' ? state.time.end : undefined)
          : undefined;

        return {
          sessionId: session.id,
          agentId,
          // Label cascade entries with the originating leaf; addressed at the root.
          agentName: originAgentName ?? (session.agent.name || session.agent.id),
          ...(session.agent.description && { agentDescription: session.agent.description }),
          ...((originAgentFilePath ?? session.agent.filePath) && { agentFilePath: originAgentFilePath ?? session.agent.filePath }),
          status,
          sessionStatus: session.status,
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
          ...(typeof input.summary === 'string' && { summary: input.summary }),
          ...(typeof input.risk === 'string' && { risk: input.risk }),
          ...(suspendedAt !== undefined && { suspendedAt }),
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
    });
  }

  async function listSessions(req: ExecuteRequest) {
    return withListCache(listCacheKey(req, 'sessions'), req.id, async () => {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const sessions = typeof req.sessionsCreatedAfter === 'number'
        ? await sessionManager.listSessionsCreatedAfter(req.sessionsCreatedAfter, {
            includeSubagents: req.includeSubagents ?? false
          })
        : await sessionManager.listAllSessions();

      // Top-level runs by default; approval-filtered session views opt into
      // subagents so approval history links can land on the exact run.
      const summaries = sessions
        .filter(({ session }) => req.includeSubagents || (!session.parentSessionID && !session.agent.isSubAgent))
        .map(({ session }) => ({
          sessionId: session.id,
          ...(session.parentSessionID && { parentSessionId: session.parentSessionID }),
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
    });
  }

  async function executeAgent(req: ExecuteRequest) {
    const startTime = Date.now();
    let mcp: Awaited<ReturnType<typeof connectMCP>> = [];
    let sessionManager: InstanceType<typeof SessionManager> | undefined;
    let resumeRollback: Awaited<ReturnType<typeof applyResumeToolResult>>['rollback'] | undefined;
    let continuationSession: { sessionId: string; agentId: string } | undefined;
    let activeSessionId: string | undefined;

    const abortController = new AbortController();
    // Register the abort handle under the known session id up front, before the
    // run's async setup (env load, storage init, MCP connect, prepareAgentExecution).
    // Otherwise a stop request arriving during that window finds no controller,
    // is silently dropped, and the run finishes and overwrites the stopped
    // status with success. Fresh runs have no pre-known sessionId and cannot be
    // raced before their id exists, so they only register once it is known.
    // Detached runs DO pre-assign their id (req.newSessionId), so register
    // under it too, otherwise an early stop request would be silently dropped.
    const knownSessionId = req.sessionId ?? req.newSessionId;
    if (knownSessionId) {
      activeExecutionControllers.set(knownSessionId, abortController);
    }

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
      invalidateListCaches(req.projectRoot);
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

        // Cascade: if this session is a manager root parked on a delegated child's
        // gate (subagent_wait), resolve + resume the whole chain rather than a single
        // session. Falls through to the normal resume when there is no cascade.
        const cascade = await resumeApprovalCascade({
          sessionManager,
          rootSessionId: req.sessionId,
          toolResult: req.toolResult,
          ...(req.resumeToken && { resumeToken: req.resumeToken }),
          projectRoot: req.projectRoot,
          abortController,
          startTime,
          reqId: req.id,
          ...(req.debug !== undefined && { debug: req.debug }),
          ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
        });
        if (cascade.handled) {
          return cascade.response;
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
      const timeoutId = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);
      const projectContext = { projectRoot: req.projectRoot, stateRoot: req.projectRoot, cwd: runCwd };
      let pluginManager: PluginManager | null = null;
      try {
        const pluginContext = resolveProjectContext(req.projectRoot, { projectRoot: req.projectRoot });
        pluginManager = new PluginManager();
        await pluginManager.loadPlugins(pluginContext.pluginDirs);
      } catch {
        pluginManager = null;
      }

      const preparedExecution = await prepareAgentExecution({
        agent,
        mcpClients: mcp,
        agentFilePath: agentPath,
        cliMaxSteps: req.maxSteps,
        sessionManager,
        projectContext,
        userPrompt: runPrompt,
        abortSignal: abortController.signal,
        verbose: req.debug ?? false,
        existingSessionId,
        ...(req.trigger && { trigger: req.trigger }),
        // Detached runs only: pre-assign the fresh session's id. Ignored on the
        // resume/continue paths, which carry existingSessionId instead.
        ...(req.type === 'execute' && req.newSessionId && { newSessionId: req.newSessionId })
      });

      activeSessionId = preparedExecution.sessionID ?? existingSessionId;

      if (continuationSession) {
        await sessionManager.setSessionRunning(continuationSession.sessionId, continuationSession.agentId);
      }

      if (activeSessionId) {
        activeExecutionControllers.set(activeSessionId, abortController);
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
          projectContext,
          runPrompt,
          preparedExecution,
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

        // Learning capture (execution + any reviewer comments) runs once inside
        // runAgent's post-run lifecycle, so nothing extra is needed here.

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
        // Once the agent run has started, keep the reviewer's decision durable.
        // Rolling the await_human part back here makes an accepted approval look
        // pending again after a downstream model/tool error, which is both
        // misleading and can invite duplicate external actions. Preflight
        // failures before runAgent still use restoreResumeAndReturn above.
        resumeRollback = undefined;
        if (abortController.signal.aborted) {
          // The stop marker is keyed by the session id stopSession saw, which
          // for resume/continue is req.sessionId; fall back to it when the abort
          // landed before activeSessionId was resolved so an early user-stop is
          // not misreported as a timeout.
          const stoppedSessionId = (activeSessionId && activeStoppedSessions.has(activeSessionId))
            ? activeSessionId
            : (req.sessionId && activeStoppedSessions.has(req.sessionId))
              ? req.sessionId
              : undefined;
          const stoppedByUser = stoppedSessionId !== undefined;
          if (stoppedByUser && sessionManager) {
            await sessionManager.stopSessionTree(stoppedSessionId, {
              code: 'USER_STOPPED',
              message: 'Session stopped by user'
            }).catch(() => {});
          }
          return {
            id: req.id,
            success: false,
            error: stoppedByUser
              ? { code: 'USER_STOPPED', message: 'Session stopped by user' }
              : { code: 'TIMEOUT', message: `Agent execution timed out after ${timeoutSeconds}s` },
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
      // Clear both the up-front (req.sessionId) and resolved (activeSessionId)
      // registrations; they usually coincide for resume/continue but may differ
      // defensively, and a stale entry would wrongly abort a later run reusing
      // the same id.
      for (const id of new Set([activeSessionId, req.sessionId, req.newSessionId])) {
        if (!id) continue;
        activeExecutionControllers.delete(id);
        activeStoppedSessions.delete(id);
      }
      for (const conn of mcp) {
        try {
          await conn.client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
      invalidateListCaches(req.projectRoot);
    }
  }

  async function stopSession(req: ExecuteRequest) {
    try {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for stop request' },
        };
      }

      const controller = activeExecutionControllers.get(req.sessionId);
      if (controller) {
        activeStoppedSessions.add(req.sessionId);
        controller.abort();
      }

      await initStorage(req.projectRoot);
      invalidateListCaches(req.projectRoot);
      const sessionManager = new SessionManager();
      const stopped = await sessionManager.stopSessionTree(req.sessionId, {
        code: 'USER_STOPPED',
        message: req.reason || 'Session stopped by user'
      });
      if (stopped.length === 0) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
        };
      }
      return {
        id: req.id,
        success: true,
        stopped
      };
    } catch (err) {
      return {
        id: req.id,
        success: false,
        error: { code: 'STOP_SESSION_ERROR', message: (err as Error).message },
      };
    } finally {
      invalidateListCaches(req.projectRoot);
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const parentPid = process.ppid;
  let workerExiting = false;
  let parentWatchTimer: NodeJS.Timeout | undefined;
  const exitWorker = (code = 0) => {
    if (workerExiting) return;
    workerExiting = true;
    if (parentWatchTimer) clearInterval(parentWatchTimer);
    rl.close();
    process.exit(code);
  };

  parentWatchTimer = setInterval(() => {
    if (parentPid === 1 || process.ppid !== parentPid || process.ppid === 1) {
      exitWorker(0);
    }
  }, 1_000);
  parentWatchTimer.unref?.();
  process.stdin.once('end', () => exitWorker(0));
  process.stdin.once('close', () => exitWorker(0));
  process.once('SIGTERM', () => exitWorker(0));
  process.once('SIGINT', () => exitWorker(130));

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
      } else if (request.type === 'session-status') {
        getSessionStatusInfo(request).then((response) => {
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
      } else if (request.type === 'stop-session') {
        stopSession(request).then((response) => {
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

  exitWorker(0);
}
