#!/usr/bin/env bun
import { parseAgent, parseAgentContent, ConfigError } from './parser';
import { connectMCP } from './mcp';
import { runAgent, prepareAgentExecution, applyResumeToolResult, restoreResumeToolResult, reopenSuspendedGate, reconcileOrphanedSessions, describeErrorPart, describeLogPart, classifyRunResult, executionOutcomeFields, runResultJson, workerRunResponse, type PreparedAgentExecution } from './runner';
import { describeLearningOutcome } from './learning';
import { isApprovalEnabled } from './runner/approval';
import { isMockMode, resolveMockApprovalDecision } from './runner/mock-tools';
import { extractToolIntent, withoutToolIntent } from './runner/tool-intent';
import { LIVE_OUTPUT_METADATA_KEY } from './tools/types';
import { composeSubagentResult, formatOutcomeLine, normalizeHeadline, stripLeadingOutcomeLine, REPORT_COMPLETE_TOOL, REPORT_INCOMPLETE_TOOL } from './tools/report-outcome';
import { findPendingSubagentWaitChildId, findPendingAwaitHumanPart, loadSessionPartsFlat, descendToLeafGate, findStaleCascadeChild, describeStaleCascade, isFinishableStale, loadStoredSubagentResult, CASCADE_ORPHANED_CODE, findRootSessionId, MAX_CASCADE_DEPTH } from './runner/subagent-cascade';
import { currentProcessRef } from './utils/process-info';
import { withOwnershipLock } from './utils/ownership-lock';
import { contextUsageFromSnapshot } from './session/usage';
import { buildImportantDescendantEvents, buildImportantDescendants } from './session/important-descendants';
import { summarizeSessionTiming } from './session/timing';
import { repairEscapedText } from './utils/display-text';
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
import { BUILTIN_PROVIDERS } from './providers/registry-sources';
import { resolveModelProvider } from './utils/model-utils';
import { applyRunModelOverride, resolveModelString, type RunModelOverride } from './utils/model-alias';
import { logger, LogLevel } from './utils/logger';
import { safeHttpUrl } from './utils/url';
import { basename, resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';
import { PluginManager } from './plugin';
import { version as packageVersion } from '../package.json';
import { existsSync as existsSyncFs } from 'fs';
import { createHash } from 'crypto';

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
import type { ActiveContextUsage, LogPartLevel, Part, SessionInfo, SessionManager as SessionManagerType, SessionTrigger, ToolPart } from './session';
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
  .description('Test an agent in mock mode: side effects fabricated, approval gates auto-resolved, stores isolated. Scope defaults to "gated" when the agent declares tools.bash.gated, else "all".')
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
    scope?: string; approval?: string; mockModel?: string;
    quiet: boolean; debug: boolean; tty?: boolean; noTty?: boolean; compact: boolean;
    timeout: string; directory?: string; envFile?: string; model?: string; json?: boolean;
  }) => {
    let scope = options.scope;
    if (scope !== undefined && scope !== 'all' && scope !== 'gated') {
      logger.error(`Invalid --scope "${scope}". Use "gated" or "all".`);
      process.exit(1);
    }
    if (!scope) {
      // Adaptive default: gated scope when the agent fences off commands, so
      // the run grounds itself in real state; full mock otherwise. Parse
      // failures fall back to "all" and surface properly inside the run.
      scope = 'all';
      try {
        const probePath = options.directory ? resolve(options.directory, file) : file;
        const probe = await parseAgent(probePath);
        if ((probe.config.tools?.bash?.gated?.length ?? 0) > 0) scope = 'gated';
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
  json?: boolean; mock?: boolean; mockModel?: string; mockApproval?: boolean | string; mockGated?: boolean;
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
          // Check if it's a custom provider
          const customProvider = await AuthStorage.getCustomProvider(provider);
          if (!customProvider) {
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
        ...(runModelOverride && { subagentModelOverride: runModelOverride }),
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
  const { initStorage, CorruptStorageError, readJSON, writeJSON } = await import('./storage/index.js');
  const { buildSessionContextPayload } = await import('./cli/serve/context-stack.js');

  // Configure logger to be quiet
  logger.configure({ level: LogLevel.ERROR, quiet: true, disableTUI: true });
  loadGlobalDefaults();

  interface ExecuteRequest {
    id: string;
    type: 'execute' | 'resume' | 'continue-session' | 'finish-cascade' | 'approval-info' | 'session-status' | 'create-preparing-session' | 'fail-preparing-session' | 'session-context' | 'sweep-expired' | 'reconcile-orphans' | 'list-approvals' | 'list-sessions' | 'session-final-responses' | 'stop-session' | 'reopen-gate' | 'invalidate-lists' | 'release';
    agentPath?: string;
    /** In-memory agent definition. Fresh execute only; never persisted as a file. */
    agentContent?: string;
    agentName?: string;
    agentId?: string;
    agentDescription?: string;
    projectRoot: string;
    /** invalidate-lists: hold the short list TTL for a window (start pokes). */
    externalActivity?: boolean;
    prompt?: string;
    model?: string;
    timeout?: number;
    /** Runtime timeout persisted on a preparing shell; distinct from IPC timeout. */
    sessionTimeout?: number;
    maxSteps?: number;
    debug?: boolean;
    sessionId?: string;
    /** Pre-assigned id for a fresh `execute` (serve detached run). */
    newSessionId?: string;
    /** Fresh execution must atomically promote an existing preparing shell. */
    preparedSession?: boolean;
    preparerOwner?: { pid: number; procStartedAt?: string };
    errorCode?: string;
    errorMessage?: string;
    toolResult?: unknown;
    resumeToken?: string;
    allowHistorical?: boolean;
    approvalCreatedAfter?: number;
    sessionsUpdatedAfter?: number;
    includeSubagents?: boolean;
    sessionsLimit?: number;
    sessionsPerAgent?: number;
    sessionsMock?: 'exclude' | 'include' | 'only';
    sessionRefs?: Array<{ sessionId: string; agentId: string }>;
    /** reconcile-orphans: only sessions last touched before this timestamp (the
     *  reconciling worker's ready time) are treated as orphans of a dead worker. */
    reconcileCutoff?: number;
    // Trusted, server-set only: when the serve process has already authorized
    // the viewer (session token / api key / local), it asks for full approval
    // info regardless of the gate resumeToken. Never derived from client input.
    skipTokenCheck?: boolean;
    trigger?: SessionTrigger;
    runChannelHandles?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
    reason?: string;
    /** stop-session: reviewer-initiated, so an already-ended failed session is
     *  stamped dismissedAt (reviewed) instead of being a no-op. */
    dismissEnded?: boolean;
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

  interface ApprovalChange {
    label?: string;
    content: string;
    displayContent?: string;
    optionId?: string;
  }

  interface ApprovalReference {
    label?: string;
    author?: string;
    title?: string;
    url?: string;
    excerpt?: string;
  }

  interface ApprovalOption {
    id: string;
    label: string;
    description?: string;
    recommended?: boolean;
  }

  interface ApprovalLogDetails {
    resumeToken?: string;
    prompt?: string;
    /** Model-declared goal of this call (the injected `intent` parameter). */
    intent?: string;
    input?: string;
    output?: string;
    /** Bounded tail of a still-running tool call, replaced by `output` when it finishes. */
    liveOutput?: string;
    tokenUsage?: {
      input: number;
      output: number;
      cachedInput: number;
      sharedCalls?: number;
    };
    summary?: string;
    context?: string;
    risk?: string;
    draft?: string;
    changes?: ApprovalChange[];
    reference?: ApprovalReference;
    options?: ApprovalOption[];
    draftUrl?: string;
    artifactUrl?: string;
    artifactPaths?: string[];
    /** Gate-time snapshots of referenced media (see session/gate-artifacts). */
    artifactSnapshots?: Array<{ path: string; hash: string; ext: string; bytes?: number }>;
    toolOutputArtifact?: {
      path: string;
      bytes?: number;
      originalChars?: number;
    };
    /** A completed sub-agent call's result as the child declared it (see
     *  subagentResultFromState), so the parent's row reads on its own. */
    subagentResult?: {
      headline?: string;
      incomplete?: string;
      artifacts?: string[];
      body?: string;
    };
    /** The run's own verdict and report as delivered through `report_complete` /
     *  `report_incomplete` (see collectRunOutcomes), rendered on that call's row
     *  instead of behind its expand toggle. */
    runOutcome?: {
      kind: 'complete' | 'incomplete';
      headline: string;
      body?: string;
      artifacts?: string[];
    };
    /** A deliverable saved by `tools__artifact_save`, rendered as a viewable tile. */
    savedArtifact?: {
      url: string;
      path: string;
      title?: string;
      group?: string;
    };
    decisionStatus?: string;
    decisionComment?: string;
    decisionChoice?: string;
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
    /** The gate offers a pick-among-options menu; one-tap approve is not enough. */
    hasOptions?: boolean;
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

  interface ApprovalProjectionIndexV1 {
    version: 1;
    approvalGeneration: number;
    approvals: ApprovalSummary[];
  }

  interface ApprovalProjectionIndexV2 {
    version: 2;
    approvalGeneration: number;
    approvals: ApprovalSummary[];
    /** Newest approval-relevant session-index timestamp in each root cascade.
     * Used to refresh only approval-bearing runs whose durable gate state changed. */
    sourceUpdatedAt: Record<string, number>;
  }

  type ApprovalProjectionIndex = ApprovalProjectionIndexV1 | ApprovalProjectionIndexV2;

  function approvalProjectionKey(projectRoot: string): string {
    const projectHash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 20);
    return `.index/approvals.${projectHash}.v1`;
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
    // Resuming or continuing a failed run flips the status back to running but
    // leaves the old error on the record (it's kept as history for the session
    // log). Only report it while the failure is still the session's current
    // state, or every list row would keep showing a stale "failed" line under a
    // run that is working again.
    if (session.status !== undefined && session.status !== 'error') return {};
    return {
      ...(typeof session.error.code === 'string' && session.error.code ? { errorCode: session.error.code } : {}),
      ...(typeof session.error.message === 'string' && session.error.message ? { errorMessage: session.error.message } : {})
    };
  }

  // Reviewer's "reviewed, wave it off" stamp on an ended failed run; surfaced
  // so needs-attention lists drop the row and the UI hides the Discard action.
  function dismissedAtField(session: { dismissedAt?: number }) {
    return typeof session.dismissedAt === 'number' ? { dismissedAt: session.dismissedAt } : {};
  }

  // Showcase mode: mock runs stay fully functional (cheap, no real side effects)
  // but AGENTUSE_HIDE_MOCK=1 suppresses the mock flag in serve payloads so a demo
  // does not read as fake. Storage keeps session.mock intact; only the API/UI view
  // is affected.
  function mockField(session: { mock?: boolean }) {
    return session.mock && process.env.AGENTUSE_HIDE_MOCK !== '1' ? { mock: true as const } : {};
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

  async function buildContinuationPrompt(
    sessionManager: InstanceType<typeof SessionManager>,
    sessionId: string,
    agentId: string,
    session: { id: string; status: string },
    prompt?: string
  ): Promise<string> {
    const previous = await sessionManager.getLastAssistantText(sessionId, agentId);
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

  /**
   * Pair each `report_complete` / `report_incomplete` call with the assistant
   * text part the runtime wrote to deliver it, so the session view can render
   * the report on the call's own row and drop the duplicate text row.
   *
   * The pairing key is the opener line the runtime composes from the call's own
   * input ("✅ Complete: <headline>"), which makes this work on runs recorded
   * before this row existed — no marker on the stored part is needed.
   *
   * The body comes from the delivered text rather than straight from the call's
   * `details`, because the runtime merges `details` with any prose the agent
   * streamed alongside it; rebuilding from `details` alone would drop the
   * deliverable of an agent that streamed its document and attached a briefing
   * (agentuse-lab#198). Only the LAST match is claimed: an agent that typed the
   * opener itself keeps its own message as a real assistant response.
   */
  function collectRunOutcomes(parts: any[]): {
    outcomeByPartId: Map<string, NonNullable<ApprovalLogDetails['runOutcome']>>;
    deliveredTextIds: Set<string>;
  } {
    const outcomeByPartId = new Map<string, NonNullable<ApprovalLogDetails['runOutcome']>>();
    const deliveredTextIds = new Set<string>();
    const openerToPartId = new Map<string, string>();
    for (const part of parts) {
      if (part?.type !== 'tool') continue;
      const tool = String(part.tool ?? '');
      if (tool !== REPORT_COMPLETE_TOOL && tool !== REPORT_INCOMPLETE_TOOL) continue;
      const input = valueAsRecord(part.state?.input);
      const opener = formatOutcomeLine(tool, input);
      if (!opener) continue;
      const kind = tool === REPORT_COMPLETE_TOOL ? 'complete' as const : 'incomplete' as const;
      const artifacts = Array.isArray(input.artifacts)
        ? input.artifacts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        : [];
      // Stands in until the delivered text is found below: during a live run the
      // call lands a tick before the text part that delivers it.
      const attached = typeof input.details === 'string' ? repairEscapedText(input.details).trim() : '';
      const raw = kind === 'complete' ? input.headline : input.reason;
      outcomeByPartId.set(String(part.id), {
        kind,
        // The row draws its own verdict mark, so the headline arrives bare
        // rather than carrying the opener's "✅ Complete: " prefix.
        headline: normalizeHeadline(typeof raw === 'string' ? repairEscapedText(raw) : ''),
        ...(attached && { body: attached }),
        ...(artifacts.length > 0 && { artifacts })
      });
      openerToPartId.set(opener, String(part.id));
    }
    if (openerToPartId.size === 0) return { outcomeByPartId, deliveredTextIds };

    const deliveredByOpener = new Map<string, { id: string; body: string }>();
    for (const part of parts) {
      if (part?.type !== 'text' || part.role === 'user') continue;
      const text = typeof part.text === 'string' ? part.text : '';
      const newline = text.indexOf('\n');
      const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
      if (!openerToPartId.has(firstLine)) continue;
      deliveredByOpener.set(firstLine, {
        id: String(part.id),
        body: newline === -1 ? '' : text.slice(newline + 1).trim()
      });
    }
    for (const [opener, delivered] of deliveredByOpener) {
      deliveredTextIds.add(delivered.id);
      const outcome = outcomeByPartId.get(openerToPartId.get(opener)!)!;
      if (delivered.body) outcome.body = delivered.body;
    }
    return { outcomeByPartId, deliveredTextIds };
  }

  function buildApprovalLogs(parts: any[]): Array<{ id: string; type: string; tool?: string; callId?: string; toolId?: string; status?: string; level?: LogPartLevel; title: string; message?: string; time?: number; details?: ApprovalLogDetails }> {
    const { outcomeByPartId, deliveredTextIds } = collectRunOutcomes(parts);
    // The runtime records an outcome tool's delivered report as an assistant
    // text part as well, so `sessions show`, a resumed run and a sub-agent's
    // parent all still find the run's final output. The session view renders
    // that report on the tool row that produced it, so keeping the text part
    // too would print the whole report twice — once as the report, once as an
    // "Assistant response" the model never wrote.
    return parts.filter((part: any) => !deliveredTextIds.has(String(part?.id))).map((part: any) => {
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
      if (part?.type === 'corrections') {
        // Numbers only, no sentence: the row is worded in log-entry.tsx, which
        // has to phrase the same three counts for the context view anyway. A
        // title composed here would be a second copy to keep in agreement.
        return {
          id: String(part.id),
          type: 'corrections',
          status: 'completed',
          title: 'learnings applied',
          ...(typeof part.applied === 'number' && { applied: part.applied }),
          ...(typeof part.active === 'number' && { active: part.active }),
          ...(typeof part.cap === 'number' && { cap: part.cap }),
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
      if (part?.type === 'verify') {
        const attempt = typeof part.attempt === 'number' ? part.attempt : 0;
        const maxRedos = typeof part.maxRedos === 'number' ? part.maxRedos : 0;
        const critique = typeof part.critique === 'string' ? part.critique : undefined;
        const judge = typeof part.judge === 'string' ? part.judge : undefined;
        const title = part.verdict === 'pass'
          ? `Verification passed${attempt > 0 ? ` (after ${attempt} redo${attempt === 1 ? '' : 's'})` : ''}`
          : part.verdict === 'fail'
            ? `Verification failed (attempt ${attempt + 1} of ${maxRedos + 1})`
            : 'Verification judge error';
        const message = part.verdict === 'error'
          ? critique ?? 'Judge failed; output shipped unverified'
          : critique ?? (judge ? `Judged by ${judge}` : undefined);
        return {
          id: String(part.id),
          type: 'verify',
          status: part.verdict === 'pass' ? 'completed' : 'error',
          title,
          ...(message !== undefined && { message }),
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
        const runOutcome = outcomeByPartId.get(String(part.id));
        const built = isAwaitHuman ? buildAwaitHumanDetails(state) : buildToolDetails(state, part.tool);
        const details = runOutcome ? { ...(built ?? {}), runOutcome } : built;
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

  /** Untrusted tool-input `changes`: keep only entries with real content. */
  function normalizeApprovalChanges(value: unknown): ApprovalChange[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const changes = value.flatMap((entry): ApprovalChange[] => {
      const rec = valueAsRecord(entry);
      const content = typeof rec.content === 'string' ? repairEscapedText(rec.content) : '';
      if (!content.trim()) return [];
      const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : undefined;
      const displayContent = typeof rec.displayContent === 'string' && rec.displayContent.trim()
        ? repairEscapedText(rec.displayContent)
        : undefined;
      const optionId = typeof rec.optionId === 'string' && rec.optionId.trim() ? rec.optionId.trim() : undefined;
      return [{ ...(label && { label }), content, ...(displayContent && { displayContent }), ...(optionId && { optionId }) }];
    });
    return changes.length > 0 ? changes : undefined;
  }

  /**
   * Untrusted tool-input `options`: keep only entries with a real id and label,
   * drop duplicate ids (first wins), and require at least two survivors, since
   * a one-entry "menu" degrades to the plain approve flow.
   */
  function normalizeApprovalOptions(value: unknown): ApprovalOption[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const options = value.flatMap((entry): ApprovalOption[] => {
      const rec = valueAsRecord(entry);
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      const label = typeof rec.label === 'string' ? repairEscapedText(rec.label.trim()) : '';
      if (!id || !label || seen.has(id)) return [];
      seen.add(id);
      const description = typeof rec.description === 'string' && rec.description.trim()
        ? repairEscapedText(rec.description.trim())
        : undefined;
      return [{
        id,
        label,
        ...(description && { description }),
        ...(rec.recommended === true && { recommended: true })
      }];
    });
    return options.length >= 2 ? options : undefined;
  }

  /** Untrusted tool-input `reference`: string fields only, URL must be http(s). */
  function normalizeApprovalReference(value: unknown): ApprovalReference | undefined {
    const rec = valueAsRecord(value);
    const text = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? repairEscapedText(v.trim()) : undefined;
    const url = safeHttpUrl(rec.url);
    const label = text(rec.label);
    const author = text(rec.author);
    const title = text(rec.title);
    const excerpt = text(rec.excerpt);
    const reference: ApprovalReference = {
      ...(label && { label }),
      ...(author && { author }),
      ...(title && { title }),
      ...(url && { url }),
      ...(excerpt && { excerpt })
    };
    return Object.keys(reference).length > 0 ? reference : undefined;
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
    if (typeof input.prompt === 'string' && input.prompt) fields.prompt = repairEscapedText(input.prompt);
    if (typeof input.summary === 'string' && input.summary) fields.summary = repairEscapedText(input.summary);
    if (typeof input.context === 'string' && input.context) fields.context = repairEscapedText(input.context);
    if (typeof input.risk === 'string' && input.risk) fields.risk = repairEscapedText(input.risk);
    if (typeof input.draft === 'string' && input.draft) fields.draft = repairEscapedText(input.draft);
    const changes = normalizeApprovalChanges(input.changes);
    if (changes) fields.changes = changes;
    const reference = normalizeApprovalReference(input.reference);
    if (reference) fields.reference = reference;
    const options = normalizeApprovalOptions(input.options);
    if (options) fields.options = options;
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
    if (Array.isArray(resumePayload.artifactSnapshots)) {
      const snapshots = resumePayload.artifactSnapshots
        .map((s: unknown) => valueAsRecord(s))
        .filter((s) => typeof s.path === 'string' && /^[a-f0-9]{16}$/.test(String(s.hash)) && typeof s.ext === 'string')
        .map((s) => ({
          path: s.path as string,
          hash: s.hash as string,
          ext: s.ext as string,
          ...(typeof s.bytes === 'number' && { bytes: s.bytes })
        }));
      if (snapshots.length > 0) fields.artifactSnapshots = snapshots;
    }

    if (state?.status === 'completed') {
      const decisionStatus = typeof output.status === 'string' ? output.status : undefined;
      const decisionComment = typeof output.comment === 'string' ? output.comment : undefined;
      const decisionChoice = typeof output.choice === 'string' && output.choice ? output.choice : undefined;
      if (decisionChoice) fields.decisionChoice = decisionChoice;
      const reviewer = valueAsRecord(output.reviewer);
      const reviewerLabel = typeof reviewer.username === 'string'
        ? reviewer.username
        : typeof reviewer.name === 'string'
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

  /**
   * `tools__artifact_save` returns `{ success, path, group, url }` and is called
   * with a `title`. Surface that as a viewable tile instead of dumping the raw
   * (often huge) file content and JSON result into the log.
   */
  function savedArtifactFromState(state: any): ApprovalLogDetails['savedArtifact'] | undefined {
    const output = valueAsRecord(state?.output);
    const outputText = typeof state?.output === 'string'
      ? state.output
      : typeof output.output === 'string'
        ? output.output
        : undefined;
    if (!outputText) return undefined;
    let parsed: Record<string, unknown>;
    try {
      parsed = valueAsRecord(JSON.parse(outputText));
    } catch {
      return undefined;
    }
    if (parsed.success !== true) return undefined;
    const url = safeHttpUrl(parsed.url);
    const path = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    if (!url || !path) return undefined;
    const input = valueAsRecord(state?.input);
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined;
    const group = typeof parsed.group === 'string' && parsed.group ? parsed.group : undefined;
    return { url, path, ...(title ? { title } : {}), ...(group ? { group } : {}) };
  }

  /**
   * The child's own report, pulled off a completed `subagent__*` tool part so the
   * parent's row can show what the sub-agent delivered without a click-through to
   * the child session. Reads the shape composeSubagentResult writes: the verdict
   * and artifact list from `metadata`, the body from the output text with the
   * verdict line stripped (it becomes the row's headline instead of repeating).
   *
   * A child that never called an outcome tool still lands here: it has no
   * headline, and its prose becomes the body.
   */
  function subagentResultFromState(state: any, tool?: string): ApprovalLogDetails['subagentResult'] {
    if (!tool?.startsWith('subagent__')) return undefined;
    const output = valueAsRecord(state?.output);
    const metadata = valueAsRecord(output.metadata);
    const text = typeof output.output === 'string' ? output.output : undefined;
    if (text === undefined && Object.keys(metadata).length === 0) return undefined;

    const headline = typeof metadata.headline === 'string' ? metadata.headline : undefined;
    const incomplete = typeof metadata.incomplete === 'string' ? metadata.incomplete : undefined;
    const artifacts = Array.isArray(metadata.artifacts)
      ? metadata.artifacts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      : [];
    const body = text ? stripLeadingOutcomeLine(text, incomplete ?? headline ?? '') : '';

    if (!headline && !incomplete && artifacts.length === 0 && !body) return undefined;
    return {
      ...(headline && { headline }),
      ...(incomplete && { incomplete }),
      ...(artifacts.length > 0 && { artifacts }),
      ...(body && { body }),
    };
  }

  function buildToolDetails(state: any, tool?: string): ApprovalLogDetails | undefined {
    const fields: ApprovalLogDetails = {};
    const usage = valueAsRecord(valueAsRecord(state?.metadata).modelStepUsage);
    const inputTokens = usage.input;
    const outputTokens = usage.output;
    const cachedInputTokens = usage.cachedInput;
    if (
      typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0 &&
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0 &&
      typeof cachedInputTokens === 'number' && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0
    ) {
      const sharedCalls = typeof usage.sharedCalls === 'number' && Number.isFinite(usage.sharedCalls)
        ? Math.max(1, Math.floor(usage.sharedCalls))
        : undefined;
      fields.tokenUsage = {
        input: inputTokens,
        output: outputTokens,
        cachedInput: cachedInputTokens,
        ...(sharedCalls !== undefined && { sharedCalls }),
      };
    }

    if (state?.status === 'completed' && tool === 'tools__artifact_save') {
      const saved = savedArtifactFromState(state);
      // The tile is the whole story for a saved artifact; skip the input/output dump.
      if (saved) return { savedArtifact: saved };
    }

    // The injected intent phrase is the row's primary label; the input dump
    // shows the real args without it (an intent-only input renders no dump).
    const intent = extractToolIntent(state?.input);
    if (intent !== undefined) fields.intent = intent;
    const inputWithoutIntent = withoutToolIntent(state?.input);
    const inputIsEmpty = inputWithoutIntent !== null
      && typeof inputWithoutIntent === 'object'
      && Object.keys(inputWithoutIntent).length === 0
      && intent !== undefined;
    const input = inputIsEmpty ? undefined : formatApprovalLogValue(inputWithoutIntent);
    if (input !== undefined) fields.input = input;

    if (state?.status === 'running') {
      // Live tail of a call still in flight. Written by the runner on a throttle
      // and dropped the moment the call settles, so a finished row never carries
      // one (see persistToolState).
      const live = valueAsRecord(state?.metadata)[LIVE_OUTPUT_METADATA_KEY];
      if (typeof live === 'string' && live.trim()) fields.liveOutput = live;
    }

    if (state?.status === 'completed') {
      // A sub-agent's result is the child's whole report. Rendered as the raw
      // `{output, metadata}` JSON dump it was unreadable, so the reviewer had to
      // open the child's own session to learn what it did. Surface it structured
      // instead and skip the dump.
      const subagentResult = subagentResultFromState(state, tool);
      if (subagentResult) {
        fields.subagentResult = subagentResult;
      } else {
        const output = formatApprovalLogValue(state.output);
        if (output !== undefined) fields.output = output;
      }
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
    const errors = [...(session.errorHistory ?? []), ...(session.error ? [session.error] : [])];
    if (errors.length === 0) return logs;
    const sessionTime = typeof session.time?.updated === 'number' ? session.time.updated : undefined;
    return errors.reduce((entries, error, index) => {
      // Keep the original stable id for the first failure. Later attempts get
      // deterministic suffixes so every failure remains independently visible.
      const id = `session-error:${session.id}${index === 0 ? '' : `:${index + 1}`}`;
      if (entries.some((entry) => entry.id === id)) return entries;
      const message = error.message || error.code || 'Session failed';
      const lastLogTime = entries.reduce((max, entry) => Math.max(max, entry.time ?? 0), 0);
      const errorTime = typeof error.time === 'number' ? error.time : undefined;
      // Anchor the marker at the moment the failure was recorded. Older
      // sessions stored no error time and fall back to after existing logs.
      const time = errorTime ?? Math.max(lastLogTime, sessionTime ?? 0) + 1;
      return [
        ...entries,
        {
          id,
          type: 'session',
          status: 'error',
          title: 'Session failed',
          time,
          details: { errorMessage: message }
        }
      ];
    }, logs);
  }

  async function sessionHierarchySummaries(
    sessionManager: InstanceType<typeof SessionManager>,
    rootSession: SessionInfo,
    sessionId: string,
    sessionPath?: string
  ) {
    const descendants = await sessionManager.listDescendantSessions(sessionId, sessionPath);
    const summarize = ({ session }: { session: SessionInfo }) => ({
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
    });
    const childSessions = descendants
      .filter(({ session }) => session.parentSessionID === sessionId)
      .map(summarize);
    const evidence = await Promise.all(descendants.map(async ({ session, agentId }) => {
      try {
        const messages = await sessionManager.getSessionMessages(session.id, agentId);
        const parts = (await Promise.all(
          messages.map((message) => sessionManager.getMessageParts(session.id, agentId, message.id))
        )).flat() as Part[];
        return { session, parts };
      } catch (error) {
        // A damaged descendant must not make its Manager page unreadable. Its
        // terminal session status still participates in failure bubbling.
        logger.debug(`Failed to inspect descendant ${session.id}: ${(error as Error).message}`);
        return { session, parts: [] as Part[] };
      }
    }));
    return {
      childSessions,
      importantDescendants: buildImportantDescendants(rootSession, evidence),
      importantDescendantEvents: buildImportantDescendantEvents(rootSession, evidence),
      evidence,
    };
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
      mcp = await connectMCP(agent.config.mcpServers, debug ?? false, dirname(agentPath), runCwd);
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

  // The slice of a child's run result the walk-up needs. Structurally satisfied
  // both by a live runAgent result and by loadStoredSubagentResult's rebuild,
  // which is what lets the recovery path share the exact same walk-up code.
  interface CascadeChildResult {
    text?: string | undefined;
    complete?: { headline: string; details?: string; artifacts?: string[] } | undefined;
    incomplete?: { reason: string } | undefined;
    usage?: { totalTokens?: number | undefined } | undefined;
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
    childResult: CascadeChildResult
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
        output: (() => {
          // Same composer as the straight-through path (subagent.ts), so a child
          // resumed after a human cleared its gate hands the parent the same
          // shape. Rebuilding this pair by hand is what used to drop the child's
          // headline and artifacts on this path alone. `childResult.text` is
          // already composed by runAgent, so the composer sees a body it merely
          // re-splits rather than an opener it would double.
          const composed = composeSubagentResult({
            agent: childAgentName,
            outcome: {
              ...(childResult.complete && { complete: childResult.complete }),
              ...(childResult.incomplete && { incomplete: childResult.incomplete }),
            },
            text: childResult.text,
          });
          return {
            output: composed.output,
            metadata: {
              ...composed.metadata,
              ...(childResult.usage?.totalTokens && { tokensUsed: childResult.usage.totalTokens }),
            },
          };
        })(),
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

  // Mark this process as the one driving a parked ancestor chain. The orphan
  // sweep's only way to tell a healthy mid-cascade chain from a stranded one is
  // the parent's recorded owner being alive — but until the walk-up reaches a
  // parent, its owner still names whichever worker originally suspended it,
  // which may be several restarts dead while this cascade is perfectly healthy
  // (issue #199). Best-effort: a failed stamp only weakens that liveness
  // signal, it must not block the resume.
  async function claimCascadeChain(
    sessionManager: InstanceType<typeof SessionManager>,
    chain: Array<{ sessionId: string; agentId: string }>
  ): Promise<void> {
    await Promise.all(chain.map(({ sessionId, agentId }) =>
      sessionManager.updateSession(sessionId, agentId, { owner: currentProcessRef() } as any).catch(() => {})
    ));
  }

  // Walk a parked ancestor chain back up from a finished child: complete each
  // ancestor's subagent_wait bookmark with its child's real output, resume it,
  // and stop if any level re-suspends on a new gate (its gate re-surfaces at
  // the root on the next poll). `ancestors` is ordered root → … → parent-of-child.
  // Shared by the live approval cascade (resumeApprovalCascade) and the
  // storage-driven recovery path (finishCascadeFromStorage) so they can't drift.
  //
  // NOTE: an intermediate child's `report_incomplete` deliberately does NOT stop
  // the walk. It is the child's own verdict on its product outcome, not a
  // control-flow signal: in an ungated run the parent's `subagent__*` tool still
  // returns the child's text and the manager keeps going (see subagent.ts).
  // Returning early here instead left every ancestor durably `suspended` on a
  // bookmark pointing at a child that had already ended — a run nothing could
  // ever resume, absent from the approvals list, and mislabeled "resuming"
  // forever.
  async function walkUpCascadeChain(opts: {
    sessionManager: InstanceType<typeof SessionManager>;
    ancestors: Array<{ sessionId: string; agentId: string; agentName: string }>;
    childSessionId: string;
    childAgentName: string;
    childResult: CascadeChildResult;
    projectRoot: string;
    abortController: AbortController;
    startTime: number;
    debug?: boolean;
    maxSteps?: number;
  }): Promise<{ suspended: true } | { suspended: false; result: Awaited<ReturnType<typeof runAgent>> }> {
    const { sessionManager, ancestors, projectRoot, abortController, startTime, debug, maxSteps } = opts;
    let childSessionId = opts.childSessionId;
    let childAgentName = opts.childAgentName;
    let childResult = opts.childResult;
    let lastParentResult: Awaited<ReturnType<typeof runAgent>> | undefined;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const parent = ancestors[i];
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
        return { suspended: true };
      }
      childResult = parentResult;
      lastParentResult = parentResult;
      childSessionId = parent.sessionId;
      childAgentName = parent.agentName;
    }
    return { suspended: false, result: lastParentResult! };
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

    // This process now drives the whole chain; stamp every level so the orphan
    // sweep's owner-liveness probe points at a process that actually exists.
    await claimCascadeChain(sessionManager, chain);

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
    if (childResult.status === 'suspended') {
      return { handled: true, response: cascadeReparkedResponse(reqId, rootSessionId) };
    }

    // 3. Walk up: complete each ancestor's bookmark with the child's output,
    //    resume it, stopping if it re-suspends. The final response reports
    //    whatever the ROOT ended as (see walkUpCascadeChain for the
    //    report_incomplete semantics at each hop).
    const walked = await walkUpCascadeChain({
      sessionManager,
      ancestors: chain.slice(0, -1),
      childSessionId: leaf.sessionId,
      childAgentName: leaf.agentName,
      childResult,
      projectRoot,
      abortController,
      startTime,
      ...(debug !== undefined && { debug }),
      ...(maxSteps !== undefined && { maxSteps }),
    });
    if (walked.suspended) {
      return { handled: true, response: cascadeReparkedResponse(reqId, rootSessionId) };
    }

    const duration = Date.now() - startTime;
    return {
      handled: true,
      response: workerRunResponse(reqId, walked.result, duration, rootSessionId),
    };
  }

  // Finish a cascade whose driving worker died after the delegated child ended
  // but before the ancestors were resumed (issue #199). Everything the walk-up
  // needs survived: the child's final text and declared outcome, and each
  // ancestor's pending subagent_wait bookmark. Rebuild the child's result from
  // storage and run the normal walk-up. Nothing external re-executes — the
  // child already did its work — and each ancestor resumes its own remaining
  // steps exactly once, same as if the original worker had lived.
  //
  // Also accepts an ancestor already stamped CASCADE_ORPHANED by an older sweep
  // (the pre-recovery behavior): its bookmark is still pending, so the same
  // walk-up applies once the stale error is cleared.
  async function finishCascadeFromStorage(opts: {
    sessionManager: InstanceType<typeof SessionManager>;
    rootSessionId: string;
    projectRoot: string;
    abortController: AbortController;
    startTime: number;
    reqId: string;
    debug?: boolean;
    maxSteps?: number;
  }): Promise<any> {
    const { sessionManager, rootSessionId, projectRoot, abortController, startTime, reqId, debug, maxSteps } = opts;

    const recoverableStrand = (session: SessionInfo): boolean =>
      session.status === 'suspended' ||
      (session.status === 'error' && session.error?.code === CASCADE_ORPHANED_CODE);

    const initialRoot = await sessionManager.findSession(rootSessionId);
    if (!initialRoot) {
      return { id: reqId, success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${rootSessionId}` } };
    }
    const rootDirectory = await sessionManager.getSessionDirectory(rootSessionId, initialRoot.agentId);

    // The recoverable status is only a predicate, not a claim. Two daemons can
    // discover the same stranded root in the same sweep, so serialize the whole
    // read/complete/run transition on a durable lock shared by every process.
    return withOwnershipLock(join(rootDirectory, '.finish-cascade-claim'), async () => {
      const rootFound = await sessionManager.findSession(rootSessionId);
      if (!rootFound) {
        return { id: reqId, success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${rootSessionId}` } };
      }
      // Anything else means a live process already resumed it (or it ended):
      // finishing twice is the double-fire this whole path exists to avoid.
      if (!recoverableStrand(rootFound.session)) {
        return { id: reqId, success: false, error: { code: 'SESSION_NOT_SUSPENDED', message: `SESSION_NOT_SUSPENDED: ${rootFound.session.status}` } };
      }

      // Follow pending bookmarks down to the child that ended with a durable
      // result. A live human gate or a still-running descendant means the chain
      // is healthy and there is nothing to finish.
      const chain: Array<{ sessionId: string; agentId: string; agentName: string }> = [
        { sessionId: rootSessionId, agentId: rootFound.agentId, agentName: rootFound.session.agent.name },
      ];
      let cursorChildId = findPendingSubagentWaitChildId(await loadSessionPartsFlat(sessionManager, rootSessionId, rootFound.agentId));
      let ended: { sessionId: string; agentId: string; agentName: string } | undefined;
      for (let i = 0; i < MAX_CASCADE_DEPTH && cursorChildId; i++) {
        const f = await sessionManager.findSession(cursorChildId);
        if (!f) break;
        if (isFinishableStale(f.session)) {
          ended = { sessionId: cursorChildId, agentId: f.agentId, agentName: f.session.agent.name || f.agentId };
          break;
        }
        if (!recoverableStrand(f.session)) break;
        const parts = await loadSessionPartsFlat(sessionManager, cursorChildId, f.agentId);
        if (findPendingAwaitHumanPart(parts)) break;
        const next = findPendingSubagentWaitChildId(parts);
        if (!next) break;
        chain.push({ sessionId: cursorChildId, agentId: f.agentId, agentName: f.session.agent.name || f.agentId });
        cursorChildId = next;
      }
      if (!ended) {
        return { id: reqId, success: false, error: { code: 'CASCADE_NOT_FINISHABLE', message: `Session ${rootSessionId} is not parked on a delegated sub-agent that ended with a durable result` } };
      }

      // This process drives the chain now: stamp liveness, and clear any stale
      // CASCADE_ORPHANED verdict so the resumed levels report a clean run.
      await claimCascadeChain(sessionManager, chain);
      for (const level of chain) {
        const f = await sessionManager.findSession(level.sessionId);
        if (f?.session.error?.code === CASCADE_ORPHANED_CODE) {
          await sessionManager.updateSession(level.sessionId, level.agentId, { status: 'suspended', error: undefined } as any).catch(() => {});
        }
      }

      const stored = await loadStoredSubagentResult(sessionManager, ended.sessionId, ended.agentId);
      const walked = await walkUpCascadeChain({
        sessionManager,
        ancestors: chain,
        childSessionId: ended.sessionId,
        childAgentName: ended.agentName,
        childResult: stored,
        projectRoot,
        abortController,
        startTime,
        ...(debug !== undefined && { debug }),
        ...(maxSteps !== undefined && { maxSteps }),
      });
      if (walked.suspended) {
        return cascadeReparkedResponse(reqId, rootSessionId);
      }
      return workerRunResponse(reqId, walked.result, Date.now() - startTime, rootSessionId);
    }, {
      staleMs: 30_000,
      retryMs: 10,
      maxWaitMs: 35_000,
      label: `finish-cascade:${rootSessionId}`,
    });
  }

  async function getApprovalInfo(req: ExecuteRequest) {
    return withApprovalInfoCache(
      approvalInfoCacheKey(req),
      req.id,
      async () => getApprovalInfoUncached(req),
      req.sessionId ? () => approvalInfoChangeSignature(req.projectRoot, req.sessionId!) : undefined
    );
  }

  /**
   * Change probe backing the non-terminal approval-info cache: the max
   * directory mtime across the session's subtree (see
   * SessionManager.getSessionChangeSignature). Returns null when the session
   * can't be resolved so the caller never caches against a blind signature.
   */
  async function approvalInfoChangeSignature(projectRoot: string, sessionId: string): Promise<string | null> {
    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const found = await sessionManager.findSession(sessionId);
      if (!found) return null;
      return await sessionManager.getSessionChangeSignature(found.path);
    } catch (error) {
      logger.debug(`Approval-info change probe failed for ${sessionId}: ${(error as Error).message}`);
      return null;
    }
  }

  async function learningInfoForSession(session: SessionInfo): Promise<{ capture: boolean; apply: boolean } | undefined> {
    const agentPath = session.agent.filePath;
    if (!agentPath) return undefined;
    try {
      const agent = await parseAgent(agentPath);
      return agent.config.learning
        ? { capture: Boolean(agent.config.learning.capture), apply: agent.config.learning.apply }
        : undefined;
    } catch (error) {
      logger.debug(`Failed to read learning config for ${agentPath}: ${(error as Error).message}`);
      return undefined;
    }
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
      if (!found || !sessionBelongsToProject(found.session, req.projectRoot)) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
        };
      }

      const messages = await sessionManager.getSessionMessages(req.sessionId, found.agentId);
      // Usage/metadata only: skip media rehydration (no need to read cache files).
      const contextOverride = contextUsageFromSnapshot(await sessionManager.readContextSnapshot(req.sessionId, found.agentId, { rehydrateMedia: false }));
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
      const { childSessions, importantDescendants, importantDescendantEvents, evidence: descendantEvidence } = await sessionHierarchySummaries(
        sessionManager,
        found.session,
        req.sessionId,
        found.path
      );
      const timing = summarizeSessionTiming(found.session, [
        { session: found.session, parts: parts as Part[] },
        ...descendantEvidence,
      ]);
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

      // An ended session (error/completed) whose latest gate was resolved via a
      // resume can be manually rolled back to its suspended approval so a reviewer
      // can retry a resume that failed downstream. The gate keeps its original
      // resumePayload, which is what reopenSuspendedGate rebuilds the pending
      // state from. Surfaced as `reopenable` so the UI can offer a Retry action.
      const reopenable = (found.session.status === 'error' || found.session.status === 'completed')
        && approvalParts.some((part: any) =>
          (part?.state?.status === 'completed' || part?.state?.status === 'error') &&
          part?.state?.metadata?.resumePayload?.kind === 'await_human'
        );

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
      const learning = await learningInfoForSession(cascadeLeaf?.session ?? found.session);

      // Same stranded-cascade case the approvals list handles: this session is
      // durably suspended on a delegated child that has already ended, so it has no
      // gate of its own and none below. Without this the page renders a bare
      // "suspended" run with no hint that nothing will ever move it again.
      let orphanedCascadeFields: { errorCode: string; errorMessage: string } | undefined;
      if (!effectiveApprovalPart && found.session.status === 'suspended' && !found.session.error) {
        const childSessionId = findPendingSubagentWaitChildId(parts);
        const stale = childSessionId ? await findStaleCascadeChild(sessionManager, childSessionId) : null;
        if (stale) {
          orphanedCascadeFields = {
            errorCode: CASCADE_ORPHANED_CODE,
            errorMessage: describeStaleCascade(stale),
          };
        }
      }

      if (!effectiveApprovalPart) {
        return {
          id: req.id,
          success: true,
          approval: {
            sessionId: req.sessionId,
            sessionStatus: found.session.status,
            ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
            model: found.session.model,
            ...mockField(found.session),
            ...sessionErrorFields(found.session),
            ...(orphanedCascadeFields ?? {}),
            ...dismissedAtField(found.session),
            ...(reopenable && { reopenable }),
            agent: {
              id: found.session.agent.id,
              name: found.session.agent.name,
              ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
              ...(found.session.agent.description && { description: found.session.agent.description })
            },
            ...(learning && { learning }),
            ...viewOnlyFields,
            ...(additionalInstruction && { additionalInstruction }),
            ...(childSessions.length > 0 && { childSessions }),
            ...(importantDescendants.length > 0 && { importantDescendants }),
            ...(importantDescendantEvents.length > 0 && { importantDescendantEvents }),
            ...(tokenUsage && { tokenUsage }),
            timing,
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
            ...mockField(found.session),
            ...sessionErrorFields(found.session),
            ...dismissedAtField(found.session),
            ...(reopenable && { reopenable }),
            agent: {
              id: found.session.agent.id,
              name: found.session.agent.name,
              ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
              ...(found.session.agent.description && { description: found.session.agent.description })
            },
            ...(learning && { learning }),
            ...originAgentFields,
            ...viewOnlyFields,
            ...(additionalInstruction && { additionalInstruction }),
            ...(childSessions.length > 0 && { childSessions }),
            ...(importantDescendants.length > 0 && { importantDescendants }),
            ...(importantDescendantEvents.length > 0 && { importantDescendantEvents }),
            ...(tokenUsage && { tokenUsage }),
            timing,
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
      const payloadChanges = normalizeApprovalChanges(input.changes);
      const payloadReference = normalizeApprovalReference(input.reference);
      const payloadOptions = normalizeApprovalOptions(input.options);
      return {
        id: req.id,
        success: true,
        approval: {
          sessionId: req.sessionId,
          sessionStatus,
          ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
          model: found.session.model,
          ...mockField(found.session),
          ...sessionErrorFields(found.session),
          ...dismissedAtField(found.session),
          ...(reopenable && { reopenable }),
          agent: {
            id: found.session.agent.id,
            name: found.session.agent.name,
            ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
            ...(found.session.agent.description && { description: found.session.agent.description })
          },
          ...(learning && { learning }),
          ...originAgentFields,
          ...viewOnlyFields,
          ...(additionalInstruction && { additionalInstruction }),
          ...(typeof input.prompt === 'string' && { prompt: repairEscapedText(input.prompt) }),
          ...(typeof input.summary === 'string' && { summary: repairEscapedText(input.summary) }),
          ...(typeof input.draft === 'string' && { draft: repairEscapedText(input.draft) }),
          ...(payloadChanges && { changes: payloadChanges }),
          ...(payloadReference && { reference: payloadReference }),
          ...(payloadOptions && { options: payloadOptions }),
          ...(detailDraftUrl && { draftUrl: detailDraftUrl }),
          ...(detailArtifactUrl && { artifactUrl: detailArtifactUrl }),
          ...(typeof input.context === 'string' && { context: repairEscapedText(input.context) }),
          ...(typeof input.risk === 'string' && { risk: repairEscapedText(input.risk) }),
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
          ...(importantDescendants.length > 0 && { importantDescendants }),
          ...(importantDescendantEvents.length > 0 && { importantDescendantEvents }),
          ...(tokenUsage && { tokenUsage }),
          timing,
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
      if (!found || !sessionBelongsToProject(found.session, req.projectRoot)) {
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
          ...mockField(found.session),
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

  async function createPreparingSession(req: ExecuteRequest) {
    try {
      if (!req.sessionId || !req.agentId || !req.agentName || !req.model || !req.preparerOwner) {
        return {
          id: req.id,
          success: false,
          error: { code: 'PREPARING_SESSION_INVALID', message: 'Preparing session identity, model, and owner are required' },
        };
      }
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const sessionId = await sessionManager.createSession({
        id: req.sessionId,
        initialStatus: 'preparing',
        owner: req.preparerOwner,
        agent: {
          id: req.agentId,
          name: req.agentName,
          ...(req.agentDescription && { description: req.agentDescription }),
          isSubAgent: false,
        },
        model: req.model,
        version: packageVersion,
        config: {
          ...(req.sessionTimeout !== undefined && { timeout: req.sessionTimeout }),
          ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
        },
        project: { root: req.projectRoot, cwd: req.projectRoot },
        ...(req.trigger && { trigger: req.trigger }),
      });
      invalidateListCaches(req.projectRoot);
      return { id: req.id, success: true as const, sessionId };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'PREPARING_SESSION_CREATE_FAILED', message: (err as Error).message },
      };
    }
  }

  async function failPreparingSession(req: ExecuteRequest) {
    try {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing preparing session id' },
        };
      }
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const found = await sessionManager.findSession(req.sessionId);
      if (!found || found.session.status !== 'preparing') {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_NOT_PREPARING', message: `Session ${req.sessionId} is not preparing` },
        };
      }
      await sessionManager.setSessionError(req.sessionId, found.agentId, {
        code: req.errorCode || 'PREPARATION_FAILED',
        message: req.errorMessage || 'Session preparation failed',
      });
      invalidateListCaches(req.projectRoot);
      return { id: req.id, success: true as const, sessionId: req.sessionId };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'PREPARING_SESSION_FAIL_FAILED', message: (err as Error).message },
      };
    }
  }

  /**
   * The context stack for one session: what the model was actually sent.
   * Read-only, and built entirely from what the run already persisted (the
   * resolved system messages, the resolved instructions, the tool snapshot),
   * so it also answers for sessions that ran before this endpoint existed.
   */
  async function getSessionContext(req: ExecuteRequest) {
    try {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for context request' },
        };
      }

      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const found = await sessionManager.findSession(req.sessionId);
      if (!found || !sessionBelongsToProject(found.session, req.projectRoot)) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
        };
      }

      const [message, tools, messages] = await Promise.all([
        sessionManager.getPrimaryMessage(found.session.id, found.agentId),
        sessionManager.readToolsSnapshot(found.session.id, found.agentId),
        sessionManager.getSessionMessages(found.session.id, found.agentId),
      ]);

      // Mid-run file reads live in the tool parts, which are per message.
      const parts = (await Promise.all(
        messages.map((m) => sessionManager.getMessageParts(found.session.id, found.agentId, m.id))
      )).flat();

      return {
        id: req.id,
        success: true,
        context: buildSessionContextPayload({ session: found.session, message, tools, parts }),
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

  // Thin IPC shell over reconcileOrphanedSessions (see runner/resume.ts): recover
  // sessions a dead worker left stuck 'running' with no live process. Invoked when
  // this worker (re)spawns; cutoff is the ready time so only pre-existing orphans
  // are flipped to WORKER_INTERRUPTED, making the reopen path reachable.
  async function reconcileOrphanSessions(req: ExecuteRequest) {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const cutoff = typeof req.reconcileCutoff === 'number' ? req.reconcileCutoff : Date.now();
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff });
      if (reconciled.length > 0) invalidateListCaches(req.projectRoot);
      return { id: req.id, success: true as const, reconciled };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'RECONCILE_ERROR', message: (err as Error).message }
      };
    }
  }

  const approvalPartCache = new Map<string, {
    updatedAt: number;
    part: ToolPart | null;
  }>();
  const APPROVAL_INFO_CACHE_TTL_MS = 10_000;
  // Non-terminal (running/suspended) responses are reused while their change
  // signature is unchanged; this ceiling bounds staleness from inputs the
  // signature can't observe (e.g. the agent file's learning config).
  const APPROVAL_INFO_SIGNATURE_MAX_AGE_MS = 60_000;
  const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
  // While an execution is in flight the on-disk lists are actively changing
  // (session created, status flips, approvals suspend). The invalidate at
  // execute start can race the first session write: a scan landing in that gap
  // would otherwise cache a "nothing running" list for the whole run, so live
  // dashboards never see the session until it ends. Cap staleness hard here.
  const LIST_CACHE_ACTIVE_TTL_MS = 1_000;
  // A list that claims something is running is a promise the daemon can't keep
  // on its own: runs started by another process (a plain `agentuse run`) finish
  // without touching any of our invalidation hooks, so a full-TTL entry would
  // keep showing a live dot long after the run ended. Bound those the same way,
  // whoever started them — the backstop for announcements that never arrive
  // because the run was killed.
  const LIST_CACHE_LIVE_TTL_MS = 2_000;
  // How long a start poke keeps a project "hot". Invalidating on the poke alone
  // isn't enough: the poke races the session write, so the very next scan can
  // still see nothing running and cache that emptiness for the full TTL. This
  // is the out-of-process twin of activeExecuteRequests — for the daemon's own
  // runs that counter stays raised for the whole run; here we only get an edge,
  // so hold the short TTL for a window after it.
  const EXTERNAL_ACTIVITY_WINDOW_MS = 15_000;
  /** projectRoot -> timestamp until which external activity is assumed. */
  const externalActivityUntil = new Map<string, number>();
  type ApprovalInfoResponse = Awaited<ReturnType<typeof getApprovalInfoUncached>>;
  type ApprovalInfoCacheEntry = {
    expiresAt: number;
    response?: Omit<ApprovalInfoResponse, 'id'>;
    promise?: Promise<ApprovalInfoResponse>;
    /** Change signature the response was computed against (non-terminal sessions only). */
    signature?: string;
  };
  type ListResponse = { id: string; success: boolean; [key: string]: unknown };
  type ListCacheEntry<T extends ListResponse> = {
    expiresAt: number;
    response?: Omit<T, 'id'>;
    promise?: Promise<T>;
  };
  const approvalInfoResponseCache = new Map<string, ApprovalInfoCacheEntry>();
  const listResponseCache = new Map<string, ListCacheEntry<ListResponse>>();
  // These three hold whole responses -- an approval-info entry carries the
  // session's entire built transcript -- and their TTLs are lazy: an expired
  // entry is only dropped when that same key is read again. A dashboard that
  // browses many sessions would otherwise leave every one of them resident for
  // the worker's lifetime, so cap the entry count too. Sized for the live views
  // a daemon actually serves; older entries just re-read from storage.
  const MAX_CACHED_APPROVAL_INFO = 8;
  const MAX_CACHED_LISTS = 16;
  const MAX_CACHED_APPROVAL_PARTS = 256;

  /** Set an entry, evicting least-recently-set keys past `max`. */
  function boundedCacheSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
    // Re-insert so the most recently used entry sorts last for eviction.
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > max) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  // Execute requests currently in flight (covers the whole request, including
  // the pre-session-write setup window that activeExecutionControllers misses
  // for fresh runs). Drives the short list-cache TTL above.
  let activeExecuteRequests = 0;

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
      req.sessionsUpdatedAfter ?? '',
      req.includeSubagents ? 'subagents' : 'top',
      req.sessionsLimit ?? '',
      req.sessionsPerAgent ?? '',
      req.sessionsMock ?? ''
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
    loader: () => Promise<ApprovalInfoResponse>,
    getSignature?: () => Promise<string | null>
  ): Promise<ApprovalInfoResponse> {
    const now = Date.now();
    const cached = approvalInfoResponseCache.get(key);
    if (cached?.response && cached.expiresAt > now && !cached.signature) {
      return { ...cached.response, id: requestId } as ApprovalInfoResponse;
    }

    // Probe before any rebuild: a write that lands mid-rebuild bumps a
    // directory mtime past this signature, so the next poll re-reads instead
    // of reusing a torn snapshot.
    const signature = getSignature ? await getSignature() : null;
    if (
      cached?.response && cached.expiresAt > now &&
      cached.signature && signature !== null && signature === cached.signature
    ) {
      return { ...cached.response, id: requestId } as ApprovalInfoResponse;
    }
    if (cached?.promise) {
      const response = await cached.promise;
      return { ...response, id: requestId } as ApprovalInfoResponse;
    }

    const promise = loader();
    boundedCacheSet(
      approvalInfoResponseCache,
      key,
      { expiresAt: now + APPROVAL_INFO_CACHE_TTL_MS, promise },
      MAX_CACHED_APPROVAL_INFO
    );
    try {
      const response = await promise;
      const { id: _id, ...rest } = response;
      if (shouldCacheApprovalInfoResponse(response)) {
        boundedCacheSet(approvalInfoResponseCache, key, {
          expiresAt: Date.now() + APPROVAL_INFO_CACHE_TTL_MS,
          response: rest as Omit<ApprovalInfoResponse, 'id'>
        }, MAX_CACHED_APPROVAL_INFO);
      } else if (response.success && signature !== null) {
        // Running/suspended sessions: reuse this snapshot until the on-disk
        // state changes. The SSE loop polls at 500ms/10s; without this every
        // tick re-reads and re-serializes the whole transcript.
        boundedCacheSet(approvalInfoResponseCache, key, {
          expiresAt: Date.now() + APPROVAL_INFO_SIGNATURE_MAX_AGE_MS,
          response: rest as Omit<ApprovalInfoResponse, 'id'>,
          signature
        }, MAX_CACHED_APPROVAL_INFO);
      } else {
        approvalInfoResponseCache.delete(key);
      }
      return response;
    } catch (error) {
      approvalInfoResponseCache.delete(key);
      throw error;
    }
  }

  /** Is a project this cache key belongs to inside its post-poke activity window? */
  function externallyActive(cacheKey: string): boolean {
    if (externalActivityUntil.size === 0) return false;
    const now = Date.now();
    for (const [projectRoot, until] of externalActivityUntil) {
      if (until <= now) {
        externalActivityUntil.delete(projectRoot);
        continue;
      }
      if (cacheKey.includes(`\0${projectRoot}\0`)) return true;
    }
    return false;
  }

  /** Does this list payload assert that something is live right now? Mirrors the
   *  web client's isRunningStatus so the cache and the UI agree on "live". */
  function containsLiveRow(response: ListResponse): boolean {
    const rows = response.sessions;
    if (!Array.isArray(rows)) return false;
    return rows.some((row) => {
      if (typeof row !== 'object' || row === null) return false;
      const { status, subagentActive } = row as { status?: unknown; subagentActive?: unknown };
      return subagentActive === true
        || status === 'preparing' || status === 'running' || status === 'resuming' || status === 'continuing';
    });
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
    boundedCacheSet(
      listResponseCache,
      key,
      { expiresAt: now + LIST_CACHE_TTL_MS, promise } as ListCacheEntry<ListResponse>,
      MAX_CACHED_LISTS
    );
    try {
      const response = await promise;
      if (response.success) {
        const { id: _id, ...rest } = response;
        // While an execution is in flight, this scan may have raced a session
        // write; cap how long it can be served so live views track the run.
        const ttlMs = activeExecuteRequests > 0 || externallyActive(key)
          ? LIST_CACHE_ACTIVE_TTL_MS
          : containsLiveRow(response) ? LIST_CACHE_LIVE_TTL_MS : LIST_CACHE_TTL_MS;
        boundedCacheSet(listResponseCache, key, {
          expiresAt: Date.now() + ttlMs,
          response: rest as Omit<T, 'id'>
        } as ListCacheEntry<ListResponse>, MAX_CACHED_LISTS);
      } else {
        listResponseCache.delete(key);
      }
      return response;
    } catch (error) {
      listResponseCache.delete(key);
      throw error;
    }
  }

  // Several served projects can share one session store: storage is keyed by
  // git root, so multiple -C project dirs inside the same repository all land in
  // the same store. Attribute a session to a project only when its recorded
  // project.root matches the requesting project; records from older versions
  // without the field stay visible to every project (previous behavior).
  function sessionBelongsToProject(session: Pick<SessionInfo, 'project'> | { projectRoot?: string }, projectRoot: string): boolean {
    const recordedRoot = 'projectRoot' in session
      ? session.projectRoot
      : (session as Pick<SessionInfo, 'project'>).project?.root;
    if (!recordedRoot) return true;
    return resolve(recordedRoot) === resolve(projectRoot);
  }

  async function listAllApprovals(req: ExecuteRequest) {
    return withListCache(listCacheKey(req, 'approvals'), req.id, async () => {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const approvalGeneration = await sessionManager.getApprovalIndexGeneration();
      const projectionKey = approvalProjectionKey(req.projectRoot);
      let projection: ApprovalProjectionIndex | null = null;
      try {
        projection = await readJSON<ApprovalProjectionIndex>(projectionKey);
      } catch (error) {
        if (!(error instanceof CorruptStorageError)) throw error;
        logger.warn(`Rebuilding corrupt approval index: ${error.message}`);
      }
      if (projection && projection.approvalGeneration === approvalGeneration && Array.isArray(projection.approvals)) {
        return {
          id: req.id,
          success: true as const,
          approvals: typeof req.approvalCreatedAfter === 'number'
            ? projection.approvals.filter((approval) => (approval.createdAt ?? 0) >= req.approvalCreatedAfter!)
            : projection.approvals,
        };
      }

      const indexedSessions = await sessionManager.listSessionSummaries({ includeSubagents: true });
      const indexedTopLevel = indexedSessions.filter((session) =>
        !session.parentSessionId && sessionBelongsToProject(session, req.projectRoot)
      );
      const currentSessionIds = new Set(indexedTopLevel.map((session) => session.sessionId));
      const indexedById = new Map(indexedSessions.map((session) => [session.sessionId, session]));
      // Approval rows are owned by the root manager, but the durable gate lives
      // on the delegated leaf. A reviewer comment can resume and re-gate that
      // leaf without changing the root's timestamp, so root.updatedAt alone is
      // not a sufficient incremental-projection revision. Fold every
      // approval-relevant descendant's timestamp into its root instead. The
      // compact index makes this O(session count * cascade depth) without
      // reading any message or part trees.
      const approvalSourceUpdatedAt = new Map<string, number>();
      for (const session of indexedSessions) {
        if (session.approvalRelevant !== true) continue;
        let root = session;
        const seen = new Set<string>([session.sessionId]);
        while (root.parentSessionId) {
          if (seen.has(root.parentSessionId)) break;
          seen.add(root.parentSessionId);
          const parent = indexedById.get(root.parentSessionId);
          if (!parent) break;
          root = parent;
        }
        if (!currentSessionIds.has(root.sessionId)) continue;
        approvalSourceUpdatedAt.set(
          root.sessionId,
          Math.max(approvalSourceUpdatedAt.get(root.sessionId) ?? 0, session.updatedAt)
        );
      }
      const priorApprovals = projection && Array.isArray(projection.approvals)
        ? projection.approvals.filter((approval) => currentSessionIds.has(approval.sessionId))
        : [];
      const priorSourceUpdatedAt = projection?.version === 2 && projection.sourceUpdatedAt
        ? projection.sourceUpdatedAt
        : {};
      const incremental = projection !== null && Array.isArray(projection.approvals);
      const summariesToRefresh = incremental
        ? indexedTopLevel.filter((session) =>
            approvalSourceUpdatedAt.has(session.sessionId) &&
            priorSourceUpdatedAt[session.sessionId] !== approvalSourceUpdatedAt.get(session.sessionId)
          )
        : indexedTopLevel;
      const refreshIds = new Set(summariesToRefresh.map((session) => session.sessionId));
      const approvals: ApprovalSummary[] = incremental
        ? priorApprovals.filter((approval) => !refreshIds.has(approval.sessionId))
        : [];
      const sourceUpdatedAt: Record<string, number> = incremental
        ? Object.fromEntries(Object.entries(priorSourceUpdatedAt).filter(([sessionId]) => currentSessionIds.has(sessionId)))
        : {};
      const sessionBatchSize = 16;

      const summarizeApproval = async (
        { session, agentId }: { session: SessionInfo; agentId: string }
      ): Promise<ApprovalSummary | null> => {
        if (!sessionBelongsToProject(session, req.projectRoot)) {
          return null;
        }
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
          boundedCacheSet(approvalPartCache, cacheKey, { updatedAt, part: approvalPart }, MAX_CACHED_APPROVAL_PARTS);
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
            } else {
              // The bookmark points at a child that ended (or is itself stuck) without
              // its ancestors ever being resumed. There is no gate left to act on, but
              // the root is still durably `suspended`, so dropping it here made it
              // invisible everywhere: absent from every approvals bucket, and rendered
              // "resuming" on home forever. Surface it as an errored approval instead,
              // naming the child that broke the chain.
              const stale = await findStaleCascadeChild(sessionManager, childId);
              if (stale) {
                const createdAt = session.time.created;
                return {
                  sessionId: session.id,
                  agentId,
                  agentName: session.agent.name || session.agent.id,
                  ...(session.agent.description && { agentDescription: session.agent.description }),
                  ...(session.agent.filePath && { agentFilePath: session.agent.filePath }),
                  status: 'errored' as const,
                  sessionStatus: session.status,
                  createdAt,
                  errorCode: CASCADE_ORPHANED_CODE,
                  errorMessage: describeStaleCascade(stale),
                  ...(session.channels && { channels: session.channels }),
                };
              }
            }
          }
        }
        if (!approvalPart) return null;

        const state = approvalPart.state;
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
          ...(normalizeApprovalOptions(input.options) && { hasOptions: true }),
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

      // A stale projection used to trigger listAllSessions(), reading every
      // historical session and regularly exceeding the serve worker's 30s RPC
      // deadline after worker recycling. The compact session index already
      // records exactly which roots have participated in an approval lifecycle.
      // Preserve legacy rows from the previous projection and re-read only
      // indexed approval roots whose timestamp changed. A missing/corrupt
      // projection still takes the conservative full-history bootstrap path.
      for (let i = 0; i < summariesToRefresh.length; i += sessionBatchSize) {
        const summaryBatch = summariesToRefresh.slice(i, i + sessionBatchSize);
        const batch = (await Promise.all(summaryBatch.map((summary) =>
          sessionManager.findSession(summary.sessionId)
        ))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        const summaries = await Promise.all(batch.map(summarizeApproval));
        approvals.push(...summaries.filter((approval): approval is ApprovalSummary => approval !== null));
        for (const summary of summaryBatch) {
          sourceUpdatedAt[summary.sessionId] = approvalSourceUpdatedAt.get(summary.sessionId) ?? summary.updatedAt;
        }
      }

      await writeJSON(projectionKey, {
        version: 2,
        approvalGeneration,
        approvals,
        sourceUpdatedAt,
      } satisfies ApprovalProjectionIndex);

      return {
        id: req.id,
        success: true as const,
        approvals: typeof req.approvalCreatedAfter === 'number'
          ? approvals.filter((approval) => (approval.createdAt ?? 0) >= req.approvalCreatedAfter!)
          : approvals,
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
      const sessions = await sessionManager.listSessionSummaries({
        ...(typeof req.sessionsUpdatedAfter === 'number' && { updatedAfter: req.sessionsUpdatedAfter }),
        includeSubagents: req.includeSubagents ?? false,
        // A time window bounds history, not work still in progress. Otherwise a
        // stalled long-running session disappears from Home at the boundary.
        includeLiveBeforeUpdatedAfter: true,
      });

      // Top-level runs by default; approval-filtered session views opt into
      // subagents so approval history links can land on the exact run.
      let summaries = sessions
        .filter((session) => sessionBelongsToProject(session, req.projectRoot))
        .filter((session) => req.sessionsMock === 'include' || (req.sessionsMock === 'only' ? session.mock === true : session.mock !== true))
        .map((session) => ({
          sessionId: session.sessionId,
          ...(session.parentSessionId && { parentSessionId: session.parentSessionId }),
          agent: {
            id: session.agent.id,
            name: session.agent.name,
            ...(session.agent.description && { description: session.agent.description }),
            ...(session.agent.filePath && { filePath: session.agent.filePath }),
          },
          status: session.status,
          trigger: session.trigger ?? 'manual',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...sessionErrorFields(session),
          ...dismissedAtField(session),
          ...mockField(session),
          ...(session.subagentActive && { subagentActive: true }),
        }))
        .sort((a, b) =>
          ((a.status === 'preparing' || a.status === 'running' || a.subagentActive) ? 0 : 1)
          - ((b.status === 'preparing' || b.status === 'running' || b.subagentActive) ? 0 : 1)
          || b.updatedAt - a.updatedAt
          || b.createdAt - a.createdAt
        );

      if (typeof req.sessionsPerAgent === 'number' && req.sessionsPerAgent > 0) {
        const counts = new Map<string, number>();
        summaries = summaries.filter((session) => {
          const key = session.agent.filePath ?? session.agent.id;
          const count = counts.get(key) ?? 0;
          if (count >= req.sessionsPerAgent!) return false;
          counts.set(key, count + 1);
          return true;
        });
      }
      if (typeof req.sessionsLimit === 'number' && req.sessionsLimit > 0) {
        summaries = summaries.slice(0, req.sessionsLimit);
      }

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

  async function getSessionFinalResponses(req: ExecuteRequest) {
    try {
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const refs = (req.sessionRefs ?? []).slice(0, 100);
      const responses: Record<string, string> = {};

      // Bound concurrent filesystem walks: feed pages are normally 50 rows,
      // and reading them all at once can overwhelm slower networked volumes.
      const batchSize = 10;
      for (let index = 0; index < refs.length; index += batchSize) {
        const batch = refs.slice(index, index + batchSize);
        const values = await Promise.all(batch.map(async (ref) => ({
          sessionId: ref.sessionId,
          text: await sessionManager.getLastAssistantText(ref.sessionId, ref.agentId),
        })));
        for (const value of values) {
          if (value.text !== undefined) responses[value.sessionId] = value.text;
        }
      }

      return { id: req.id, success: true as const, responses };
    } catch (err) {
      return {
        id: req.id,
        success: false as const,
        error: { code: 'SESSION_FINAL_RESPONSES_ERROR', message: (err as Error).message }
      };
    }
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

    activeExecuteRequests++;
    try {
      invalidateListCaches(req.projectRoot);
      let agentPath = req.agentPath ? resolve(req.projectRoot, req.agentPath) : '';
      const inMemoryAgent = req.type === 'execute' && typeof req.agentContent === 'string';
      if (req.type === 'execute' && !inMemoryAgent && (!req.agentPath || !existsSync(agentPath))) {
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
      if (req.type === 'finish-cascade') {
        // Recovery for a chain stranded between a child ending and its parent's
        // bookmark completing (issue #199): finish the walk-up from storage.
        if (!req.sessionId) {
          return {
            id: req.id,
            success: false,
            error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for finish-cascade request' },
          };
        }
        return await finishCascadeFromStorage({
          sessionManager,
          rootSessionId: req.sessionId,
          projectRoot: req.projectRoot,
          abortController,
          startTime,
          reqId: req.id,
          ...(req.debug !== undefined && { debug: req.debug }),
          ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
        });
      }
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
        if (found.session.status === 'preparing' || found.session.status === 'running') {
          return {
            id: req.id,
            success: false,
            error: {
              code: found.session.status === 'preparing' ? 'SESSION_PREPARING' : 'SESSION_RUNNING',
              message: `Session ${req.sessionId} is already ${found.session.status}`,
            },
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

      const agent = inMemoryAgent
        ? parseAgentContent(req.agentContent!, req.agentName ?? 'in-memory-agent')
        : await parseAgent(agentPath);

      const envValidation = validateAgentEnvVars(agent.config);
      if (!envValidation.valid) {
        return restoreResumeAndReturn({
          id: req.id,
          success: false,
          error: { code: 'ENV_MISSING', message: formatEnvValidationError(envValidation) },
        });
      }

      let runModelOverride: RunModelOverride | undefined;
      if (req.model) {
        const resolved = resolveModelString(req.model);
        runModelOverride = { requested: req.model, resolved };
        applyRunModelOverride(agent.config, runModelOverride);
      }

      const mcpBasePath = inMemoryAgent ? undefined : dirname(agentPath);
      mcp = await connectMCP(agent.config.mcpServers, req.debug ?? false, mcpBasePath, runCwd);

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
        ...(runModelOverride && { subagentModelOverride: runModelOverride }),
        ...(!inMemoryAgent && { agentFilePath: agentPath }),
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
        ...(req.type === 'execute' && req.newSessionId && { newSessionId: req.newSessionId }),
        ...(req.type === 'execute' && req.preparedSession && { preparedSession: true })
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
          inMemoryAgent ? undefined : agentPath,
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

        // Opt-in automatic observation runs once inside runAgent's post-run
        // lifecycle. Deliberate reviewer learning is saved separately when
        // Learn is selected, so nothing extra is needed here.

        return workerRunResponse(req.id, result, duration);
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
          error: { code: 'EXECUTION_ERROR', message: toErrorMessage(err) },
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
      activeExecuteRequests--;
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
        message: req.reason || 'Session stopped by user',
        ...(req.dismissEnded === true && { dismissEnded: true })
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

  async function reopenGate(req: ExecuteRequest) {
    try {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for reopen request' },
        };
      }
      await initStorage(req.projectRoot);
      const sessionManager = new SessionManager();
      const result = await reopenSuspendedGate({ sessionManager, sessionId: req.sessionId });
      if (!result.ok) {
        return { id: req.id, success: false, error: { code: result.code, message: result.message } };
      }
      invalidateListCaches(req.projectRoot);
      return { id: req.id, success: true, agentId: result.agentId };
    } catch (err) {
      return {
        id: req.id,
        success: false,
        error: { code: 'REOPEN_GATE_ERROR', message: (err as Error).message },
      };
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
  /**
   * Run requests (execute/resume/continue-session) currently executing here.
   * Counted around the whole request rather than read off
   * `activeExecutionControllers`, which only fills in once a session row exists
   * and so misses the setup window at the front of every run.
   */
  let inFlightRuns = 0;
  /**
   * Async non-run RPCs still executing. Some are reads, but several mutate
   * durable state (expiration, orphan reconciliation, stop, gate reopen), so a
   * release must drain this entire class before it acknowledges or exits.
   */
  let inFlightOperations = 0;
  /**
   * Set by a `release` request: serve is going down but this worker still has
   * work, so it has been cut loose to finish on its own instead of being killed
   * mid-run. A released worker deliberately outlives its parent.
   */
  let released = false;
  let pendingReleaseRequest: ExecuteRequest | undefined;
  let releaseAcknowledged = false;
  let releaseBackstopTimer: NodeJS.Timeout | undefined;
  /** An exit that arrived mid-work and was deferred until every request drains. */
  let pendingExitCode: number | null = null;
  /** Project roots seen on run requests. A worker only ever serves one. */
  const inFlightProjectRoots = new Set<string>();
  /** Runs this worker aborted because the user stopped them after release. */
  const stoppedWhileReleased = new Set<string>();
  let releasedStopWatch: NodeJS.Timeout | undefined;
  /**
   * Longest timeout any in-flight run was given, so the release backstop below
   * can never cut a legitimately slow run short. Unknown means the daemon's own
   * ceiling for a run request, which is the most a run can be waited on anyway.
   */
  let maxRunTimeoutSeconds = 0;
  const UNKNOWN_RUN_TIMEOUT_SECONDS = 24 * 60 * 60;
  /** Grace past a run's own deadline before we call it hung and leave. */
  const RELEASE_BACKSTOP_GRACE_SECONDS = 600;
  /** Hard cap on how long a released worker may live, overriding the above. */
  const releaseBackstopOverride = Number(process.env.AGENTUSE_RELEASE_BACKSTOP_SECONDS);

  /**
   * Once released, watch storage for a stop the user asked for.
   *
   * Stopping a run is otherwise purely in-process: serve forwards it to the
   * worker holding the AbortController. A released worker is no longer the one
   * serve talks to, so its runs would take a stop that reads as successful,
   * keep executing anyway, and then overwrite the stopped status with their own
   * result -- the user watches it un-stop itself and the side effects land.
   * Polling closes that window for the one case that has it, without putting a
   * storage read in every run's step loop.
   */
  const watchForStopWhileReleased = () => {
    if (releasedStopWatch) return;
    releasedStopWatch = setInterval(() => {
      void (async () => {
        if (activeExecutionControllers.size === 0) return;
        for (const projectRoot of inFlightProjectRoots) {
          try {
            await initStorage(projectRoot);
            const sessionManager = new SessionManager();
            for (const [sessionId, controller] of activeExecutionControllers) {
              if (activeStoppedSessions.has(sessionId)) continue;
              const found = await sessionManager.findSession(sessionId);
              if (found?.session.error?.code !== 'USER_STOPPED') continue;
              activeStoppedSessions.add(sessionId);
              stoppedWhileReleased.add(sessionId);
              controller.abort();
            }
          } catch {
            // Storage hiccup -- try again on the next tick.
          }
        }
      })();
    }, 5_000);
    releasedStopWatch.unref?.();
  };

  /**
   * Restore the stopped verdict on a run we aborted after release.
   *
   * A local stop survives because the process that wrote USER_STOPPED is the
   * same one that then finishes the run, so its own terminal write stands down.
   * Ours was written by a different process, so this worker still believes the
   * session is running and stamps the abort as a TIMEOUT over the top -- the
   * user stops a run, watches it report stopped, then watches it report a
   * timeout instead. stopSessionTree will not correct it (it only touches
   * running/suspended sessions), so write the verdict back directly, strictly
   * after the run has made its last write.
   */
  const restampStopsAfterRelease = async () => {
    if (stoppedWhileReleased.size === 0) return;
    for (const projectRoot of inFlightProjectRoots) {
      try {
        await initStorage(projectRoot);
        const sessionManager = new SessionManager();
        for (const sessionId of [...stoppedWhileReleased]) {
          const found = await sessionManager.findSession(sessionId);
          if (!found) continue;
          if (found.session.error?.code !== 'USER_STOPPED') {
            await sessionManager.updateSession(sessionId, found.agentId, {
              status: 'error',
              error: { code: 'USER_STOPPED', message: 'Session stopped by user', time: Date.now() },
            } as any);
          }
          stoppedWhileReleased.delete(sessionId);
        }
      } catch {
        // Leave it recorded; the next run to settle tries again.
      }
    }
  };

  const exitWorker = (code = 0, options: { force?: boolean } = {}) => {
    if (workerExiting) return;
    // Work in flight is never abandoned voluntarily. Ctrl-C and supervisor
    // tree-kills (pm2's default, systemd's control-group default) are delivered
    // to this process directly and land here mid-request. Runs and state-changing
    // maintenance RPCs both need to reach a durable terminal write before exit.
    // `force` is reserved for the released-run backstop / dead-parent watchdog.
    if ((inFlightRuns > 0 || inFlightOperations > 0) && !options.force) {
      pendingExitCode = code;
      return;
    }
    workerExiting = true;
    if (parentWatchTimer) clearInterval(parentWatchTimer);
    if (releasedStopWatch) clearInterval(releasedStopWatch);
    if (releaseBackstopTimer) clearTimeout(releaseBackstopTimer);
    rl.close();
    process.exit(code);
  };

  /** Settle a run and take any release/exit that was deferred while it ran. */
  const runFinished = () => {
    inFlightRuns = Math.max(0, inFlightRuns - 1);
    if (released) return finishReleaseIfDrained();
    if (inFlightRuns === 0 && inFlightOperations === 0 && pendingExitCode !== null) {
      exitWorker(pendingExitCode);
    }
  };

  // A released worker outlives serve, so its stdout pipe can close underneath
  // it. Losing the reply is fine -- the run it describes is already durable in
  // storage, and serve re-reads state from there -- but an unhandled EPIPE
  // would take the process down mid-run, which is not.
  /** Diagnostics must never take the process down; both pipes can be dead. */
  const writeStderr = (line: string) => {
    try {
      process.stderr.write(line);
    } catch {
      // Released worker with no parent left to read it.
    }
  };
  process.stderr.on('error', () => {/* parent is gone; nothing to report to */});
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
    writeStderr(`[worker] stdout error: ${err?.message}\n`);
  });

  /** Write one IPC response, tolerating a parent that is no longer listening.
   *  Every reply to a request carries this worker's RSS: serve decides on each
   *  settled request whether the process has banked enough memory to be worth
   *  retiring (see recycleIfBloated), and a run reply alone is too rare a
   *  heartbeat -- the memory is banked precisely when the worker goes idle.
   *  Unsolicited messages (the ready signal) are left as-is; nothing settles. */
  const reply = (response: unknown) => {
    try {
      const isRequestReply = typeof response === 'object' && response !== null && 'id' in response;
      const payload = isRequestReply
        ? { ...(response as Record<string, unknown>), workerRssBytes: process.memoryUsage.rss() }
        : response;
      console.log(JSON.stringify(payload));
    } catch {
      // Released worker with nowhere to report; storage already has the result.
    }
  };

  const startReleasedRunProtection = () => {
    if (inFlightRuns === 0) return;
    watchForStopWhileReleased();
    if (releaseBackstopTimer) return;
    // Runs are bounded by their own timeout. Outliving it by this margin means
    // something downstream of abort is wedged and the process would otherwise
    // stay resident forever. This timer starts only after non-run RPCs drain.
    const backstopSeconds = Number.isFinite(releaseBackstopOverride) && releaseBackstopOverride > 0
      ? releaseBackstopOverride
      : maxRunTimeoutSeconds + RELEASE_BACKSTOP_GRACE_SECONDS;
    releaseBackstopTimer = setTimeout(() => {
      writeStderr(`[worker] released run outlived its ${backstopSeconds}s deadline; exiting\n`);
      exitWorker(0, { force: true });
    }, backstopSeconds * 1000);
    releaseBackstopTimer.unref?.();
  };

  /** Acknowledge release only once every non-run RPC that preceded it is done. */
  function finishReleaseIfDrained(): void {
    if (!released || inFlightOperations > 0) return;
    if (!releaseAcknowledged) {
      releaseAcknowledged = true;
      reply({
        id: pendingReleaseRequest?.id ?? 'release',
        success: true,
        inFlightRuns,
        inFlightOperations,
      });
    }
    if (inFlightRuns === 0) {
      exitWorker(0);
      return;
    }
    startReleasedRunProtection();
  }

  const operationFinished = () => {
    inFlightOperations = Math.max(0, inFlightOperations - 1);
    if (released) {
      finishReleaseIfDrained();
      return;
    }
    if (inFlightRuns === 0 && inFlightOperations === 0 && pendingExitCode !== null) {
      exitWorker(pendingExitCode);
    }
  };

  /** Dispatch an async non-run RPC under the worker drain barrier. */
  const dispatchOperation = (request: ExecuteRequest, operation: () => Promise<unknown>) => {
    inFlightOperations += 1;
    void Promise.resolve()
      .then(operation)
      .then(
        (response) => reply(response),
        (error) => reply({
          id: request.id,
          success: false,
          error: { code: 'WORKER_ERROR', message: toErrorMessage(error) },
        })
      )
      .finally(operationFinished);
  };

  // Reap a worker whose serve died without releasing it (a crash, a SIGKILL).
  // `release` clears this timer, which is what lets a released worker outlive
  // its parent on purpose.
  let orphanTicks = 0;
  parentWatchTimer = setInterval(() => {
    const orphaned = parentPid === 1 || process.ppid !== parentPid || process.ppid === 1;
    if (!orphaned) {
      orphanTicks = 0;
      return;
    }
    orphanTicks += 1;
    // Idle: nothing to protect, and a stray worker helps nobody.
    if (inFlightRuns === 0 && inFlightOperations === 0) return exitWorker(0, { force: true });
    // State-changing maintenance work is normally short and has no safe replay
    // boundary. Let it reach its durable write even after an unclean parent
    // death; the release/reconcile paths reap the process once it drains.
    if (inFlightOperations > 0) return;
    // Mid-run, allow a few ticks first. A clean shutdown writes the release
    // line and exits, so the parent can be gone a moment before that line is
    // read -- and reaping a run we were about to be released to finish is
    // exactly the bug this whole path exists to prevent.
    if (orphanTicks >= 3) exitWorker(0, { force: true });
  }, 1_000);
  parentWatchTimer.unref?.();
  process.stdin.on('end', () => exitWorker(0));
  process.stdin.on('close', () => exitWorker(0));
  // `on`, not `once`: a released worker must keep ignoring repeat signals from a
  // supervisor that tree-kills. With `once` the second SIGTERM falls through to
  // the default action and kills the run anyway.
  process.on('SIGTERM', () => exitWorker(0));
  process.on('SIGINT', () => exitWorker(130));

  // Signal ready
  reply({ type: 'ready' });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line) as ExecuteRequest;
      if (released) {
        reply({
          id: request.id,
          success: false,
          error: { code: 'WORKER_RELEASED', message: 'Worker is draining and no longer accepts requests' },
        });
        continue;
      }
      if (request.type === 'approval-info') {
        dispatchOperation(request, () => getApprovalInfo(request));
      } else if (request.type === 'session-status') {
        dispatchOperation(request, () => getSessionStatusInfo(request));
      } else if (request.type === 'create-preparing-session') {
        dispatchOperation(request, () => createPreparingSession(request));
      } else if (request.type === 'fail-preparing-session') {
        dispatchOperation(request, () => failPreparingSession(request));
      } else if (request.type === 'session-context') {
        dispatchOperation(request, () => getSessionContext(request));
      } else if (request.type === 'sweep-expired') {
        dispatchOperation(request, () => sweepExpiredApprovals(request));
      } else if (request.type === 'reconcile-orphans') {
        dispatchOperation(request, () => reconcileOrphanSessions(request));
      } else if (request.type === 'list-approvals') {
        dispatchOperation(request, () => listAllApprovals(request));
      } else if (request.type === 'invalidate-lists') {
        // A run this worker didn't start just changed state (see the runner's
        // started/finished pokes in runner/announce.ts). Drop the cached lists
        // so the next dashboard read reflects it instead of waiting out the TTL.
        // A start poke also opens an activity window, because it races the
        // session write and the refill right after it can still see nothing.
        if (request.externalActivity) {
          externalActivityUntil.set(request.projectRoot, Date.now() + EXTERNAL_ACTIVITY_WINDOW_MS);
        }
        invalidateListCaches(request.projectRoot);
        reply({ id: request.id, success: true });
      } else if (request.type === 'list-sessions') {
        dispatchOperation(request, () => listSessions(request));
      } else if (request.type === 'session-final-responses') {
        dispatchOperation(request, () => getSessionFinalResponses(request));
      } else if (request.type === 'stop-session') {
        dispatchOperation(request, () => stopSession(request));
      } else if (request.type === 'reopen-gate') {
        dispatchOperation(request, () => reopenGate(request));
      } else if (request.type === 'release') {
        // Cut the parent-death tethers immediately, but do not acknowledge or
        // exit until every earlier non-run RPC has drained. The for-await loop
        // starts each operation before it can consume this line, so this is a
        // strict barrier for stop/reopen/reconcile and similar storage writes.
        released = true;
        pendingReleaseRequest = request;
        if (parentWatchTimer) {
          clearInterval(parentWatchTimer);
          parentWatchTimer = undefined;
        }
        finishReleaseIfDrained();
      } else if (request.type === 'execute' || request.type === 'resume' || request.type === 'continue-session' || request.type === 'finish-cascade') {
        // Don't await - handle requests concurrently
        // Each request runs in parallel, response sent when complete
        inFlightRuns += 1;
        inFlightProjectRoots.add(request.projectRoot);
        maxRunTimeoutSeconds = Math.max(maxRunTimeoutSeconds, request.timeout ?? UNKNOWN_RUN_TIMEOUT_SECONDS);
        executeAgent(request).then(async (response) => {
          // A run's peak heap is largely banked for good: a worker that has run
          // an agent settles two to three times above a fresh one and stays
          // there for the daemon's lifetime. reply() reports the RSS so serve
          // can retire this process once it is idle, rather than carrying the
          // high-water mark of every run it ever handled.
          reply(response);
          // Before runFinished, which may exit the process.
          await restampStopsAfterRelease();
          runFinished();
        }, (err) => {
          // executeAgent resolves its own errors, so this is a defect rather
          // than a run failure -- but it must still settle the count, or a
          // released worker would never reach its exit.
          reply({ id: request.id, success: false, error: { code: 'WORKER_ERROR', message: (err as Error).message } });
          runFinished();
        });
      } else {
        reply({
          id: (request as any).id || 'unknown',
          success: false,
          error: { code: 'UNKNOWN_REQUEST', message: 'Unknown request type' },
        });
      }
    } catch (err) {
      reply({
        id: 'unknown',
        success: false,
        error: { code: 'PARSE_ERROR', message: (err as Error).message },
      });
    }
  }

  exitWorker(0);
}
