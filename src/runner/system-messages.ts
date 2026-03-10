import { dirname, resolve } from 'path';
import { computeAgentId } from '../utils/agent-id';
import { buildAutonomousAgentPrompt } from './prompt';
import { buildManagerPrompt, type SubagentInfo, type ScheduleInfo } from '../manager/index.js';
import { parseScheduleExpression, formatScheduleHuman } from '../scheduler/parser.js';
import { parseAgent, type ParsedAgent } from '../parser';
import { resolveFilesystemMounts, type ResolvedMount } from '../tools/path-validator.js';
import { logger } from '../utils/logger';
import { LearningStore } from '../learning/index.js';
import { addAnthropicIdentity, isAnthropicModel } from '../utils/anthropic';

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
  /** Project root directory (needed for computing agentId for store naming) */
  projectRoot?: string | undefined;
}

/**
 * Result from building system messages
 */
export interface BuildSystemMessagesResult {
  /** The system messages to send to the model */
  messages: Array<{ role: string; content: string }>;
}

/**
 * Build system messages for an agent
 *
 * This is shared logic between main agent (preparation.ts) and subagents (subagent.ts)
 */
export async function buildSystemMessages(options: BuildSystemMessagesOptions): Promise<BuildSystemMessagesResult> {
  const { agent, isSubAgent = false, agentFilePath, projectRoot } = options;

  let systemMessages: Array<{ role: string; content: string }> = [];

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
    const managerPrompt = await buildManagerSystemPrompt(agent, agentFilePath, projectRoot);
    if (managerPrompt) {
      systemMessages.push({
        role: 'system',
        content: managerPrompt,
      });
      logger.debug(`[Manager] Injected manager prompt`);
    }
  }

  // If sandbox is configured, inject sandbox context so the agent knows about mount paths
  if (agent.config.sandbox && projectRoot) {
    let mounts: ResolvedMount[] = [];
    if (agent.config.tools?.filesystem) {
      mounts = resolveFilesystemMounts(agent.config.tools.filesystem, {
        projectRoot,
        agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
      });
    }
    systemMessages.push({
      role: 'system',
      content: buildSandboxPrompt(projectRoot, mounts),
    });
    logger.debug(`[Sandbox] Injected sandbox system prompt (${mounts.length} mount(s))`);
  }

  // Prepend Anthropic identity if needed
  systemMessages = addAnthropicIdentity(systemMessages, agent.config.model);
  if (isAnthropicModel(agent.config.model) && !isSubAgent) {
    logger.debug("Using Anthropic system prompt: You are Claude Code...");
  }

  return { messages: systemMessages };
}

/**
 * Build the manager-specific system prompt
 */
async function buildManagerSystemPrompt(agent: ParsedAgent, agentFilePath?: string, projectRoot?: string): Promise<string | undefined> {
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
  // Uses agentId (file-path-based) for consistency with actual store naming
  let storeName: string | undefined;
  if (agent.config.store) {
    storeName = agent.config.store === true
      ? computeAgentId(agentFilePath, projectRoot, agent.name)
      : agent.config.store;
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

/**
 * Build the sandbox environment prompt so agents know about mount paths
 */
function buildSandboxPrompt(projectRoot: string, mounts: ResolvedMount[]): string {
  const home = process.env['HOME'] ?? '/root';

  // Build mount list for the prompt
  let mountList: string;
  if (mounts.length > 0) {
    mountList = mounts.map(m =>
      `- **\`${m.hostPath}\`** — ${m.writable ? 'read-write' : 'read-only'}`
    ).join('\n');
  } else {
    mountList = `- **\`${projectRoot}\`** — read-only (default)`;
  }

  const hasWritable = mounts.some(m => m.writable);
  const writeNote = hasWritable
    ? 'You can modify files in writable mounts using the filesystem tool — changes are reflected inside the sandbox automatically.'
    : 'Mounted paths are read-only in the sandbox. Use the filesystem tool on the host to modify project files.';

  return `## Sandbox Environment

You are running with a Docker sandbox for command execution. Key details:

- **Paths inside the container mirror the host** — use the same absolute paths everywhere (no \`/workspace/\` alias).
- **Mounted paths:**
${mountList}
- ${writeNote}
- Use \`sandbox__exec\` to run shell commands inside the container. Use the filesystem tool for reading/writing project files.
- **Skill directories** are mounted at their original host paths (e.g. \`${home}/.claude/skills/<skill-name>/\`). Access them via \`sandbox__exec\`.
- If you need packages not in the base image, install them via \`sandbox__exec\` (e.g. \`apt-get update && apt-get install -y <pkg>\` or \`npm install <pkg>\`).`;
}

/**
 * Result from building learning prompt
 */
export interface LearningPromptResult {
  prompt: string;
  count: number;
}

/**
 * Build the learning prompt to append to agent instructions
 * Called when learning.apply is enabled
 */
export async function buildLearningPrompt(agent: ParsedAgent, agentFilePath: string): Promise<LearningPromptResult | undefined> {
  try {
    const store = LearningStore.fromAgentFile(
      agentFilePath,
      agent.config.learning?.file
    );
    const learnings = await store.load();

    if (learnings.length === 0) {
      return undefined;
    }

    const maxLearnings = 10; // Prevent context bloat
    const toInject = learnings.slice(0, maxLearnings);

    const prompt = `## Learned Guidelines

Based on previous runs, follow these guidelines:

${toInject.map(l => `- [${l.category}] ${l.instruction}`).join('\n')}`;

    // Track usage (non-blocking)
    store.incrementApplied(toInject.map(l => l.id)).catch(err => {
      logger.debug(`[Learning] Failed to increment applied count: ${err.message}`);
    });

    logger.debug(`[Learning] Injected ${toInject.length} learning(s)`);
    return { prompt, count: toInject.length };
  } catch (error) {
    logger.debug(`[Learning] Failed to load learnings: ${(error as Error).message}`);
    return undefined;
  }
}
