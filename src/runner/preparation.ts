import { dirname } from 'path';
import { getMCPTools } from '../mcp';
import { createSubAgentTools } from '../subagent';
import {
  getTools as getConfiguredTools,
  DoomLoopDetector,
  resolveSafeVariables,
  type PathResolverContext
} from '../tools/index.js';
import { logger } from '../utils/logger';
import { resolveMaxSteps, DEFAULT_MAX_STEPS } from '../utils/config';
import { createSkillTools } from '../skill/index.js';
import { buildAutonomousAgentPrompt } from './prompt';
import type { PrepareAgentOptions, PreparedAgentExecution } from './types';
import type { ToolSet } from 'ai';

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
    verbose = false
  } = options;

  // Convert MCP tools to AI SDK format
  const mcpTools = await getMCPTools(mcpClients);

  // Get configured builtin tools (filesystem, bash)
  const configuredTools = agent.config.tools && projectContext
    ? getConfiguredTools(agent.config.tools, {
        projectRoot: projectContext.projectRoot,
        agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
      } as PathResolverContext)
    : {};

  if (Object.keys(configuredTools).length > 0) {
    logger.debug(`Loaded ${Object.keys(configuredTools).length} configured tool(s): ${Object.keys(configuredTools).join(', ')}`);
  }

  // Resolve safe variables in instructions (${root}, ${agentDir}, ${tmpDir} - NOT ${env:*})
  const pathContext: PathResolverContext = {
    projectRoot: projectContext?.projectRoot ?? process.cwd(),
    agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
  };
  const resolvedInstructions = resolveSafeVariables(agent.instructions, pathContext);

  // Precedence: CLI > Agent YAML > Default
  const maxSteps = resolveMaxSteps(cliMaxSteps, agent.config.maxSteps);

  // Create doom loop detector to catch agents stuck in repetitive tool calls
  const doomLoopDetector = new DoomLoopDetector({ threshold: 3, action: 'error' });

  logger.debug(`Running agent with model: ${agent.config.model}`);

  // Build today's date for system prompt
  const todayDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Build system messages array
  const systemMessages: Array<{ role: string; content: string }> = [];

  // For Anthropic, add the Claude Code prompt as FIRST system message
  if (agent.config.model.includes('anthropic')) {
    systemMessages.push({
      role: 'system',
      content: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    });
    logger.debug("Using Anthropic system prompt: You are Claude Code...");
  }

  // Add main system prompt as second message
  systemMessages.push({
    role: 'system',
    content: buildAutonomousAgentPrompt(todayDate, false)
  });

  // Create session if session manager is provided
  let sessionID: string | undefined;
  let assistantMsgID: string | undefined;

  logger.debug(`Session manager available: ${!!sessionManager}, Project context available: ${!!projectContext}`);

  if (sessionManager && projectContext) {
    try {
      // Create session
      const agentConfig: {
        name: string;
        filePath?: string;
        description?: string;
        isSubAgent: boolean;
      } = {
        name: agent.name,
        isSubAgent: false
      };
      if (agentFilePath) agentConfig.filePath = agentFilePath;
      if (agent.description) agentConfig.description = agent.description;

      const sessionConfig: {
        timeout?: number;
        maxSteps?: number;
        mcpServers?: string[];
        subagents?: Array<{ path: string; name?: string }>;
      } = {};
      if (agent.config.timeout) sessionConfig.timeout = agent.config.timeout;
      if (maxSteps) sessionConfig.maxSteps = maxSteps;
      if (agent.config.mcpServers) sessionConfig.mcpServers = Object.keys(agent.config.mcpServers);
      if (agent.config.subagents) {
        sessionConfig.subagents = agent.config.subagents.map(sa => {
          const result: { path: string; name?: string } = { path: sa.path };
          if (sa.name) result.name = sa.name;
          return result;
        });
      }

      sessionID = await sessionManager.createSession({
        agent: agentConfig,
        model: agent.config.model,
        version: '0.1.4', // TODO: import from package.json
        config: sessionConfig,
        project: {
          root: projectContext.projectRoot,
          cwd: projectContext.cwd
        }
      });

      // Create message exchange (user + assistant in one)
      assistantMsgID = await sessionManager.createMessage(sessionID, agent.name, {
        user: {
          prompt: {
            task: resolvedInstructions,
            ...(userPrompt && { user: userPrompt })
          }
        },
        assistant: {
          system: systemMessages.map(m => m.content),
          modelID: agent.config.model,
          providerID: agent.config.model.split(':')[0],
          mode: 'build',
          path: { cwd: projectContext.cwd, root: projectContext.projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      });

      logger.debug(`Session created: ${sessionID}`);
    } catch (error) {
      logger.warn(`Failed to create session: ${(error as Error).message}`);
      if (verbose) {
        logger.debug(`Session creation error stack: ${(error as Error).stack}`);
      }
    }
  }

  // Load skill tools if project context is available
  let skillTools: Record<string, ToolSet[string]> = {};
  if (projectContext) {
    try {
      const { skillTool, skillReadTool, skills } = await createSkillTools(projectContext.projectRoot, agent.config.tools);
      if (skills.length > 0) {
        skillTools['tools__skill_load'] = skillTool;
        skillTools['tools__skill_read'] = skillReadTool;
        logger.debug(`Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
      }
    } catch (error) {
      logger.warn(`Failed to load skills: ${(error as Error).message}`);
    }
  }

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
      agent.name,
      projectContext,
      abortSignal
    );

    if (verbose) {
      logger.debug(`[SubAgent] Loaded ${Object.keys(subAgentTools).length} sub-agent tool(s)`);
    }
  }

  // Merge all tools
  const tools = { ...mcpTools, ...configuredTools, ...skillTools, ...subAgentTools };

  if (Object.keys(tools).length > 0) {
    logger.debug(`Available tools: ${Object.keys(tools).join(', ')}`);
  }

  // Log step limit if it's non-default or in verbose mode
  if (maxSteps !== DEFAULT_MAX_STEPS || verbose) {
    logger.debug(`Max steps: ${maxSteps} (override via MAX_STEPS env var)`);
  }

  // Track subagent names for logging
  const subAgentNames = new Set(Object.keys(subAgentTools));

  // Build user message by concatenating task and user prompts
  const userMessage = userPrompt
    ? `${resolvedInstructions}\n\n${userPrompt}`
    : resolvedInstructions;

  return {
    tools,
    systemMessages,
    userMessage,
    maxSteps,
    subAgentNames,
    sessionID,
    assistantMsgID,
    doomLoopDetector
  };
}
