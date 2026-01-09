import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { Tool } from 'ai';
import { discoverSkills } from './discovery.js';
import { parseSkillContent } from './parser.js';
import { validateAllowedTools } from './validate.js';
import type { SkillInfo } from './types.js';
import type { ToolsConfig } from '../tools/types.js';
import { PathValidator, resolveRealPath } from '../tools/path-validator.js';
import { logger } from '../utils/logger.js';

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

/**
 * Substitute ${skillDir} variable in skill content
 */
function substituteSkillVariables(content: string, directory: string): string {
  return content.replace(/\$\{skillDir\}/g, directory);
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
  // Substitute ${skillDir} with actual directory path
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
  agentToolsConfig: ToolsConfig | undefined
): Promise<SkillToolsResult> {
  // Discover all available skills
  const skillsMap = await discoverSkills(projectRoot);
  const skills = Array.from(skillsMap.values());

  // Track loaded skills: name -> directory (shared between both tools)
  const loadedSkills = new Map<string, string>();

  // Main skill loading tool
  const skillTool: Tool = {
    description: buildToolDescription(skills),
    inputSchema: z.object({
      name: z.string().describe('Skill identifier from available_skills'),
    }),
    execute: async ({ name }: { name: string }) => {
      // Find the skill
      const skill = skillsMap.get(name);
      if (!skill) {
        const available = skills.map(s => s.name).join(', ') || 'none';
        throw new Error(`Skill "${name}" not found. Available skills: ${available}`);
      }

      // Load full skill content
      const skillContent = await parseSkillContent(skill.location);

      // Track loaded skill directory for skill_read tool
      loadedSkills.set(name, skillContent.directory);

      // Validate allowed-tools
      const unsatisfied = validateAllowedTools(skillContent.allowedTools, agentToolsConfig);

      // Log warning to console for user visibility
      if (unsatisfied.length > 0) {
        const toolsList = unsatisfied.map(r => r.pattern).join(', ');
        logger.warn(`Skill "${name}" requires tools not configured: ${toolsList}`);
        for (const r of unsatisfied) {
          logger.warn(`  - ${r.pattern}: ${r.reason}`);
        }
      }

      // Format output with simple flag for LLM
      const warning = unsatisfied.length > 0
        ? `> ⚠️ WARNING: This skill requires tools not available: ${unsatisfied.map(r => r.pattern).join(', ')}. Do not attempt to use these tools.`
        : null;

      const output = formatSkillOutput(
        skillContent.name,
        skillContent.directory,
        skillContent.content,
        warning
      );

      return output;
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
