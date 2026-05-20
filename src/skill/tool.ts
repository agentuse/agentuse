import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import type { Tool } from 'ai';
import { discoverSkills } from './discovery.js';
import { parseSkillContent } from './parser.js';
import { validateAllowedTools } from './validate.js';
import type { SkillContent, SkillInfo } from './types.js';
import type { ToolsConfig } from '../tools/types.js';
import { PathValidator, resolveRealPath } from '../tools/path-validator.js';

// Script file extensions that would need bash access
const SCRIPT_EXTENSIONS = ['.sh', '.py', '.js', '.ts', '.rb', '.pl', '.php'];

/**
 * Check if a directory contains any script files
 */
async function hasScriptFiles(dir: string): Promise<boolean> {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) {
        const ext = path.extname(file.name).toLowerCase();
        if (SCRIPT_EXTENSIONS.includes(ext)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a skill directory is accessible via bash allowedPaths.
 * Only warns if the skill contains script files.
 * Returns warning message if not accessible, null if OK.
 */
async function checkSkillPathAccess(
  skillDir: string,
  toolsConfig: ToolsConfig | undefined,
  projectRoot: string
): Promise<string | null> {
  // If no bash configured, no warning needed
  if (!toolsConfig?.bash) {
    return null;
  }

  // Check if skill has any script files - if not, no warning needed
  if (!(await hasScriptFiles(skillDir))) {
    return null;
  }

  // Check if skillDir is within projectRoot (always allowed)
  const relativeToProject = path.relative(projectRoot, skillDir);
  if (!relativeToProject.startsWith('..') && !path.isAbsolute(relativeToProject)) {
    return null;
  }

  // Check allowedPaths
  const allowedPaths = toolsConfig.bash.allowedPaths ?? [];

  // Check if skill directory is covered by any allowedPath
  for (const allowedPath of allowedPaths) {
    // Resolve ~ and ${...} placeholders
    let resolved = allowedPath;

    if (resolved.startsWith('~')) {
      resolved = resolved.replace(/^~/, os.homedir());
    }

    // Check if skillDir is within this allowed path
    const relative = path.relative(resolved, skillDir);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return null;
    }
  }

  // Convert to ~ notation if it's in home directory
  const homeDir = os.homedir();
  const displayPath = skillDir.startsWith(homeDir)
    ? skillDir.replace(homeDir, '~')
    : skillDir;

  return `Skill directory outside allowed bash paths. Add "${displayPath}" to tools.bash.allowedPaths`;
}

/**
 * Build the available skills XML block for tool description
 */
function buildAvailableSkillsXml(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return '<available_skills>\n  (No skills available)\n</available_skills>';
  }

  const skillEntries = skills.map(skill =>
    `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`
  ).join('\n');

  return `<available_skills>\n${skillEntries}\n</available_skills>`;
}

/**
 * Build the tool description with available skills
 */
function buildToolDescription(skills: SkillInfo[]): string {
  return [
    'Load a skill to get detailed instructions for a specific task.',
    'Skills provide specialized knowledge and step-by-step guidance.',
    'Use this when a task matches an available skill\'s description.',
    '',
    buildAvailableSkillsXml(skills),
  ].join('\n');
}

const SKILL_DIRECTORY_VARIABLES = [
  '${skillDir}', // Legacy AgentUse placeholder
  '${SKILL_DIR}', // Generic/cross-agent convention
  '${CLAUDE_SKILL_DIR}', // Claude Code compatibility
];

/**
 * Substitute skill directory variables in skill content
 */
function substituteSkillVariables(content: string, directory: string): string {
  let resolved = content;
  for (const variable of SKILL_DIRECTORY_VARIABLES) {
    resolved = resolved.replaceAll(variable, directory);
  }
  return resolved;
}

/**
 * Format the skill output with base directory and optional warnings
 */
function formatSkillOutput(
  name: string,
  directory: string,
  content: string,
  warning: string | null
): string {
  // Substitute skill directory placeholders with the actual directory path
  const resolvedContent = substituteSkillVariables(content, directory);

  const parts = [
    `## Skill: ${name}`,
    '',
    `**Base directory**: ${directory}`,
  ];

  if (warning) {
    parts.push('', warning);
  }

  parts.push('', resolvedContent);

  return parts.join('\n');
}

async function buildSkillOutput(
  skillContent: SkillContent,
  agentToolsConfig: ToolsConfig | undefined,
  projectRoot: string
): Promise<string> {
  const pathWarning = await checkSkillPathAccess(
    skillContent.directory,
    agentToolsConfig,
    projectRoot
  );

  const unsatisfied = validateAllowedTools(skillContent.allowedTools, agentToolsConfig);
  const warnings: string[] = [];

  if (pathWarning) {
    warnings.push(`> ⚠️ WARNING: ${pathWarning}`);
  }

  if (unsatisfied.length > 0) {
    warnings.push(`> ⚠️ WARNING: This skill requires tools not available: ${unsatisfied.map(r => r.pattern).join(', ')}. Do not attempt to use these tools.`);
  }

  return formatSkillOutput(
    skillContent.name,
    skillContent.directory,
    skillContent.content,
    warnings.length > 0 ? warnings.join('\n\n') : null
  );
}

/**
 * Result type for createSkillTools
 */
export interface SkillToolsResult {
  /** The main skill loading tool */
  skillTool: Tool;
  /** Tool to read files from loaded skill directories */
  skillReadTool: Tool;
  /** List of discovered skills */
  skills: SkillInfo[];
}

export interface SkillToolsOptions {
  /** Whether all discovered skills should be visible for on-demand loading */
  auto?: boolean | undefined;
  /** Explicit skill names that should be visible and marked loaded for skill_read */
  explicitSkillNames?: string[] | undefined;
}

export interface SkillPromptOutput {
  name: string;
  output: string;
}

/**
 * Create the skill tool (backward compatibility wrapper)
 */
export async function createSkillTool(
  projectRoot: string,
  agentToolsConfig: ToolsConfig | undefined
): Promise<{ tool: Tool; skills: SkillInfo[] }> {
  const { skillTool, skills } = await createSkillTools(projectRoot, agentToolsConfig);
  return { tool: skillTool, skills };
}

/**
 * Create both skill tools: skill loader and skill file reader
 */
export async function createSkillTools(
  projectRoot: string,
  agentToolsConfig: ToolsConfig | undefined,
  options: SkillToolsOptions = {}
): Promise<SkillToolsResult> {
  // Discover all available skills
  const skillsMap = await discoverSkills(projectRoot);
  const explicitSkillNames = options.explicitSkillNames ?? [];
  const availableSkillsMap = options.auto === false
    ? new Map(explicitSkillNames.map((name) => [name, skillsMap.get(name)]).filter((entry): entry is [string, SkillInfo] => Boolean(entry[1])))
    : skillsMap;
  const skills = Array.from(availableSkillsMap.values());

  // Track loaded skills: name -> directory (shared between both tools)
  const loadedSkills = new Map<string, string>();
  for (const name of explicitSkillNames) {
    const skill = skillsMap.get(name);
    if (!skill) continue;
    const skillContent = await parseSkillContent(skill.location);
    loadedSkills.set(name, skillContent.directory);
  }

  // Main skill loading tool
  const skillTool: Tool = {
    description: buildToolDescription(skills),
    inputSchema: z.object({
      name: z.string().describe('Skill identifier from available_skills'),
    }),
    execute: async ({ name }: { name: string }) => {
      // Find the skill
      const skill = availableSkillsMap.get(name);
      if (!skill) {
        const available = skills.map(s => s.name).join(', ') || 'none';
        throw new Error(`Skill "${name}" not found. Available skills: ${available}`);
      }

      // Load full skill content
      const skillContent = await parseSkillContent(skill.location);

      // Track loaded skill directory for skill_read tool
      loadedSkills.set(name, skillContent.directory);

      return buildSkillOutput(skillContent, agentToolsConfig, projectRoot);
    },
  };

  // Skill file reader tool - reads files from loaded skill directories
  const skillReadTool: Tool = {
    description: [
      'Read a file from a loaded skill directory.',
      'The skill must be loaded first using the skill tool.',
      'Use this to access helper scripts, data files, or other resources bundled with skills.',
    ].join('\n'),
    inputSchema: z.object({
      skill: z.string().describe('Name of the skill (must be already loaded)'),
      path: z.string().describe('Relative path to file within the skill directory'),
    }),
    execute: async ({ skill, path: filePath }: { skill: string; path: string }) => {
      // Check if skill is loaded
      const skillDir = loadedSkills.get(skill);
      if (!skillDir) {
        const loaded = Array.from(loadedSkills.keys()).join(', ') || 'none';
        throw new Error(`Skill "${skill}" has not been loaded yet. Load it first using the skill tool. Currently loaded skills: ${loaded}`);
      }

      // Reject absolute paths
      if (path.isAbsolute(filePath)) {
        throw new Error('Absolute paths are not allowed. Use a relative path within the skill directory.');
      }

      // Resolve skill directory to real path (handles macOS /var -> /private/var symlinks)
      const realSkillDir = resolveRealPath(skillDir);

      // Use PathValidator to validate the path (handles path traversal, symlinks, sensitive files)
      const validator = new PathValidator(
        [{ path: realSkillDir, permissions: ['read'] }],
        { projectRoot: realSkillDir }
      );

      // Resolve relative to skill directory
      const resolvedPath = path.resolve(realSkillDir, filePath);
      const validation = validator.validate(resolvedPath, 'read');

      if (!validation.allowed) {
        throw new Error(validation.error ?? 'Access denied');
      }

      // Read the file
      try {
        const content = await fs.readFile(validation.resolvedPath, 'utf-8');
        return {
          skill,
          path: filePath,
          resolvedPath: validation.resolvedPath,
          content,
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          throw new Error(`File not found: ${filePath} (in skill directory: ${skillDir})`);
        }
        if (err.code === 'EISDIR') {
          throw new Error(`Cannot read directory: ${filePath}. Please specify a file path.`);
        }
        throw new Error(`Failed to read file: ${err.message}`);
      }
    },
  };

  return { skillTool, skillReadTool, skills };
}

export async function loadSkillPromptOutputs(
  projectRoot: string,
  agentToolsConfig: ToolsConfig | undefined,
  names: string[]
): Promise<SkillPromptOutput[]> {
  if (names.length === 0) {
    return [];
  }

  const skillsMap = await discoverSkills(projectRoot);
  const outputs: SkillPromptOutput[] = [];

  for (const name of names) {
    const skill = skillsMap.get(name);
    if (!skill) {
      const available = Array.from(skillsMap.keys()).sort().join(', ') || 'none';
      throw new Error(`Explicit skill "${name}" not found. Available skills: ${available}`);
    }

    const skillContent = await parseSkillContent(skill.location);
    outputs.push({
      name,
      output: await buildSkillOutput(skillContent, agentToolsConfig, projectRoot),
    });
  }

  return outputs;
}
