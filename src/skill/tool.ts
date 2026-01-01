import { z } from 'zod';
import type { Tool } from 'ai';
import { discoverSkills } from './discovery.js';
import { parseSkillContent } from './parser.js';
import { validateAllowedTools } from './validate.js';
import type { SkillInfo } from './types.js';
import type { ToolsConfig } from '../tools/types.js';
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
 * Create the skill tool
 */
export async function createSkillTool(
  projectRoot: string,
  agentToolsConfig: ToolsConfig | undefined
): Promise<{ tool: Tool; skills: SkillInfo[] }> {
  // Discover all available skills
  const skillsMap = await discoverSkills(projectRoot);
  const skills = Array.from(skillsMap.values());

  const tool: Tool = {
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

  return { tool, skills };
}
