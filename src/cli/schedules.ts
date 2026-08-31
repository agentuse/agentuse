import { Command } from 'commander';
import chalk from 'chalk';
import { glob } from 'glob';
import { relative, resolve } from 'node:path';
import { parseAgent } from '../parser.js';
import { formatScheduleHuman } from '../scheduler/parser.js';
import { loadPausedSchedules, normalizeScheduleAgentPath, setSchedulePaused } from '../scheduler/state.js';
import { resolveLocalAgentPath, resolveProjectContext } from '../utils/project.js';
import { findServerForProject, type ServerEntry } from '../utils/server-registry.js';

async function notifyRunningServer(server: ServerEntry, projectRoot: string, agentPath: string, paused: boolean): Promise<void> {
  const project = server.projects?.find((entry) => resolve(entry.root) === resolve(projectRoot));
  if (!project) return;
  const host = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.AGENTUSE_API_KEY) headers.Authorization = `Bearer ${process.env.AGENTUSE_API_KEY}`;
  const response = await fetch(`http://${host}:${server.port}/api/schedules/state`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project: project.id, path: agentPath, paused }),
  });
  if (!response.ok) throw new Error(`running daemon returned ${response.status}`);
}

async function setAgentScheduleState(rawAgent: string, paused: boolean): Promise<void> {
  const agentFile = resolveLocalAgentPath(rawAgent);
  if (!agentFile) throw new Error(`Agent file not found: ${rawAgent}`);
  const projectRoot = resolveProjectContext(process.cwd(), { agentFilePath: agentFile }).stateRoot;
  const parsed = await parseAgent(agentFile);
  if (!parsed.config.schedule) throw new Error(`${relative(projectRoot, agentFile)} does not declare a schedule`);
  const agentPath = normalizeScheduleAgentPath(relative(projectRoot, agentFile));
  await setSchedulePaused(projectRoot, agentPath, paused);
  const server = findServerForProject(projectRoot);
  if (server) {
    try {
      await notifyRunningServer(server, projectRoot, agentPath, paused);
    } catch (error) {
      console.error(chalk.yellow(`Saved locally, but the running daemon was not updated: ${(error as Error).message}`));
    }
  }
  console.log(`${paused ? 'Paused' : 'Resumed'} ${agentPath}`);
}

async function runScheduleStateCommand(rawAgent: string, paused: boolean): Promise<void> {
  try {
    await setAgentScheduleState(rawAgent, paused);
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exitCode = 1;
  }
}

export function createSchedulesCommand(): Command {
  const command = new Command('schedules')
    .description('List, pause, or resume project schedules')
    .action(async () => {
      const projectRoot = resolveProjectContext(process.cwd()).projectRoot;
      const paused = await loadPausedSchedules(projectRoot);
      const files = (await glob('**/*.agentuse', {
        cwd: projectRoot,
        absolute: true,
        ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      })).sort();
      const rows: Array<{ path: string; cadence: string; state: string }> = [];
      for (const file of files) {
        try {
          const agent = await parseAgent(file);
          if (!agent.config.schedule) continue;
          const path = normalizeScheduleAgentPath(relative(projectRoot, file));
          rows.push({
            path,
            cadence: formatScheduleHuman(agent.config.schedule),
            state: paused.has(path) ? 'paused' : 'active',
          });
        } catch {
          // The agents command owns parser diagnostics; schedules lists valid schedules only.
        }
      }
      if (rows.length === 0) {
        console.log(chalk.dim('No scheduled agents in this project.'));
        return;
      }
      for (const row of rows) console.log(`${row.state.padEnd(7)}  ${row.path}  ${chalk.dim(row.cadence)}`);
    });

  command.command('pause <agent>').description('Pause one schedule on this deployment').action(async (agent: string) => {
    await runScheduleStateCommand(agent, true);
  });
  command.command('resume <agent>').description('Resume one paused schedule on this deployment').action(async (agent: string) => {
    await runScheduleStateCommand(agent, false);
  });
  return command;
}
