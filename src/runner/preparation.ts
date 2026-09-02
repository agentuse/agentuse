import { dirname } from 'path';
import { computeAgentId } from '../utils/agent-id';
import { findProjectRoot } from '../utils/project';
import { createSubAgentTools } from '../subagent';
import {
  DoomLoopDetector,
  resolveSafeVariables,
  type PathResolverContext
} from '../tools/index.js';
import { logger } from '../utils/logger';
import { resolveMaxSteps, DEFAULT_MAX_STEPS } from '../utils/config';
import {
  applyModelFallbackPolicy,
  applyRunModelOverride,
  resumeModelPin,
  snapshotModelFallbackPolicy,
} from '../utils/model-alias';
import { version as packageVersion } from '../../package.json';
import type { PrepareAgentOptions, PreparedAgentExecution } from './types';
import type { ToolSet } from 'ai';
import { loadAgentTools } from './tools-loader';
import { EffectWAL } from './effect-wal';
import { createLiveToolOutputRelay } from './live-tool-output';
import {
  buildSystemMessages,
  buildLearningPrompt,
  ensurePersistentStoreBoundary,
} from './system-messages';
import { createSessionAndMessage } from './session-helper';
import { bindToolsToSnapshot, createToolsSnapshot } from './tool-snapshot';
import { rehydrateMessages, ensureTrailingUserTurn } from '../session';
import type { AssistantTokens } from '../session/usage';
import { appendApprovalInstructions } from './approval';
import {
  expandTrustedSkills,
  getExplicitSkillNames,
  loadSkillPromptOutputs,
} from '../skill/index.js';
import { discoverSkills } from '../skill/discovery.js';
import { resolveVerifyPlacements, withGateVerify } from '../verify/gate.js';

/**
 * Prepare agent execution - shared setup logic for both streaming and non-streaming modes
 * This extracts the common setup code to avoid duplication between runAgent and serve.ts
 */
export async function prepareAgentExecution(options: PrepareAgentOptions): Promise<PreparedAgentExecution> {
  const {
    agent,
    mcpClients,
    subagentModelOverride,
    agentFilePath,
    cliMaxSteps,
    sessionManager,
    projectContext,
    userPrompt,
    abortSignal,
    verbose = false,
    existingSessionId,
    prebuiltMessages,
    trigger,
    newSessionId,
    preparedSession
  } = options;

  // Resolve safe variables in instructions (${root}, ${agentDir}, ${tmpDir} - NOT ${env:*})
  const pathContext: PathResolverContext = {
    projectRoot: projectContext?.projectRoot ?? process.cwd(),
    agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
  };
  let resolvedInstructions = resolveSafeVariables(agent.instructions, pathContext);
  if (!existingSessionId) {
    resolvedInstructions = appendApprovalInstructions(resolvedInstructions, agent.config);
  }

  if (!existingSessionId && projectContext) {
    const explicitSkillNames = getExplicitSkillNames(agent.config.skills);
    if (explicitSkillNames.length > 0) {
      // Pass the trust-expanded config so a trusted skill's own allowed-tools
      // don't show as "ungranted" in its preloaded prompt output.
      const discovered = await discoverSkills(projectContext.projectRoot);
      const effectiveToolsConfig = expandTrustedSkills(
        agent.config.tools,
        discovered,
        agent.config.skills
      );
      const preloadedSkills = await loadSkillPromptOutputs(
        projectContext.projectRoot,
        effectiveToolsConfig,
        explicitSkillNames
      );
      if (preloadedSkills.length > 0) {
        resolvedInstructions = [
          resolvedInstructions,
          '## Skills (shared defaults; agent instructions and relevant contextual learnings may refine them)',
          preloadedSkills.map((skill) => skill.output).join('\n\n'),
        ].join('\n\n');
        logger.debug(`[Skills] Preloaded ${preloadedSkills.map((skill) => skill.name).join(', ')}`);
      }
    }
  }

  // Append learnings to instructions if apply is enabled. Resume uses the
  // persisted LLM state, so learning prompts are intentionally not re-derived.
  let learningsApplied = 0;
  let learningsStored = 0;
  let learningsCap = 0;
  let learningsInjectedIds: string[] = [];
  if (!existingSessionId && agent.config.learning?.apply && agentFilePath) {
    // Same state root that keys this run's session and agentId. Derived from the
    // agent file when the caller supplied no project context, which is exactly
    // how `resolveProjectContext` would have computed it.
    const learningResult = await buildLearningPrompt(
      agent,
      agentFilePath,
      projectContext?.stateRoot ?? findProjectRoot(agentFilePath),
    );
    if (learningResult?.prompt) {
      resolvedInstructions = `${resolvedInstructions}\n\n${learningResult.prompt}`;
    }
    if (learningResult) {
      learningsApplied = learningResult.count;
      learningsStored = learningResult.total;
      learningsCap = learningResult.cap;
      learningsInjectedIds = learningResult.injectedIds;
      logger.debug(`[Learning] Appended ${learningsApplied} of ${learningsStored} learning(s) to instructions`);
    }
  }

  // Precedence: CLI > Agent YAML > Default
  const maxSteps = resolveMaxSteps(cliMaxSteps, agent.config.maxSteps);

  // Create doom loop detector to catch agents stuck in repetitive tool calls
  const doomLoopDetector = new DoomLoopDetector({ threshold: 3, action: 'error' });

  logger.debug(`Running agent with model: ${agent.config.model}`);

  // Create session first so sandbox can use the session ID for its output directory
  let sessionID: string | undefined;
  let assistantMsgID: string | undefined;
  let priorTokens: AssistantTokens | undefined;
  let agentId = computeAgentId(agentFilePath, projectContext?.stateRoot, agent.name);
  let systemMessages: Array<{ role: string; content: string }>;
  let resumedMessages = prebuiltMessages;
  let userMessage: string;
  let cacheableUserMessage: string | undefined;
  let effectiveSubagentModelOverride = subagentModelOverride;

  logger.debug(`Session manager available: ${!!sessionManager}, Project context available: ${!!projectContext}`);

  if (existingSessionId) {
    if (!sessionManager) {
      throw new Error('Cannot resume without a session manager');
    }

    const found = await sessionManager.findSession(existingSessionId);
    if (!found) {
      throw new Error(`Session not found: ${existingSessionId}`);
    }
    // A daemon restart reconstructs the root and subagent tools from agent
    // files. A persisted run-wide override is authoritative for both; otherwise
    // a changed alias or a new resume request could split the hierarchy across
    // different policies. Legacy sessions have no snapshot, so an override
    // explicitly supplied to this resume remains a deliberate new choice.
    const persistedModelOverride = found.session.config.modelOverride;
    const persistedModelFallback = found.session.config.modelFallback;
    effectiveSubagentModelOverride = persistedModelOverride ?? subagentModelOverride;
    if (persistedModelOverride) {
      applyRunModelOverride(agent.config, persistedModelOverride);
    } else if (persistedModelFallback) {
      applyModelFallbackPolicy(agent.config, persistedModelFallback);
    }
    if (!persistedModelOverride && !subagentModelOverride) {
      // A normal resume continues on the model the session started with (see
      // resumeModelPin): the agent file was re-parsed just now, so an alias
      // would otherwise change model in the middle of one conversation.
      const pinnedModel = resumeModelPin(agent.config, found.session.model);
      if (pinnedModel) {
        logger.info(
          `Resuming on ${pinnedModel} (the model this session started with); ` +
            `${agent.config.modelAlias ?? 'the configured default'} now points at ${agent.config.model}`
        );
        agent.config.model = pinnedModel;
        // Legacy sessions persisted the selected model but not the alias's
        // fallback policy. Keep the pin first and use today's other resolved
        // candidates as a best-effort recovery path.
        if (!persistedModelFallback && agent.config.modelCandidates) {
          agent.config.modelCandidates = [
            pinnedModel,
            ...agent.config.modelCandidates.filter((candidate) => candidate !== pinnedModel),
          ];
        }
      }
    }

    sessionID = existingSessionId;
    agentId = found.agentId;
    const message = await sessionManager.getPrimaryMessage(existingSessionId, found.agentId);
    if (!message) {
      throw new Error(`Session message not found: ${existingSessionId}`);
    }
    assistantMsgID = message.id;
    // Carry the cumulative token total forward so the resumed run's usage adds
    // to it rather than overwriting it (keeps the session count monotonic).
    priorTokens = message.assistant.tokens;
    const persistedSystemMessages = message.assistant.system.map(content => ({ role: 'system', content }));
    systemMessages = agent.config.store
      ? ensurePersistentStoreBoundary(persistedSystemMessages)
      : persistedSystemMessages;
    const persistedSystemChanged =
      systemMessages.length !== persistedSystemMessages.length
      || systemMessages.some((systemMessage, index) =>
        systemMessage.role !== persistedSystemMessages[index]?.role
        || systemMessage.content !== persistedSystemMessages[index]?.content
      );
    if (persistedSystemChanged) {
      // Upgrade legacy sessions in place. This keeps diagnostics and later
      // resumes aligned with the model-facing history. Compare content as well
      // as length so an older policy version is replaced exactly once.
      await sessionManager.updateMessage(existingSessionId, found.agentId, message.id, {
        assistant: { system: systemMessages.map(systemMessage => systemMessage.content) },
      });
    }
    userMessage = message.user.prompt.user
      ? `${message.user.prompt.task}\n\n${message.user.prompt.user}`
      : message.user.prompt.task;
    resumedMessages ??= await rehydrateMessages(sessionManager, existingSessionId, found.agentId);
    if (agent.config.store) {
      // Context snapshots can predate the persisted-message upgrade above, so
      // enforce the same boundary directly in the history sent to the model.
      resumedMessages = ensurePersistentStoreBoundary(resumedMessages);
    }
    if (userPrompt?.trim()) {
      resumedMessages = [
        ...resumedMessages,
        { role: 'user', content: userPrompt.trim() } as any
      ];
      userMessage = userPrompt.trim();
    }
    // Last line of defence before the resumed history reaches a provider: a
    // trailing assistant turn is an accidental prefill and is a hard 400 on
    // Anthropic reasoning models. Whatever produced it (a rewound attempt whose
    // tail was not fully retired, a hand-edited session), a resume that can run
    // beats a resume that cannot.
    const guarded = ensureTrailingUserTurn(resumedMessages);
    if (guarded !== resumedMessages) {
      logger.debug('Resumed history ended on an assistant turn; appended a continuation user turn');
      resumedMessages = guarded;
    }
  } else {
    // Build system messages (Anthropic prompt, autonomous prompt, manager prompt if applicable)
    const systemMessagesResult = await buildSystemMessages({
      agent,
      isSubAgent: false,
      agentFilePath,
      projectRoot: projectContext?.projectRoot,
      stateRoot: projectContext?.stateRoot,
    });
    systemMessages = systemMessagesResult.messages;

    // Build user message by concatenating task and user prompts
    userMessage = userPrompt
      ? `${resolvedInstructions}\n\n${userPrompt}`
      : resolvedInstructions;
    cacheableUserMessage = userPrompt ? resolvedInstructions : undefined;
  }

  if (!existingSessionId && sessionManager && projectContext) {
    try {
      const modelFallback = snapshotModelFallbackPolicy(agent.config);
      const { sessionID: createdSessionID, messageID } = await createSessionAndMessage({
        sessionManager,
        agent,
        ...(agentFilePath !== undefined && { agentFilePath }),
        systemMessages: systemMessages.map(m => m.content),
        task: resolvedInstructions,
        ...(userPrompt !== undefined && { userPrompt }),
        projectContext,
        version: packageVersion,
        ...(trigger && { trigger }),
        ...(newSessionId && { sessionId: newSessionId }),
        ...(preparedSession && { preparedSession: true }),
        config: {
          ...(agent.config.timeout !== undefined && { timeout: agent.config.timeout }),
          maxSteps,
          ...(agent.config.mcpServers && { mcpServers: Object.keys(agent.config.mcpServers) }),
          ...(agent.config.subagents && { subagents: agent.config.subagents.map(sa => ({
            path: sa.path,
            ...(sa.name && { name: sa.name })
          })) }),
          ...(effectiveSubagentModelOverride && { modelOverride: effectiveSubagentModelOverride }),
          ...(modelFallback && { modelFallback }),
        },
        isSubAgent: false,
      });

      sessionID = createdSessionID;
      assistantMsgID = messageID;
      logger.debug(`Session created: ${sessionID}`);
    } catch (error) {
      // A prepared shell is the durable lifecycle authority. If it was stopped
      // or failed before dispatch, never continue as an untracked model run.
      if (preparedSession) throw error;
      logger.warn(`Failed to create session: ${(error as Error).message}`);
      if (verbose) {
        logger.debug(`Session creation error stack: ${(error as Error).stack}`);
      }
    }
  }

  // Load all agent tools (MCP, configured, skill, store, sandbox)
  // Done after session creation so sandbox output dir uses the session ID
  const toolOutputArtifacts = sessionManager && sessionID && assistantMsgID
    ? {
        createStream: (toolName: string, metadata?: Record<string, unknown>) =>
          sessionManager.createToolOutputArtifactStream(sessionID, agentId, assistantMsgID, toolName, metadata),
      }
    : undefined;
  // Effect WAL: one append-only journal per session for tool executes and bash
  // spawn/exit records, written synchronously at the effect layer so it stays
  // complete even when a suspension abandons the stream consumer mid-step.
  const effectWal = new EffectWAL();
  // Live tool output (bash tails) for the session view. Created here because
  // tools are built now, bound later by the stream consumer that owns the tool
  // parts; unbound consumers simply drop tails.
  const liveToolOutput = createLiveToolOutputRelay();
  if (sessionManager && sessionID) {
    try {
      effectWal.bind(await sessionManager.getSessionDirectory(sessionID, agentId));
    } catch (error) {
      logger.debug(`Failed to bind effect WAL: ${(error as Error).message}`);
    }
  }
  const loadedTools = await loadAgentTools({
    agent,
    projectContext,
    agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
    agentFilePath,
    mcpConnections: mcpClients,
    sessionId: sessionID,
    toolOutputArtifacts,
    effectAudit: effectWal,
    liveToolOutput,
  });

  // Load sub-agent tools if configured
  let subAgentTools: Record<string, ToolSet[string]> = {};
  if (agent.config.subagents && agent.config.subagents.length > 0) {
    const basePath = agentFilePath ? dirname(agentFilePath) : undefined;
    if (agentFilePath && verbose) {
      logger.debug(`[SubAgent] Agent file path: ${agentFilePath}`);
      logger.debug(`[SubAgent] Base path for sub-agents: ${basePath}`);
    }
    // Agent frontmatter is local to that agent. Only a model explicitly
    // supplied for this run cascades through delegation; passing the parent's
    // ordinary configured model here made every child's own `model:` dead.
    subAgentTools = await createSubAgentTools(
      agent.config.subagents,
      basePath,
      effectiveSubagentModelOverride,
      0,
      [],
      sessionManager,
      sessionID,
      agentId,
      projectContext,
      abortSignal
    );

    if (verbose) {
      logger.debug(`[SubAgent] Loaded ${Object.keys(subAgentTools).length} sub-agent tool(s)`);
    }
  }

  // Merge all tools (loadedTools.all contains MCP, configured, skill, store)
  let tools = { ...loadedTools.all, ...subAgentTools };

  if (sessionManager && sessionID) {
    if (existingSessionId) {
      const snapshot = await sessionManager.readToolsSnapshot(sessionID, agentId);
      if (!snapshot) {
        throw new Error(`Missing tools snapshot for session ${sessionID}`);
      }
      tools = bindToolsToSnapshot(tools, snapshot);
    } else {
      await sessionManager.writeToolsSnapshot(sessionID, agentId, createToolsSnapshot(tools));
    }
  }

  // Verify gate placement: judge each await_human payload before suspending.
  // Wrapped after the snapshot bind — the wrapper preserves name/schema, so
  // snapshots and resume are unaffected.
  if (agent.config.verify && tools.await_human) {
    const placements = resolveVerifyPlacements(agent.config.verify, true);
    if (placements.has('gate')) {
      // The toolset entry type is a union the AI SDK derives per-tool; the
      // wrapper only spreads the tool and replaces execute, so the cast is safe.
      tools.await_human = withGateVerify(tools.await_human as import('ai').Tool, {
        config: agent.config.verify,
        agentModel: agent.config.model,
        task: agent.instructions,
        agentFilePath,
        projectContext,
        abortSignal,
        sessionManager,
        sessionID,
        agentId,
        messageID: assistantMsgID,
      });
    }
  }

  if (Object.keys(tools).length > 0) {
    logger.debug(`Available tools: ${Object.keys(tools).join(', ')}`);
  }

  // Log step limit if it's non-default or in verbose mode
  if (maxSteps !== DEFAULT_MAX_STEPS || verbose) {
    logger.debug(`Max steps: ${maxSteps} (override via MAX_STEPS env var)`);
  }

  // Track subagent names for logging
  const subAgentNames = new Set(Object.keys(subAgentTools));

  // Release only the store lock. releaseLock is idempotent, so this can run
  // early (before the status flip) and again in cleanup.
  const releaseStoreLock = async () => {
    if (loadedTools.store) {
      await loadedTools.store.releaseLock();
    }
  };

  // Create cleanup function to release resources
  const cleanup = async () => {
    await releaseStoreLock();
    if (loadedTools.sandboxInstance) {
      await loadedTools.sandboxInstance.kill();
    }
  };

  return {
    tools,
    systemMessages,
    userMessage,
    ...(cacheableUserMessage !== undefined && { cacheableUserMessage }),
    ...(resumedMessages && { messages: resumedMessages }),
    maxSteps,
    subAgentNames,
    sessionID,
    assistantMsgID,
    ...(priorTokens && { priorTokens }),
    agentId,
    runOutcome: loadedTools.runOutcome,
    ...(loadedTools.agentSourceSubmission && { agentSourceSubmission: loadedTools.agentSourceSubmission }),
    ...(loadedTools.projectSuggestionsSubmission && {
      projectSuggestionsSubmission: loadedTools.projectSuggestionsSubmission,
    }),
    ...(loadedTools.agentRevisionSubmission && {
      agentRevisionSubmission: loadedTools.agentRevisionSubmission,
    }),
    doomLoopDetector,
    effectWal,
    liveToolOutput,
    cleanup,
    releaseStoreLock,
    learningsApplied,
    learningsStored,
    learningsCap,
    learningsInjectedIds
  };
}
