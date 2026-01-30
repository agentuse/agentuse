import { dirname, resolve } from 'path';
import { buildAutonomousAgentPrompt } from './prompt';
import { buildManagerPrompt, type SubagentInfo, type ScheduleInfo } from '../manager/index.js';
import { parseScheduleExpression, formatScheduleHuman } from '../scheduler/parser.js';
import { parseAgent, type ParsedAgent } from '../parser';
import { logger } from '../utils/logger';

/**
 * Options for building system messages
 */
export interface BuildSystemMessagesOptions {
  /** Parsed agent configuration */
  agent: ParsedAgent;
  /** Whether this is a subagent (affects autonomous prompt) */
  isSubAgent?: boolean | undefined;
  /** Path to the agent file (needed for manager prompt to resolve subagent descriptions) */
  agentFilePath?: string | undefined;
}

/**
 * Build system messages for an agent
 *
 * This is shared logic between main agent (preparation.ts) and subagents (subagent.ts)
 */
export async function buildSystemMessages(options: BuildSystemMessagesOptions): Promise<Array<{ role: string; content: string }>> {
  const { agent, isSubAgent = false, agentFilePath } = options;

  const systemMessages: Array<{ role: string; content: string }> = [];

  // For Anthropic, add the Claude Code prompt as FIRST system message
  if (agent.config.model.includes('anthropic')) {
    systemMessages.push({
      role: 'system',
      content: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    });
    if (!isSubAgent) {
      logger.debug("Using Anthropic system prompt: You are Claude Code...");
    }
  }

  // Build today's date for system prompt
  const todayDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Add main system prompt
  systemMessages.push({
    role: 'system',
    content: buildAutonomousAgentPrompt(todayDate, isSubAgent)
  });

  // If this is a manager agent, inject the manager prompt
  if (agent.config.type === 'manager') {
    const managerPrompt = await buildManagerSystemPrompt(agent, agentFilePath);
    if (managerPrompt) {
      systemMessages.push({
        role: 'system',
        content: managerPrompt,
      });
      logger.debug(`[Manager] Injected manager prompt`);
    }
  }

  return systemMessages;
}

/**
 * Build the manager-specific system prompt
 */
async function buildManagerSystemPrompt(agent: ParsedAgent, agentFilePath?: string): Promise<string | undefined> {
  // Build subagent info for the manager prompt
  const subagentInfo: SubagentInfo[] = [];
  if (agent.config.subagents && agentFilePath) {
    const basePath = dirname(agentFilePath);
    for (const sa of agent.config.subagents) {
      try {
        const subagentPath = resolve(basePath, sa.path);
        const subagent = await parseAgent(subagentPath);
        subagentInfo.push({
          name: sa.name || subagent.name,
          description: subagent.description,
          path: sa.path,
        });
      } catch (error) {
        // If we can't parse the subagent, add basic info
        const name = sa.name || sa.path.split('/').pop()?.replace(/\.agentuse$/, '') || 'unknown';
        subagentInfo.push({
          name,
          path: sa.path,
        });
        logger.debug(`[Manager] Could not parse subagent ${sa.path}: ${(error as Error).message}`);
      }
    }
  }

  // Determine store name for the manager prompt
  let storeName: string | undefined;
  if (agent.config.store) {
    storeName = agent.config.store === true ? agent.name : agent.config.store;
  }

  // Determine schedule info for the manager prompt
  let scheduleInfo: ScheduleInfo | undefined;
  if (agent.config.schedule) {
    try {
      const cron = parseScheduleExpression(agent.config.schedule);
      const humanReadable = formatScheduleHuman(agent.config.schedule);
      scheduleInfo = { cron, humanReadable };
    } catch (error) {
      logger.debug(`[Manager] Could not parse schedule: ${(error as Error).message}`);
    }
  }

  // Build and return manager prompt
  return buildManagerPrompt({
    subagents: subagentInfo,
    storeName,
    schedule: scheduleInfo,
  });
}
