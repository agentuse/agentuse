// Types
export type {
  SkillInfo,
  SkillContent,
  SkillFrontmatter,
  ToolValidationResult,
} from './types.js';
export { SkillFrontmatterSchema } from './types.js';

// Discovery
export { discoverSkills, discoverSkillsInDirectories, getSkill, getAllSkills, getDiscoveryDirectories } from './discovery.js';

// Parser
export { parseSkillFrontmatter, parseSkillContent } from './parser.js';

// Validation
export { validateAllowedTools, formatToolsWarning } from './validate.js';

// Tool
export { createSkillTool, createSkillTools, loadSkillPromptOutputs } from './tool.js';
export type { SkillPromptOutput, SkillToolsOptions, SkillToolsResult } from './tool.js';

// Config/allow expansion
export {
  SkillsConfigSchema,
  defaultSkillsConfig,
  getExplicitSkillNames,
  getGrantedSkillAllows,
  hasFullSkillGrant,
} from './config.js';
export type { NormalizedSkillsConfig, SkillGrantConfig } from './config.js';
export {
  expandSkillAllows,
} from './capabilities.js';

export { extractSkillCommandMentions } from './command-extract.js';
export type { SkillCommandMention } from './command-extract.js';
