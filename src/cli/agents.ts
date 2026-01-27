import { Command } from 'commander';
import chalk from 'chalk';
import { relative, dirname } from 'path';
import { glob } from 'glob';
import { resolveProjectContext } from '../utils/project.js';
import { parseAgent } from '../parser.js';
import { formatScheduleHuman } from '../scheduler/parser.js';

interface AgentInfo {
  name: string;
  path: string;
  relativePath: string;
  dir: string;
  description: string | undefined;
  model: string;
  schedule: string | undefined;
}

/**
 * Discover all agent files in the project
 */
async function discoverAgents(projectRoot: string): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];

  try {
    const files = await glob('**/*.agentuse', {
      cwd: projectRoot,
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    });

    for (const file of files) {
      try {
        const parsed = await parseAgent(file);
        const relativePath = relative(projectRoot, file);
        agents.push({
          name: parsed.name,
          path: file,
          relativePath,
          dir: dirname(relativePath) || '.',
          description: parsed.description,
          model: parsed.config.model,
          schedule: parsed.config.schedule,
        });
      } catch {
        // Skip files that fail to parse
      }
    }
  } catch {
    // Directory not readable, skip
  }

  return agents;
}

export function createAgentsCommand(): Command {
  const agentsCommand = new Command('agents')
    .description('List available agents in the project')
    .option('-v, --verbose', 'Show model information')
    .option('-j, --json', 'Output as JSON')
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());
      const agents = await discoverAgents(projectContext.projectRoot);

      // JSON output
      if (options.json) {
        const output = {
          project: projectContext.projectRoot,
          count: agents.length,
          agents: agents.map((a) => ({
            name: a.name,
            path: a.relativePath,
            description: a.description ?? null,
            model: a.model,
            schedule: a.schedule ?? null,
          })),
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // Header
      console.log();
      console.log(chalk.bold.blue('◆ Agents'));
      console.log(chalk.gray(`  ${projectContext.projectRoot}`));
      console.log();

      if (agents.length === 0) {
        console.log(chalk.gray('  No agents found.'));
        console.log();
        return;
      }

      // Group by directory
      const grouped = new Map<string, AgentInfo[]>();
      for (const agent of agents) {
        if (!grouped.has(agent.dir)) {
          grouped.set(agent.dir, []);
        }
        grouped.get(agent.dir)!.push(agent);
      }

      // Sort directories, then sort agents by name within each directory
      const sortedDirs = [...grouped.keys()].sort();

      console.log(chalk.gray(`  ${agents.length} agents found`));
      console.log();

      for (const dir of sortedDirs) {
        const dirAgents = grouped.get(dir)!;
        dirAgents.sort((a, b) => a.name.localeCompare(b.name));

        for (const agent of dirAgents) {
          const path = chalk.cyan(agent.relativePath);
          const schedule = agent.schedule ? chalk.yellow(` ⏱ ${formatScheduleHuman(agent.schedule)}`) : '';
          const desc = agent.description ? chalk.gray(` · ${agent.description}`) : '';
          console.log(`  ${path}${schedule}${desc}`);
          if (options.verbose) {
            console.log(chalk.gray(`    model: ${agent.model}`));
          }
        }
        console.log();
      }
    });

  return agentsCommand;
}
