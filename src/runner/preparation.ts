import { dirname } from 'path';
import { computeAgentId } from '../utils/agent-id';
import { createSubAgentTools } from '../subagent';
import {
  DoomLoopDetector,
  resolveSafeVariables,
  type PathResolverContext
} from '../tools/index.js';
import { logger } from '../utils/logger';
import { resolveMaxSteps, DEFAULT_MAX_STEPS } from '../utils/config';
import { version as packageVersion } from '../../package.json';
import type { PrepareAgentOptions, PreparedAgentExecution } from './types';
import type { ToolSet } from 'ai';
import { loadAgentTools } from './tools-loader';
import { buildSystemMessages, buildLearningPrompt } from './system-messages';
import { createSessionAndMessage } from './session-helper';
import { bindToolsToSnapshot, createToolsSnapshot } from './tool-snapshot';
import { rehydrateMessages } from '../session';
import { appendApprovalInstructions } from './approval';
import {
  expandSkillAllows,
  getExplicitSkillNames,
  loadSkillPromptOutputs,
} from '../skill/index.js';

/**
 * Prepare agent execution - shared setup logic for both streaming and non-streaming modes
 * This extracts the common setup code to avoid duplication between runAgent and serve.ts
 */
export async function prepareAgentExecution(options: PrepareAgentOptions): Promise<PreparedAgentExecution> {
  const {
    agent,
    mcpClients,
    agentFilePath,
    cliMaxSteps,
    sessionManager,
    projectContext,
    userPrompt,
    abortSignal,
    verbose = false,
    existingSessionId,
    prebuiltMessages,
    trigger
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
      const effectiveToolsConfig = expandSkillAllows(
        agent.config.tools,
        explicitSkillNames.flatMap((name) =>
          agent.config.skills!.explicit[name]?.allow?.filter((allow) => allow !== '*') ?? []
        )
      );
      const preloadedSkills = await loadSkillPromptOutputs(
        projectContext.projectRoot,
        effectiveToolsConfig,
        explicitSkillNames
      );
      if (preloadedSkills.length > 0) {
        resolvedInstructions = [
          resolvedInstructions,
          '## Preloaded Skills',
          preloadedSkills.map((skill) => skill.output).join('\n\n'),
        ].join('\n\n');
        logger.debug(`[Skills] Preloaded ${preloadedSkills.map((skill) => skill.name).join(', ')}`);
      }
    }
  }

  // Append learnings to instructions if apply is enabled. Resume uses the
  // persisted LLM state, so learning prompts are intentionally not re-derived.
  let learningsApplied = 0;
  if (!existingSessionId && agent.config.learning?.apply && agentFilePath) {
    const learningResult = await buildLearningPrompt(agent, agentFilePath);
    if (learningResult) {
      resolvedInstructions = `${resolvedInstructions}\n\n${learningResult.prompt}`;
      learningsApplied = learningResult.count;
      logger.debug(`[Learning] Appended ${learningsApplied} learning(s) to instructions`);
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
  let agentId = computeAgentId(agentFilePath, projectContext?.stateRoot, agent.name);
  let systemMessages: Array<{ role: string; content: string }>;
  let resumedMessages = prebuiltMessages;
  let userMessage: string;

  logger.debug(`Session manager available: ${!!sessionManager}, Project context available: ${!!projectContext}`);

  if (existingSessionId) {
    if (!sessionManager) {
      throw new Error('Cannot resume without a session manager');
    }

    const found = await sessionManager.findSession(existingSessionId);
    if (!found) {
      throw new Error(`Session not found: ${existingSessionId}`);
    }
    sessionID = existingSessionId;
    agentId = found.agentId;
    const message = await sessionManager.getPrimaryMessage(existingSessionId, found.agentId);
    if (!message) {
      throw new Error(`Session message not found: ${existingSessionId}`);
    }
    assistantMsgID = message.id;
    systemMessages = message.assistant.system.map(content => ({ role: 'system', content }));
    userMessage = message.user.prompt.user
      ? `${message.user.prompt.task}\n\n${message.user.prompt.user}`
      : message.user.prompt.task;
    resumedMessages ??= await rehydrateMessages(sessionManager, existingSessionId, found.agentId);
    if (userPrompt?.trim()) {
      resumedMessages = [
        ...resumedMessages,
        { role: 'user', content: userPrompt.trim() } as any
      ];
      userMessage = userPrompt.trim();
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
  }

  if (!existingSessionId && sessionManager && projectContext) {
    try {
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
        config: {
          ...(agent.config.timeout !== undefined && { timeout: agent.config.timeout }),
          maxSteps,
          ...(agent.config.mcpServers && { mcpServers: Object.keys(agent.config.mcpServers) }),
          ...(agent.config.subagents && { subagents: agent.config.subagents.map(sa => ({
            path: sa.path,
            ...(sa.name && { name: sa.name })
          })) }),
        },
        isSubAgent: false,
      });

      sessionID = createdSessionID;
      assistantMsgID = messageID;
      logger.debug(`Session created: ${sessionID}`);
    } catch (error) {
      logger.warn(`Failed to create session: ${(error as Error).message}`);
      if (verbose) {
        logger.debug(`Session creation error stack: ${(error as Error).stack}`);
      }
    }
  }

  // Load all agent tools (MCP, configured, skill, store, sandbox)
  // Done after session creation so sandbox output dir uses the session ID
  const loadedTools = await loadAgentTools({
    agent,
    projectContext,
    agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
    agentFilePath,
    mcpConnections: mcpClients,
    sessionId: sessionID,
  });

  // Load sub-agent tools if configured
  let subAgentTools: Record<string, ToolSet[string]> = {};
  if (agent.config.subagents && agent.config.subagents.length > 0) {
    const basePath = agentFilePath ? dirname(agentFilePath) : undefined;
    if (agentFilePath && verbose) {
      logger.debug(`[SubAgent] Agent file path: ${agentFilePath}`);
      logger.debug(`[SubAgent] Base path for sub-agents: ${basePath}`);
    }
    // Pass the parent's model to subagents so they inherit any model override
    subAgentTools = await createSubAgentTools(
      agent.config.subagents,
      basePath,
      agent.config.model,
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

  if (Object.keys(tools).length > 0) {
    logger.debug(`Available tools: ${Object.keys(tools).join(', ')}`);
  }

  // Log step limit if it's non-default or in verbose mode
  if (maxSteps !== DEFAULT_MAX_STEPS || verbose) {
    logger.debug(`Max steps: ${maxSteps} (override via MAX_STEPS env var)`);
  }

  // Track subagent names for logging
  const subAgentNames = new Set(Object.keys(subAgentTools));

  // Create cleanup function to release resources
  const cleanup = async () => {
    if (loadedTools.store) {
      await loadedTools.store.releaseLock();
    }
    if (loadedTools.sandboxInstance) {
      await loadedTools.sandboxInstance.kill();
    }
  };

  return {
    tools,
    systemMessages,
    userMessage,
    ...(resumedMessages && { messages: resumedMessages }),
    maxSteps,
    subAgentNames,
    sessionID,
    assistantMsgID,
    agentId,
    doomLoopDetector,
    cleanup,
    learningsApplied
  };
}
