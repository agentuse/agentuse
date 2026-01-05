import type { Tool } from 'ai';
import { createReadTool, createWriteTool, createEditTool } from './filesystem.js';
import { createBashTool } from './bash.js';
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

    if (hasEdit) {
      tools['tools__filesystem_edit'] = createEditTool(config.filesystem, context);
    }
  }

  // Create bash tool if configured
  if (config.bash && config.bash.commands.length > 0) {
    tools['tools__bash'] = createBashTool(config.bash, context.projectRoot, context);
  }

  return tools;
}
