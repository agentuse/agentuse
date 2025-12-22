import type { Tool } from 'ai';
import { createReadTool, createWriteTool, createEditTool } from './filesystem.js';
import { createBashTool } from './bash.js';
import type { ToolsConfig } from './types.js';

export { ToolsConfigSchema } from './types.js';
export type { ToolsConfig, FilesystemPathConfig, BashConfig } from './types.js';
export { DoomLoopDetector, DoomLoopError, type DoomLoopConfig, type ToolCall } from './doom-loop-detector.js';

/**
 * Create all configured tools
 *
 * @param config Tools configuration from agent YAML
 * @param projectRoot Project root directory for path resolution
 * @returns Record of tool name to Tool instance
 */
export function getTools(
  config: ToolsConfig,
  projectRoot: string
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

  // Create filesystem tools if configured
  if (config.filesystem && config.filesystem.length > 0) {
    // Check which permissions are configured
    const hasRead = config.filesystem.some(c => c.permissions.includes('read'));
    const hasWrite = config.filesystem.some(c => c.permissions.includes('write'));
    const hasEdit = config.filesystem.some(c => c.permissions.includes('edit'));

    if (hasRead) {
      tools['tools__filesystem_read'] = createReadTool(config.filesystem, projectRoot);
    }

    if (hasWrite) {
      tools['tools__filesystem_write'] = createWriteTool(config.filesystem, projectRoot);
    }

    if (hasEdit) {
      tools['tools__filesystem_edit'] = createEditTool(config.filesystem, projectRoot);
    }
  }

  // Create bash tool if configured
  if (config.bash && config.bash.commands.length > 0) {
    tools['tools__bash'] = createBashTool(config.bash, projectRoot);
  }

  return tools;
}
