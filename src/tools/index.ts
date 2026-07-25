import type { Tool } from 'ai';
import { createReadTool, createWriteTool, createEditTool } from './filesystem.js';
import { createBashTool } from './bash.js';
import { createAwaitHumanTool } from './await-human.js';
import { createArtifactTool, createListArtifactsTool, type ArtifactToolContext } from './artifacts.js';
import { createRecordMetricTool } from './metrics.js';
import type { ToolsConfig } from './types.js';
import type { PathResolverContext } from './path-validator.js';

export { ToolsConfigSchema } from './types.js';
export type { ToolsConfig, FilesystemPathConfig, BashConfig } from './types.js';
export { DoomLoopDetector, DoomLoopError, type DoomLoopConfig, type ToolCall } from './doom-loop-detector.js';
export { resolveSafeVariables, type PathResolverContext } from './path-validator.js';

/**
 * Create all configured tools
 *
 * @param config Tools configuration from agent YAML
 * @param context Path resolver context with projectRoot, agentDir, and tmpDir
 * @returns Record of tool name to Tool instance
 */
export function getTools(
  config: ToolsConfig,
  context: PathResolverContext
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

  // Create filesystem tools if configured
  if (config.filesystem && config.filesystem.length > 0) {
    // Check which permissions are configured
    const hasRead = config.filesystem.some(c => c.permissions.includes('read'));
    const hasWrite = config.filesystem.some(c => c.permissions.includes('write'));
    const hasEdit = config.filesystem.some(c => c.permissions.includes('edit'));

    if (hasRead) {
      tools['tools__filesystem_read'] = createReadTool(config.filesystem, context);
    }

    if (hasWrite) {
      tools['tools__filesystem_write'] = createWriteTool(config.filesystem, context);
    }

    // `write` is a superset of `edit` (overwrite-anything implies replace-substring),
    // so a `[read, write]` grant gets the targeted-edit tool too. This keeps the
    // common case efficient (edits over full rewrites) without forcing every agent
    // author to also list `edit`. `edit` alone remains a narrower grant.
    if (hasWrite || hasEdit) {
      tools['tools__filesystem_edit'] = createEditTool(config.filesystem, context);
    }
  }

  // Create bash tool if configured. The execution allowlist is commands ∪ gated:
  // a gated pattern IS runnable (the lease governs WHEN, not WHETHER it is allowed
  // at all), so it must pass the allowlist too. `gated` stays separately readable
  // (agent.config.tools.bash.gated) for the lease/barrier enforcement.
  if (config.bash) {
    const commands = config.bash.commands ?? [];
    const gated = config.bash.gated ?? [];
    if (commands.length > 0 || gated.length > 0) {
      const effectiveBash = gated.length > 0
        ? { ...config.bash, commands: [...new Set([...commands, ...gated])] }
        : config.bash;
      tools['tools__bash'] = createBashTool(effectiveBash, context.projectRoot, context);
    }
  }

  // Create artifact tools if configured. The artifact tool owns its write path
  // (under .agentuse/artifacts/), so it does not depend on a filesystem grant.
  //
  // sessionId/agentId are read through getters, not copied: a delegated
  // sub-agent loads its tools BEFORE its child session exists (subagent.ts) and
  // binds the id afterwards via LoadedAgentTools.bindSessionId. Snapshotting the
  // value here would freeze it at undefined, and every artifact the sub-agent
  // saved would land in the manifest with no session link - invisible to
  // /sessions/:id/artifacts-list and with no viewable URL returned to the model.
  if (config.artifacts) {
    const artifactCtx: ArtifactToolContext = {
      projectRoot: context.projectRoot,
      get sessionId() { return context.sessionId; },
      get agentId() { return context.agentId; },
      ...(typeof config.artifacts === 'object' && config.artifacts.dir
        ? { dir: config.artifacts.dir }
        : {}),
    };
    tools['tools__artifact_save'] = createArtifactTool(artifactCtx);
    tools['tools__artifact_list'] = createListArtifactsTool(artifactCtx);
  }

  // Metric recording writes to the reserved "metrics" store; like artifacts it
  // owns its write path and needs no filesystem or store grant. sessionId is
  // read lazily for the same reason as artifacts above - it is the upsert
  // idempotency key, so a frozen `undefined` makes every sub-agent retry append
  // a duplicate record instead of updating the existing one.
  if (config.metrics) {
    tools['tools__record_metric'] = createRecordMetricTool({
      projectRoot: context.projectRoot,
      get sessionId() { return context.sessionId; },
      get agentId() { return context.agentId; },
    });
  }

  const extraContext = context as PathResolverContext & {
    approval?: Parameters<typeof createAwaitHumanTool>[1];
  };
  const sessionId = context.sessionId;
  if (config.await_human) {
    tools['await_human'] = createAwaitHumanTool(sessionId, {
      ...extraContext.approval,
      projectRoot: context.projectRoot
    });
  }

  return tools;
}
