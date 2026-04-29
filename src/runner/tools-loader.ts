import type { Tool } from 'ai';
import { getMCPTools, type MCPConnection } from '../mcp';
import { computeAgentId } from '../utils/agent-id';
import { getTools as getConfiguredTools, type PathResolverContext } from '../tools/index.js';
import { createSkillTools } from '../skill/index.js';
import { createStore, createStoreTools, type Store } from '../store/index.js';
import { createSandbox, createSandboxTools, type SandboxInstance } from '../sandbox.js';
import { resolveFilesystemMounts, type ResolvedMount } from '../tools/path-validator.js';
import { logger } from '../utils/logger';
import type { ParsedAgent } from '../parser';

/**
 * Options for loading agent tools
 */
export interface LoadAgentToolsOptions {
  /** Parsed agent configuration */
  agent: ParsedAgent;
  /** Project context with root and cwd */
  projectContext?: { projectRoot: string; cwd: string } | undefined;
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
  /** Extra skill discovery directories (e.g. injected by plugin bundles). */
  extraSkillDirs?: string[] | undefined;
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
  /** Store instance (if configured) - caller must call store.releaseLock() when done */
  store?: Store | undefined;
  /** Sandbox instance (if configured) - caller must call sandboxInstance.kill() when done */
  sandboxInstance?: SandboxInstance | undefined;
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
    extraSkillDirs,
  } = options;

  // Compute agentId (file-path-based identifier) for store naming
  const agentId = computeAgentId(agentFilePath, projectContext?.projectRoot, agent.name);

  // Convert MCP tools to AI SDK format
  const mcpTools = await getMCPTools(mcpConnections);

  // Get configured builtin tools (filesystem, bash)
  let configuredTools: Record<string, Tool> = {};
  if (agent.config.tools && projectContext) {
    try {
      configuredTools = getConfiguredTools(agent.config.tools, {
        projectRoot: projectContext.projectRoot,
        agentDir,
      } as PathResolverContext);
      if (Object.keys(configuredTools).length > 0) {
        logger.debug(`${logPrefix}Loaded ${Object.keys(configuredTools).length} configured tool(s): ${Object.keys(configuredTools).join(', ')}`);
      }
    } catch (error) {
      logger.warn(`${logPrefix}Failed to load configured tools: ${(error as Error).message}`);
    }
  }

  // Load skill tools if project context is available
  let skillTools: Record<string, Tool> = {};
  if (projectContext) {
    try {
      const { skillTool, skillReadTool, skills } = await createSkillTools(projectContext.projectRoot, agent.config.tools, extraSkillDirs);
      if (skills.length > 0) {
        skillTools['tools__skill_load'] = skillTool;
        skillTools['tools__skill_read'] = skillReadTool;
        logger.debug(`${logPrefix}Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
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
      sandboxTools = createSandboxTools(sandboxInstance.container, projectContext.projectRoot);
      const mountSummary = filesystemMounts?.map(m => `${m.hostPath}(${m.writable ? 'rw' : 'ro'})`).join(', ') ?? 'default(ro)';
      logger.debug(`${logPrefix}Loaded sandbox tool (mounts: ${mountSummary})`);
    } catch (error) {
      throw new Error(`Failed to create sandbox: ${(error as Error).message}. The agent requires a sandbox but Docker is not available.`);
    }
  }

  return {
    mcpTools,
    configuredTools,
    skillTools,
    storeTools,
    sandboxTools,
    all: { ...mcpTools, ...configuredTools, ...skillTools, ...storeTools, ...sandboxTools },
    store,
    sandboxInstance,
  };
}
