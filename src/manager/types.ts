/**
 * Manager agent types
 */

/**
 * Subagent info extracted from parsed agent files
 */
export interface SubagentInfo {
  name: string;
  description?: string | undefined;
  path: string;
}

/**
 * Manager prompt context - data needed to build the manager prompt
 */
export interface ManagerPromptContext {
  subagents: SubagentInfo[];
  storeName?: string | undefined;
}
