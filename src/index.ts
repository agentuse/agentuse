#!/usr/bin/env bun
import { parseAgent, parseAgentContent, ConfigError } from './parser';
import { connectMCP } from './mcp';
import { runAgent, prepareAgentExecution, classifyRunResult, executionOutcomeFields, runResultJson, type PreparedAgentExecution } from './runner';
import { isApprovalEnabled } from './runner/approval';
import { isMockMode, resolveMockApprovalDecision, resolveMockScope } from './runner/mock-tools';
import { Command } from 'commander';
import { createProviderCommand, createAuthCommand } from './cli/auth';
import { AuthStorage } from './auth/storage';
import { createSessionsCommand } from './cli/sessions';
import { createServeCommand } from './cli/serve';
import { createSetupCommand } from './cli/setup';
import { createModelsCommand } from './cli/models';
import { createSkillsCommand } from './cli/skills';
import { createBenchmarkCommand } from './cli/benchmark';
import { createAgentsCommand } from './cli/agents';
import { createAddCommand } from './cli/add';
import { createDoctorCommand } from './cli/doctor';
import { createLearningsCommand } from './cli/learnings';
import { createSchedulesCommand } from './cli/schedules';
import { addPluginCommands } from './cli/plugins';
import { BUILTIN_PROVIDERS } from './providers/registry-sources';
import { resolveModelProvider } from './utils/model-utils';
import { applyRunModelOverride, resolveModelString, type RunModelOverride } from './utils/model-alias';
import { logger, LogLevel } from './utils/logger';
import { resolve, dirname } from 'path';
import { hasAgentExtension, agentBaseName } from './utils/agent-name';
import * as readline from 'readline';
import { PluginManager } from './plugin';
import { getProviderPlugin } from './plugin/provider-runtime';
import { version as packageVersion } from '../package.json';
import { isDevCheckout, formatVersionLine } from './utils/build-info';
import { AuthenticationError } from './models';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolveLocalAgentPath, resolveProjectContext } from './utils/project';
import { loadGlobalDefaults } from './utils/global-config';
import { resolveTimeout } from './utils/config';
import { toErrorMessage } from './utils/error-message';
import { printLogo, type BrandingStyle } from './utils/branding';
import { validateAgentEnvVars, formatEnvValidationError } from './utils/env-validation';
import {
  telemetry,
  aggregateToolCalls,
  categorizeError,
  classifyExecution,
  configuredFeatureUsage,
  countSteps,
  emptyToolCallMetrics,
  isCanonicalRemoteExample,
  parseModel,
} from './telemetry';
import type { SessionManager as SessionManagerType } from './session';
import { findServerForProject } from './utils/server-registry';
import {
  getCachedCliUpdate,
  markUpdateNoticeShown,
  refreshUpdateCacheInBackground,
  type AvailableUpdate,
} from './update-check';

const program = new Command();
let pendingUpdateNotice: AvailableUpdate | null = null;

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
function isLoopbackHost(url: string): boolean {
  // Match on the parsed hostname exactly. A substring check on the whole URL
  // would also disable TLS verification for hostile hosts like
  // "https://localhost.attacker.com/x.agentuse".
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

async function fetchRemoteAgent(url: string): Promise<string> {
  // For localhost testing, allow self-signed certificates
  const fetchOptions: RequestInit = {};
  const loopback = isLoopbackHost(url);
  // Save and restore the prior value rather than deleting unconditionally, so a
  // user-set NODE_TLS_REJECT_UNAUTHORIZED survives this fetch.
  const priorTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (loopback) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`Failed to fetch agent from ${url}: ${response.statusText}`);
    }
    return await response.text();
  } finally {
    // Restore certificate validation to its prior state.
    if (loopback) {
      if (priorTlsSetting === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTlsSetting;
      }
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
  // Hand-rolled instead of .version(): the dev-build suffix comes from a
  // synchronous `git describe`, which must only run when the version is
  // actually printed, not on every command start.
  .option('-V, --version', 'output the version number')
  .on('option:version', () => {
    process.stdout.write(`${formatVersionLine()}\n`);
    process.exit(0);
  })
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

// Read-only cache lookup on the command path; the registry refresh uses an
// unref'd socket and can never hold up command startup or process exit.
program.hook('preAction', (_command, actionCommand) => {
  // Update-check opt-outs are supported in the same global .env/config env
  // sources as run and serve, so load them before reading cache or networking.
  // A malformed config must retain the command's own validation/reporting;
  // update checks are best-effort and may never become a new failure path.
  try {
    loadGlobalDefaults();
  } catch {
    return;
  }
  // A dev checkout is ahead of every published release; nagging it to
  // "update" to the version it already surpasses would be noise.
  if (isDevCheckout()) return;
  refreshUpdateCacheInBackground(packageVersion);
  const options = actionCommand.optsWithGlobals() as { quiet?: boolean; json?: boolean };
  // The long-lived daemon surfaces the same information in its Web UI; do not
  // print an update reminder into its terminal/log when it eventually exits.
  if (actionCommand.name() !== 'serve' && process.stderr.isTTY && !options.quiet && !options.json) {
    pendingUpdateNotice = getCachedCliUpdate(packageVersion);
  }
});

program.hook('postAction', () => {
  const update = pendingUpdateNotice;
  pendingUpdateNotice = null;
  if (!update) return;
  process.stderr.write(
    `\nUpdate available: agentuse ${update.currentVersion} → ${update.latestVersion}\n`
    + `Run: ${update.command}\n`,
  );
  markUpdateNoticeShown(update.latestVersion);
});

// Add provider command (manages auth + custom providers)
program.addCommand(createProviderCommand());

// Add 'auth' as hidden alias for backward compatibility (creates a second instance)
program.addCommand(createAuthCommand(), { hidden: true });

// Add sessions command
program.addCommand(createSessionsCommand());

// Add first-run setup command (browser or terminal)
program.addCommand(createSetupCommand());

// Add serve command (includes ps subcommand)
program.addCommand(createServeCommand());

// Add models command
program.addCommand(createModelsCommand());

// Add skills command
program.addCommand(createSkillsCommand());

// Add agents command
program.addCommand(createAgentsCommand());

// Add deployment-local schedule controls.
program.addCommand(createSchedulesCommand());

// Add add command
program.addCommand(createAddCommand());

// Add doctor command
program.addCommand(createDoctorCommand());

// Add learnings command
program.addCommand(createLearningsCommand());

// Canonical plugin namespace. Pi-style top-level commands remain hidden aliases.
addPluginCommands(program);

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
  .option('--mock', 'Mock all tool outputs with the LLM instead of executing them (for testing; no real side effects). Requires --mock-model.')
  .option('--mock-model <model>', 'Model that generates mock tool outputs (required with --mock; pick a cheap, reachable model)')
  .option('--mock-approval [decision]', 'Resolve the await_human approval gate deterministically instead of suspending (for fully-unattended mock runs): approve (default), reject, or comment:<text> (commented on the first gate, approved after). An approve grants the gated-command lease exactly like a real approval.')
  .action((file: string, promptArgs: string[], options: RunCommandOptions) => runCommandAction(file, promptArgs, options));

// `agentuse test`: sugar over the run pipeline for mock/test runs. Maps to the
// same option shape (mock/mockGated/mockApproval), so validation, env setup,
// banner, and execution are shared with `run`.
program
  .command('test <file> [prompt...]')
  .description('Test an agent with mocked tools, or use --replay to generate from recorded inputs without live tool operations.')
  .option('--replay <session-id>', 'Generate with current instructions and recorded tool results; stop at the first proposal or missing input, without live tools or review')
  .option('--scope <scope>', 'What to mock: "gated" (only tools.bash.gated commands; everything else real) or "all" (every tool result). Default: adaptive.')
  .option('--approval <decision>', 'Gate decision: approve (default), reject, or comment:<text> (comments the first gate, approves the re-gate)')
  .option('--mock-model <model>', 'Model that fabricates mock results (or set AGENTUSE_MOCK_MODEL once, e.g. in ~/.agentuse/.env)')
  .option('-q, --quiet', 'Suppress info messages (only show warnings and errors)')
  .option('-d, --debug', 'Enable debug mode with detailed logging and full error messages')
  .option('--no-tty', 'Disable TUI output (spinners, badges) for non-interactive use')
  .option('--compact', 'Use compact single-line header instead of ASCII logo')
  .option('--timeout <seconds>', 'Maximum execution time in seconds (default: 300)', '300')
  .option('-C, --directory <path>', 'Run as if agentuse was started in <path> instead of the current directory')
  .option('--env-file <path>', 'Path to custom .env file')
  .option('-m, --model <model>', 'Override the model specified in the agent file')
  .option('--json', 'Output result as JSON (implies --quiet --no-tty)')
  .action(async (file: string, promptArgs: string[], options: {
    scope?: string; approval?: string; mockModel?: string; replay?: string;
    quiet: boolean; debug: boolean; tty?: boolean; noTty?: boolean; compact: boolean;
    timeout: string; directory?: string; envFile?: string; model?: string; json?: boolean;
  }) => {
    if (options.replay) {
      if (options.scope || options.approval || options.mockModel || promptArgs.length || isURL(file)) {
        logger.error('--replay requires a local agent and the original recorded prompt; it cannot be combined with --scope, --approval, --mock-model, or a new prompt.');
        process.exit(1);
      }
      await runCommandAction(file, [], options);
      return;
    }
    let scope = options.scope;
    if (scope !== undefined && scope !== 'all' && scope !== 'gated') {
      logger.error(`Invalid --scope "${scope}". Use "gated" or "all".`);
      process.exit(1);
    }
    if (!scope) {
      // Adaptive default, decided by the one shared rule. Parse failures fall
      // back to "all" and surface properly inside the run.
      scope = 'all';
      try {
        const probePath = options.directory ? resolve(options.directory, file) : file;
        const probe = await parseAgent(probePath);
        scope = resolveMockScope(probe.config);
      } catch { /* remote URL or invalid file: let the run pipeline report it */ }
    }
    const { scope: _scope, approval, ...passthrough } = options;
    await runCommandAction(file, promptArgs, {
      ...passthrough,
      ...(scope === 'all' ? { mock: true } : { mockGated: true }),
      mockApproval: approval ?? 'approve',
    });
  });

interface RunCommandOptions {
  quiet: boolean; debug: boolean; tty?: boolean; noTty?: boolean; compact: boolean;
  timeout: string; directory?: string; envFile?: string; model?: string; sessionId?: string;
  json?: boolean; mock?: boolean; mockModel?: string; mockApproval?: boolean | string; mockGated?: boolean; replay?: string;
}

async function runCommandAction(file: string, promptArgs: string[], options: RunCommandOptions): Promise<void> {
    const startTime = Date.now();
    let originalCwd: string | undefined;
    const agentSource = isURL(file) ? 'remote' as const : 'local' as const;
    let executionClassification = classifyExecution({
      agentSource,
      trigger: 'manual',
      isMock: false,
      isExampleAgent: agentSource === 'remote' && isCanonicalRemoteExample(file),
    });
    let executionFeatures = configuredFeatureUsage(undefined, 'cli');

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

      // Load user-global defaults (~/.agentuse/.env then config.json `env`) before
      // anything reads env (mock model below, telemetry). Neither overrides a var
      // already set, so precedence is shell > .env > config.json.
      const { envFile: loadedGlobalEnvFile, configEnvKeys } = loadGlobalDefaults();
      if (loadedGlobalEnvFile) {
        logger.debug(`Loading global environment from: ${loadedGlobalEnvFile}`);
      }
      if (configEnvKeys.length > 0) {
        logger.debug(`Applied env from global config: ${configEnvKeys.join(', ')}`);
      }

      // Mock mode: tool outputs are LLM-generated, no real tools execute. Env so
      // the runner (loadAgentTools) and recursive sub-agents pick it up. A mock
      // model is required: mock fires an LLM call per tool result, and defaulting
      // onto the agent's own (premium, rate-limited) model is what produced the
      // opaque 429s this mode avoids. Force an explicit, reachable choice — the
      // --mock-model flag (which wins) or AGENTUSE_MOCK_MODEL from the shell,
      // ~/.agentuse/.env, or the config.json `env` block (resolved just above).
      if (options.mock && options.mockGated) {
        throw new Error('Mock scope conflict: "all" and "gated" cannot both be set. Use `agentuse test --scope all|gated`.');
      }
      if (options.mockModel) process.env.AGENTUSE_MOCK_MODEL = options.mockModel;
      if ((options.mock || options.mockGated) && !process.env.AGENTUSE_MOCK_MODEL) {
        throw new Error(
          'Mock runs require a mock model. Pass --mock-model <model>, or set AGENTUSE_MOCK_MODEL ' +
            '(in the shell, ~/.agentuse/.env, or the `env` block of ~/.agentuse/config.json). ' +
            'Mock generates fabricated tool results via that model, so use the lowest-end model you can ' +
            'reach (e.g. anthropic:claude-haiku-4-5 or openai:gpt-5.4-nano).',
        );
      }
      if (options.mock || options.mockGated) process.env.AGENTUSE_MOCK_MODE = '1';
      if (options.mockGated) {
        process.env.AGENTUSE_MOCK_SCOPE = 'gated';
        // Gated scope exists for unattended closed-loop runs, so default the
        // gate decision to approve; an explicit --mock-approval (or env) wins.
        if (!options.mockApproval && !process.env.AGENTUSE_MOCK_APPROVAL) {
          process.env.AGENTUSE_MOCK_APPROVAL = 'approve';
        }
      }
      if (options.mockApproval) {
        if (!isMockMode()) {
          throw new Error('--mock-approval only applies to mock runs. Pass --mock, use `agentuse test`, or set AGENTUSE_MOCK_MODE.');
        }
        process.env.AGENTUSE_MOCK_APPROVAL = options.mockApproval === true ? 'approve' : options.mockApproval;
      }
      if (isMockMode()) resolveMockApprovalDecision(); // fail fast on an invalid decision value, whatever its source
      executionClassification = classifyExecution({
        agentSource,
        trigger: 'manual',
        isMock: isMockMode(),
        isExampleAgent: agentSource === 'remote' && isCanonicalRemoteExample(file),
      });

      // Initialize telemetry
      await telemetry.init(packageVersion);

      const firstRun = await telemetry.isFirstRun();

      // Show ASCII logo (unless in quiet/json mode)
      if (!effectiveQuiet) {
        const brandingStyle: BrandingStyle = options.compact ? 'compact' : 'full';
        printLogo(brandingStyle);

        // Show first-run telemetry notice
        if (firstRun) {
          logger.info('agentuse collects anonymous usage data to improve the product.');
          logger.info('Set AGENTUSE_TELEMETRY_DISABLED=true to opt out.\n');
          // Acknowledgement means the disclosure was actually rendered. A
          // quiet/JSON invocation leaves it pending for the next visible run.
          await telemetry.markFirstRunComplete();
        }
      }

      if ((options.mock || options.mockGated) && !effectiveQuiet) {
        if (options.mockGated) {
          logger.warn('⚠ Mock mode (gated scope): only tools.bash.gated commands are mocked; EVERY other tool runs for real.');
        } else {
          logger.warn('⚠ Mock mode: tool outputs are LLM-generated; no real tools will run.');
        }
        logger.warn(`  Mock model: ${process.env.AGENTUSE_MOCK_MODEL}`);
        const mockDecision = resolveMockApprovalDecision();
        if (mockDecision) {
          const scopeNote = mockDecision.kind === 'comment'
            ? ' on the first gate, approve after'
            : '';
          logger.warn(`  Approval gate (await_human): auto-resolved as "${mockDecision.kind}"${scopeNote} (deterministic, no reviewer).`);
        } else {
          logger.warn('  Approval gate (await_human) stays real; pass --mock-approval to auto-resolve it (approve, reject, or comment:<text>).');
        }
      }

      // Log startup time if debug
      if (options.debug) {
        logger.info(`Starting AgentUse at ${new Date().toISOString()}`);
      }

      // Parse CLI timeout value (will be used as override later).
      // Commander accepts both "--timeout 600" (two tokens) and "--timeout=600"
      // (one token); the equals form must count as explicit too, otherwise the
      // user's value is silently dropped in favor of the YAML/300s default.
      const timeoutWasExplicit = process.argv.some(
        (a) => a === '--timeout' || a.startsWith('--timeout=')
      );
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
        if (!hasAgentExtension(file)) {
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
        const agentName = agentBaseName(file);
        agent = parseAgentContent(content!, agentName);
      } else {
        // Parse agent specification from local markdown file
        // Auto-append .agentuse extension if not specified
        let agentFile = file;
        if (!hasAgentExtension(file) && !existsSync(file)) {
          const withExt = `${file}.agentuse`;
          if (existsSync(withExt)) {
            agentFile = withExt;
          }
        }
        agentFilePath = resolve(agentFile);
        agent = await parseAgent(agentFile);
      }
      executionFeatures = configuredFeatureUsage(agent.config, 'cli');
      
      // Keep additional prompt separate (don't concatenate)
      if (additionalPrompt && options.debug) {
        logger.info(`Additional user prompt: ${additionalPrompt}`);
      }

      let runModelOverride: RunModelOverride | undefined;
      // Override model if specified via CLI
      if (options.model) {
        // Accept the same shorthand as frontmatter: a version alias
        // (`anthropic:claude-sonnet`) or a configured `@name`.
        const resolvedOverride = resolveModelString(options.model);
        runModelOverride = { requested: options.model, resolved: resolvedOverride };
        const overrideModel = resolvedOverride.model;
        // Bare IDs are canonical OpenAI model IDs; qualified IDs may select a
        // built-in or configured custom provider.
        const provider = resolveModelProvider(overrideModel);
        if (!BUILTIN_PROVIDERS.includes(provider)) {
          // Installed plugin providers share the same model namespace as
          // configured OpenAI-compatible providers. Load package plugins before
          // rejecting the override so `agentuse run -m pi:...` follows the same
          // provider discovery path as `agentuse models pi`.
          const [pluginProvider, customProvider] = await Promise.all([
            getProviderPlugin(provider),
            AuthStorage.getCustomProvider(provider),
          ]);
          if (!pluginProvider && !customProvider) {
            throw new Error(`Unknown provider '${provider}'. Built-in: ${BUILTIN_PROVIDERS.join(', ')}. Add custom providers with: agentuse provider add <name> --url <url>`);
          }
        }

        const originalModel = agent.config.model;
        applyRunModelOverride(agent.config, runModelOverride);
        logger.info(
          overrideModel === options.model
            ? `Model override: ${originalModel} → ${overrideModel}`
            : `Model override: ${originalModel} → ${overrideModel} (from ${options.model})`
        );

        // Warn if provider-specific options don't match the new provider
        if (agent.config.openai && provider !== 'openai') {
          logger.warn(`Warning: OpenAI-specific options in config will be ignored with ${provider} model`);
        }
      }

      if (options.replay) {
        if (!agentFilePath || !sessionManager) throw new Error('Replay requires a local agent and session storage.');
        const { runReplay, formatReplayResult } = await import('./replay/run');
        const abort = new AbortController();
        const cancel = () => abort.abort(new Error('Replay interrupted'));
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
        try {
          const replay = await runReplay({
            agent, agentFilePath, sourceSessionId: options.replay, sessionManager, projectContext: { ...projectContext, cwd: process.cwd() },
            timeoutSeconds: resolveTimeout(cliTimeoutSeconds, timeoutWasExplicit, agent.config.timeout),
            maxSteps: cliMaxSteps, abortSignal: abort.signal,
          });
          if (options.directory && originalCwd) process.chdir(originalCwd);
          await telemetry.shutdown();
          console.log(options.json ? JSON.stringify(replay) : formatReplayResult(replay));
          process.exitCode = replay.success ? 0 : 1;
          return;
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
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

      // Mocked approval resolves every gate inline (never suspends), so those
      // runs need no serve daemon; that is the whole point of unattended mock.
      const approvalNeedsServe = isApprovalEnabled(agent.config)
        && !(isMockMode() && resolveMockApprovalDecision());
      if (approvalNeedsServe && !hasServeForApprovalRun(projectContext.projectRoot, agentFilePath)) {
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
        mcp = await connectMCP(agent.config.mcpServers, options.debug, mcpBasePath, process.cwd());
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
        await pluginManager.loadPlugins(projectContext.pluginDirs, projectContext.projectRoot);
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
        ...(runModelOverride && { subagentModelOverride: runModelOverride }),
        agentFilePath,
        cliMaxSteps,
        sessionManager,
        projectContext: { projectRoot: projectContext.projectRoot, stateRoot: projectContext.stateRoot, cwd: process.cwd() },
        userPrompt: additionalPrompt || undefined,
        abortSignal: abortController.signal,
        pluginManager,
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
        // Show learnings count if any were applied. Always name the stored total
        // when it is larger: "10 applied" on a 57-learning file reads as "the file
        // is in force" when 47 of those entries had no effect on this run.
        if (preparedExecution.learningsApplied > 0) {
          const { learningsApplied: applied, learningsStored: stored } = preparedExecution;
          metadataLines.push(stored > applied
            ? `Learnings: ${applied} of ${stored} applied (${stored - applied} never reach this agent)`
            : `Learnings: ${applied} applied`);
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
        } else if (result.incomplete) {
          logger.warn(`Agent reported the run incomplete: ${result.incomplete.reason}`);
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
              classification: executionClassification,
              toolCalls: emptyToolCallMetrics(),
              features: executionFeatures,
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
              classification: executionClassification,
              toolCalls: emptyToolCallMetrics(),
              features: executionFeatures,
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

      const disposition = classifyRunResult(result);

      // Product success, not merely a clean process return. An agent-declared
      // incomplete run is a failed outcome everywhere automation can observe.
      telemetry.captureExecution({
        ...parseModel(agent.config.model),
        durationMs: Date.now() - startTime,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        ...executionOutcomeFields(result),
        classification: executionClassification,
        toolCalls: aggregateToolCalls(result.toolCallTraces),
        steps: countSteps(result.toolCallTraces),

        // Performance & Reliability
        finishReason: result.finishReason,
        hasTextOutput: result.hasTextOutput,

        // Feature Adoption
        features: executionFeatures,

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
        console.log(JSON.stringify(runResultJson(result, duration)));
      }

      process.exit(disposition.exitCode);
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
      await logSessionInterrupt(errorType ?? 'EXECUTION_ERROR', toErrorMessage(error));

      telemetry.captureExecution({
        provider: 'unknown',
        modelName: 'unknown',
        durationMs: Date.now() - startTime,
        inputTokens: 0,
        outputTokens: 0,
        success: false,
        classification: executionClassification,
        toolCalls: emptyToolCallMetrics(),
        features: executionFeatures,
        ...(errorType && { errorType }),
      });
      await telemetry.shutdown();

      if (options.json) {
        outputJsonError(errorType ?? 'EXECUTION_ERROR', toErrorMessage(error));
      } else {
        logger.error('Error', error as Error);
      }
      process.exit(1);
    }
}


// Handle internal worker mode (used by serve command)
// This must be checked before program.parse() to avoid Commander processing
if (process.argv[2] === '--internal-worker') {
  // Loaded lazily: the worker pulls in the session/storage/cascade stack that a
  // plain CLI invocation has no use for.
  void import('./worker/index.js').then(({ runInternalWorker }) => runInternalWorker());
} else {
  // Parse command line arguments
  program.parse(process.argv);

  // Show help if no command provided
  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
}
