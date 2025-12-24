import { Command } from 'commander';
import chalk from 'chalk';
import { homedir } from 'os';
import { join } from 'path';
import { discoverSkills } from '../skill/discovery.js';
import { resolveProjectContext } from '../utils/project.js';
import type { SkillInfo } from '../skill/types.js';

/**
 * Get the source directory label for a skill
 */
function getSourceDir(location: string, projectRoot: string): string {
  const home = homedir();
  const dirs = [
    { path: join(projectRoot, '.agentuse', 'skills'), label: '.agentuse/skills' },
    { path: join(home, '.agentuse', 'skills'), label: '~/.agentuse/skills' },
    { path: join(projectRoot, '.claude', 'skills'), label: '.claude/skills' },
    { path: join(home, '.claude', 'skills'), label: '~/.claude/skills' },
  ];

  for (const dir of dirs) {
    if (location.startsWith(dir.path)) {
      return dir.label;
    }
  }
  return 'unknown';
}

export function createSkillsCommand(): Command {
  const skillsCommand = new Command('skills')
    .description('List available skills')
    .option('-v, --verbose', 'Show skill file paths')
    .action(async (options: { verbose?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());
      const skills = await discoverSkills(projectContext.projectRoot);

      if (skills.size === 0) {
        console.log(chalk.gray('No skills found.'));
        console.log(chalk.gray('\nSkill directories searched:'));
        console.log(chalk.gray('  .agentuse/skills/'));
        console.log(chalk.gray('  ~/.agentuse/skills/'));
        console.log(chalk.gray('  .claude/skills/'));
        console.log(chalk.gray('  ~/.claude/skills/'));
        return;
      }

      // Group skills by source directory
      const grouped = new Map<string, SkillInfo[]>();
      for (const skill of skills.values()) {
        const source = getSourceDir(skill.location, projectContext.projectRoot);
        if (!grouped.has(source)) {
          grouped.set(source, []);
        }
        grouped.get(source)!.push(skill);
      }

      console.log(chalk.bold(`\nFound ${skills.size} skill(s):\n`));

      for (const [source, sourceSkills] of grouped) {
        console.log(chalk.yellow(source));
        for (const skill of sourceSkills) {
          console.log(`  ${chalk.cyan(skill.name)}`);
          console.log(chalk.gray(`    ${skill.description}`));
          if (options.verbose) {
            console.log(chalk.gray(`    ${skill.location}`));
          }
          if (skill.allowedTools?.length) {
            console.log(chalk.gray(`    tools: ${skill.allowedTools.join(', ')}`));
          }
        }
        console.log();
      }
    });

  return skillsCommand;
}
