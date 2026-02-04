import type { ParsedAgent } from '../parser';
import type { SessionManager } from '../session';
import { computeAgentId } from '../utils/agent-id';

export interface SessionContext {
  projectRoot: string;
  cwd: string;
}

export interface SessionConfigOptions {
  timeout?: number;
  maxSteps?: number;
  mcpServers?: string[];
  subagents?: Array<{ path: string; name?: string }>;
}

export interface CreateSessionParams {
  sessionManager: SessionManager;
  agent: ParsedAgent;
  agentFilePath?: string;
  systemMessages: string[];
  task: string;
  userPrompt?: string;
  projectContext: SessionContext;
  version: string;
  config?: SessionConfigOptions;
  isSubAgent?: boolean;
  parentSessionID?: string;
}

/**
 * Create a session and initial message together to keep SessionManager usage consistent.
 */
export async function createSessionAndMessage(params: CreateSessionParams): Promise<{ sessionID: string; messageID: string }> {
  const {
    sessionManager,
    agent,
    agentFilePath,
    systemMessages,
    task,
    userPrompt,
    projectContext,
    version,
    config = {},
    isSubAgent = false,
    parentSessionID,
  } = params;

  // Extract agent ID from file path (relative path without extension)
  const agentId = computeAgentId(agentFilePath, projectContext.projectRoot, agent.name);

  const sessionID = await sessionManager.createSession({
    ...(parentSessionID ? { parentSessionID } : {}),
    agent: {
      id: agentId,
      name: agent.name,
      ...(agent.description && { description: agent.description }),
      ...(agentFilePath && { filePath: agentFilePath }),
      isSubAgent,
    },
    model: agent.config.model,
    version,
    config: {
      ...(config.timeout !== undefined && { timeout: config.timeout }),
      ...(config.maxSteps !== undefined && { maxSteps: config.maxSteps }),
      ...(config.mcpServers && { mcpServers: config.mcpServers }),
      ...(config.subagents && { subagents: config.subagents }),
    },
    project: {
      root: projectContext.projectRoot,
      cwd: projectContext.cwd,
    },
  });

  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: {
      prompt: {
        task,
        ...(userPrompt && { user: userPrompt }),
      },
    },
    assistant: {
      system: systemMessages,
      modelID: agent.config.model,
      providerID: agent.config.model.split(':')[0],
      mode: 'build',
      path: { cwd: projectContext.cwd, root: projectContext.projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });

  return { sessionID, messageID };
}
