import type { Tool } from 'ai';
import { getMCPTools, type MCPConnection } from '../mcp';
import { computeAgentId } from '../utils/agent-id';
import { getTools as getConfiguredTools, type PathResolverContext } from '../tools/index.js';
import { createSkillTools } from '../skill/index.js';
import {
  expandTrustedSkills,
  getExplicitSkillNames,
  trustsAllSkills,
  getTrustedSkillNames,
} from '../skill/index.js';
import { discoverSkills } from '../skill/discovery.js';
import { createStore, createStoreTools, type Store } from '../store/index.js';
import { createReportIncompleteTool, createReportCompleteTool, type RunOutcome } from '../tools/report-outcome.js';
import { createSandbox, createSandboxTools, type SandboxInstance } from '../sandbox.js';
import { resolveFilesystemMounts, type ResolvedMount } from '../tools/path-validator.js';
import { getModelFromRegistry } from '../generated/models.js';
import { toRegistryKey } from '../utils/model-utils';
import { resolveMediaToolResultSupport } from '../models.js';
import { logger } from '../utils/logger';
import type { ParsedAgent } from '../parser';
import { approvalToolDefaults, isApprovalEnabled } from './approval';
import { ToolConfigError, type EffectAuditSink, type LiveToolOutputSink, type ToolOutputArtifactSink } from '../tools/types.js';
import { isMockMode, mockScope, wrapToolsWithLLMMock, wrapToolsWithGatedMock } from './mock-tools';
import { withIntentParam } from './tool-intent';
import {
  agentSourceSubmissionContract,
  createSubmitAgentSourceTool,
  type AgentSourceSubmission,
} from '../onboarding/submit-agent-source.js';
import {
  createSubmitProjectSuggestionsTool,
  projectSuggestionsSubmissionContract,
  type ProjectSuggestionsSubmission,
} from '../onboarding/submit-project-suggestions.js';

/**
 * Options for loading agent tools
 */
export interface LoadAgentToolsOptions {
  /** Parsed agent configuration */
  agent: ParsedAgent;
  /** Project context with cwd-derived projectRoot, agent-derived stateRoot, and cwd */
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string } | undefined;
  /** Directory containing the agent file (for resolving relative paths) */
  agentDir?: string | undefined;
  /** Full path to the agent file (for computing agentId) */
  agentFilePath?: string | undefined;
  /** Active MCP connections */
  mcpConnections: MCPConnection[];
  /** Log prefix for debug messages */
  logPrefix?: string | undefined;
  /** Session ID for sandbox output directory */
  sessionId?: string | undefined;
  /** Optional session-local artifact sink for tools that preserve full output. */
  toolOutputArtifacts?: ToolOutputArtifactSink | undefined;
  /** Optional effect-layer audit journal (bash spawn/exit records). */
  effectAudit?: EffectAuditSink | undefined;
  /** Optional live-output sink so long-running tools can show a tail while they run. */
  liveToolOutput?: LiveToolOutputSink | undefined;
}

/**
 * Result of loading agent tools
 */
export interface LoadedAgentTools {
  mcpTools: Record<string, Tool>;
  configuredTools: Record<string, Tool>;
  skillTools: Record<string, Tool>;
  storeTools: Record<string, Tool>;
  sandboxTools: Record<string, Tool>;
  /** All tools merged together */
  all: Record<string, Tool>;
  /**
   * Per-run outcome the always-on `report_incomplete` tool writes into. The
   * caller (runner/subagent) reads it after a clean finish to decide between
   * marking the session completed or error/INCOMPLETE.
   */
  runOutcome: RunOutcome;
  /** Validated source submitted by the private onboarding creator tool. */
  agentSourceSubmission?: AgentSourceSubmission | undefined;
  /** Validated suggestions submitted by the private onboarding discovery tool. */
  projectSuggestionsSubmission?: ProjectSuggestionsSubmission | undefined;
  /** Store instance (if configured) - caller must call store.releaseLock() when done */
  store?: Store | undefined;
  /** Sandbox instance (if configured) - caller must call sandboxInstance.kill() when done */
  sandboxInstance?: SandboxInstance | undefined;
  /**
   * Attach the run's session id to tools that resolve it at execute time
   * (artifact_save / artifact_list / record_metric).
   *
   * A delegated sub-agent must load its tools before its child session exists,
   * so it calls this once the id is known (subagent.ts). Without it those tools
   * stay session-less: artifacts land in the manifest with no `sessionId`, which
   * hides them from `/sessions/:id/artifacts-list` and returns no viewable URL,
   * and metrics lose their upsert key. Top-level runs already pass `sessionId`
   * up front, so calling this is a no-op for them.
   */
  bindSessionId(sessionId: string): void;
}

/**
 * Load all tools for an agent (MCP, configured, skill, store)
 *
 * This is shared logic between main agent (preparation.ts) and subagents (subagent.ts)
 */
export async function loadAgentTools(options: LoadAgentToolsOptions): Promise<LoadedAgentTools> {
  const {
    agent,
    projectContext,
    agentDir,
    agentFilePath,
    mcpConnections,
    logPrefix = '',
    sessionId,
    toolOutputArtifacts,
    effectAudit,
    liveToolOutput,
  } = options;

  // Compute agentId relative to the agent's own project (stateRoot) so the
  // id is stable across cwds. Stores still live under projectRoot below.
  const agentId = computeAgentId(agentFilePath, projectContext?.stateRoot, agent.name);

  // Convert MCP tools to AI SDK format
  const mcpTools = await getMCPTools(mcpConnections);
  const explicitSkillNames = getExplicitSkillNames(agent.config.skills);

  // Trust expansion (agentuse-lab#168): a trusted skill grants the bash commands
  // it declares in `allowed-tools`. Discover skills up front so their grants can
  // be folded into the tools config BEFORE the bash tool is built. Trust only
  // grants commands; gating remains an explicit author decision.
  let effectiveToolsConfig = agent.config.tools;
  if (projectContext) {
    try {
      const discovered = await discoverSkills(projectContext.projectRoot);
      effectiveToolsConfig = expandTrustedSkills(agent.config.tools, discovered, agent.config.skills);
    } catch (error) {
      logger.warn(`${logPrefix}Skill trust expansion failed: ${(error as Error).message}`);
    }
  }
  if (trustsAllSkills(agent.config.skills)) {
    logger.warn(`${logPrefix}Skill configuration uses skills: trusted - every discovered skill is granted the commands it declares in allowed-tools. Irreversible-looking commands are not automatically gated; review with 'agentuse doctor' and add tools.bash.gated entries explicitly.`);
  } else {
    const trusted = getTrustedSkillNames(agent.config.skills);
    if (trusted.length > 0) {
      logger.debug(`${logPrefix}Trusted skills: ${trusted.join(', ')} (granted their declared allowed-tools commands).`);
    }
  }

  // Get configured builtin tools (filesystem, bash)
  let configuredTools: Record<string, Tool> = {};
  // Hoisted so `bindSessionId` can attach the session after the fact. Tools that
  // read `sessionId` at execute time (artifacts, metrics) hold this object by
  // reference, so mutating it here reaches them without rebuilding - which
  // matters because rebuilding would drop the intent/mock wrappers applied at
  // the merge point below, and diverge from the persisted tools snapshot.
  let toolContext: PathResolverContext | undefined;
  if ((effectiveToolsConfig || isApprovalEnabled(agent.config)) && projectContext) {
    try {
      const toolsConfig = {
        ...(effectiveToolsConfig ?? {}),
        ...(isApprovalEnabled(agent.config) && { await_human: true })
      };
      // Resolve the running model's input modalities (can it reason over an
      // image/PDF?) and transport media support (can its wire actually deliver
      // one in a tool result?) so filesystem_read gates media reads on both.
      // toRegistryKey strips a `provider:model:env` auth suffix — the raw
      // string would miss the registry and silently disable media reads.
      // Fallback aliases share one prepared toolset. Advertise only media
      // capabilities supported by every candidate so a provider switch cannot
      // leave filesystem_read returning payloads the selected transport rejects.
      const modelCandidates = agent.config.modelCandidates ?? [agent.config.model];
      const candidateModalities = modelCandidates.map(
        (model) => getModelFromRegistry(toRegistryKey(model))?.modalities.input
      );
      const modelInputModalities = candidateModalities.every(Array.isArray)
        ? candidateModalities.slice(1).reduce(
            (shared, modalities) => shared.filter((modality) => modalities!.includes(modality)),
            [...candidateModalities[0]!]
          )
        : undefined;
      const candidateTransportSupport = await Promise.all(
        modelCandidates.map((model) => resolveMediaToolResultSupport(model))
      );
      const mediaToolResultSupport = {
        image: candidateTransportSupport.every((support) => support.image),
        pdf: candidateTransportSupport.every((support) => support.pdf),
      };
      toolContext = {
        projectRoot: projectContext.projectRoot,
        agentDir,
        sessionId,
        agentId,
        toolOutputArtifacts,
        effectAudit,
        liveToolOutput,
        approval: approvalToolDefaults(agent.config),
        modelId: agent.config.model,
        modelInputModalities,
        mediaToolResultSupport,
      } as PathResolverContext;
      configuredTools = getConfiguredTools(toolsConfig, toolContext);
      if (Object.keys(configuredTools).length > 0) {
        logger.debug(`${logPrefix}Loaded ${Object.keys(configuredTools).length} configured tool(s): ${Object.keys(configuredTools).join(', ')}`);
      }
    } catch (error) {
      // An invalid tool configuration must fail the run: continuing without
      // the tool means the agent silently runs degraded and fails confusingly
      // later. Only transient/environmental load failures stay warnings.
      if (error instanceof ToolConfigError) {
        throw error;
      }
      logger.warn(`${logPrefix}Failed to load configured tools: ${(error as Error).message}`);
    }
  }

  // Load skill tools if project context is available
  let skillTools: Record<string, Tool> = {};
  let loadedSkillNames: (() => string[]) | undefined;
  if (projectContext) {
    try {
      const loaded = await createSkillTools(
        projectContext.projectRoot,
        effectiveToolsConfig,
        {
          auto: agent.config.skills!.auto,
          explicitSkillNames,
          ...(agent.config.metadata?.internal === true
            && (agent.config.metadata.creator === 'agent' || agent.config.metadata.onboarding === 'agent-creator')
            ? { purpose: 'authoring' as const }
            : {}),
        }
      );
      const { skillTool, skillReadTool, skills } = loaded;
      if (skills.length > 0) {
        skillTools['tools__skill_load'] = skillTool;
        skillTools['tools__skill_read'] = skillReadTool;
        logger.debug(`${logPrefix}Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
        loadedSkillNames = loaded.loadedSkillNames;
      }
    } catch (error) {
      logger.warn(`${logPrefix}Failed to load skills: ${(error as Error).message}`);
    }
  }

  // Load store tools if store is configured
  let storeTools: Record<string, Tool> = {};
  let store: Store | undefined;
  if (agent.config.store && projectContext) {
    try {
      store = createStore(projectContext.projectRoot, agent.config.store, agentId);
      storeTools = createStoreTools(store);
      const storeName = store.getStoreName();
      logger.debug(`${logPrefix}Loaded store tools for "${storeName}"`);
    } catch (error) {
      logger.warn(`${logPrefix}Failed to create store: ${(error as Error).message}`);
    }
  }

  // Load sandbox tools if sandbox is configured
  let sandboxTools: Record<string, Tool> = {};
  let sandboxInstance: SandboxInstance | undefined;
  if (agent.config.sandbox && projectContext) {
    try {
      // Resolve filesystem mounts for the sandbox
      let filesystemMounts: ResolvedMount[] | undefined;
      if (agent.config.tools?.filesystem) {
        filesystemMounts = resolveFilesystemMounts(agent.config.tools.filesystem, {
          projectRoot: projectContext.projectRoot,
          agentDir,
        });
      }

      sandboxInstance = await createSandbox({
        config: agent.config.sandbox,
        projectRoot: projectContext.projectRoot,
        sessionId,
        filesystemMounts,
      });
      sandboxTools = createSandboxTools(
        sandboxInstance.container,
        projectContext.projectRoot,
        agent.config.sandbox.timeout ?? 300
      );
      const mountSummary = filesystemMounts?.map(m => `${m.hostPath}(${m.writable ? 'rw' : 'ro'})`).join(', ') ?? 'default(ro)';
      logger.debug(`${logPrefix}Loaded sandbox tool (mounts: ${mountSummary})`);
    } catch (error) {
      // A sandbox/tool-construction failure occurs after store initialization;
      // callers receive no LoadedAgentTools object, so clean partial resources
      // here rather than making them guess what was created.
      try { await sandboxInstance?.kill(); } catch { /* best-effort cleanup */ }
      try { await store?.releaseLock(); } catch { /* best-effort cleanup */ }
      throw new Error(`Failed to create sandbox: ${(error as Error).message}. The agent requires a sandbox but Docker is not available.`);
    }
  }

  // Always-on run-outcome tools, one per verdict. `report_incomplete` lets any
  // agent declare "ran clean but did not deliver" (blocked login, dead
  // precondition) so the run ends error/INCOMPLETE instead of a misleading
  // completed; `report_complete` carries the run's one-line headline for every
  // surface that shows an outcome before the body. They share one mutable ref,
  // read by the caller after the stream finishes.
  const runOutcome: RunOutcome = {};
  const agentSourceContract = agentSourceSubmissionContract(agent.config.metadata);
  const agentSourceSubmission: AgentSourceSubmission | undefined = agentSourceContract ? {} : undefined;
  const projectSuggestionsContract = projectSuggestionsSubmissionContract(agent.config.metadata);
  const projectSuggestionsSubmission: ProjectSuggestionsSubmission | undefined = projectSuggestionsContract ? {} : undefined;
  const baseReportComplete = createReportCompleteTool(runOutcome);
  const guardedReportComplete: Tool = agentSourceSubmission || projectSuggestionsSubmission
    ? {
        ...baseReportComplete,
        execute: async (input: unknown, options: unknown) => {
          if (agentSourceSubmission && !agentSourceSubmission.source) {
            throw new Error('No valid agent name, filename, and source have been submitted. Call submit_agent_source first, correct any validation error, and only then call report_complete.');
          }
          if (projectSuggestionsSubmission && !projectSuggestionsSubmission.result) {
            throw new Error('No valid project suggestions have been submitted. Call submit_project_suggestions first, correct any validation error, and only then call report_complete.');
          }
          return (baseReportComplete.execute as (input: unknown, options: unknown) => unknown)(input, options);
        },
      }
    : baseReportComplete;
  const outcomeTools: Record<string, Tool> = {
    report_incomplete: createReportIncompleteTool(runOutcome),
    report_complete: guardedReportComplete,
  };
  const internalSubmissionTools: Record<string, Tool> = {
    ...(agentSourceContract && agentSourceSubmission && {
      submit_agent_source: createSubmitAgentSourceTool(agentSourceSubmission, agentSourceContract, loadedSkillNames),
    }),
    ...(projectSuggestionsContract && projectSuggestionsSubmission && {
      submit_project_suggestions: createSubmitProjectSuggestionsTool(
        projectSuggestionsSubmission,
        projectSuggestionsContract,
      ),
    }),
  };

  // Single ordered merge point for every tool source. New sources (e.g. a future
  // plugin-contributed-tools capability) attach here — append the source's map to
  // this list — instead of threading another spread through the return. Order is
  // precedence: later sources win on name collisions.
  const toolSources: Record<string, Tool>[] = [
    mcpTools,
    configuredTools,
    skillTools,
    storeTools,
    sandboxTools,
    internalSubmissionTools,
    outcomeTools,
  ];

  // In mock mode, replace every merged tool's execute with an LLM-backed mock so
  // the agent runs end-to-end without real side effects. Sub-agent tools are
  // merged outside this point (see preparation.ts), so they stay real while each
  // sub-agent's own leaf tools get mocked via its own loadAgentTools call.
  // Gated scope (--mock-gated) instead mocks only this agent's declared
  // `tools.bash.gated` commands (plus the gate itself); everything else is real.
  const mergedTools: Record<string, Tool> = Object.assign({}, ...toolSources);
  let withMocks = mergedTools;
  if (isMockMode()) {
    if (mockScope() === 'gated') {
      const gatedPatterns = agent.config.tools?.bash?.gated ?? [];
      if (gatedPatterns.length === 0) {
        logger.warn(
          `${logPrefix}Gated-scope mock: agent declares no tools.bash.gated patterns, so NOTHING is mocked: ` +
            'all tools run for real (with approval gates auto-resolved). Use --scope all to fabricate everything.'
        );
      }
      withMocks = wrapToolsWithGatedMock(mergedTools, gatedPatterns);
    } else {
      withMocks = wrapToolsWithLLMMock(mergedTools);
    }
  }
  // Intent injection wraps LAST so its strip-execute sees exactly the args the
  // model sent, even when mock mode replaced the real execute underneath. This
  // runs before the tools snapshot in preparation.ts, so suspended sessions
  // resume with the same extended schemas they were created with.
  const all = agent.config.intent === false ? withMocks : withIntentParam(withMocks);

  return {
    mcpTools,
    configuredTools,
    skillTools,
    storeTools,
    sandboxTools,
    all,
    runOutcome,
    ...(agentSourceSubmission && { agentSourceSubmission }),
    ...(projectSuggestionsSubmission && { projectSuggestionsSubmission }),
    store,
    sandboxInstance,
    bindSessionId: (id: string) => {
      if (toolContext) toolContext.sessionId = id;
    },
  };
}

/**
 * A source of tools merged into an agent's tool set. This names the shape a
 * future tool source (e.g. plugin-contributed tools) would implement to attach
 * at the merge point in {@link loadAgentTools}. Not yet consumed — it documents
 * the extension seam so adding a source later needs no refactor.
 */
export type ToolProvider = (
  options: LoadAgentToolsOptions
) => Record<string, Tool> | Promise<Record<string, Tool>>;
