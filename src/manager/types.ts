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
 * Schedule info for manager context
 */
export interface ScheduleInfo {
  cron: string;
  humanReadable: string;
}

/**
 * Manager prompt context - data needed to build the manager prompt
 */
export interface ManagerPromptContext {
  subagents: SubagentInfo[];
  storeName?: string | undefined;
  schedule?: ScheduleInfo | undefined;
}
