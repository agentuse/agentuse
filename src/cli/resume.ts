import { Command } from 'commander';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import * as dotenv from 'dotenv';
import { parseAgent } from '../parser';
import { connectMCP } from '../mcp';
import { runAgent, applyResumeToolResult } from '../runner';
import { initStorage } from '../storage';
import { SessionManager } from '../session';
import { resolveProjectContext } from '../utils/project';
import { logger, LogLevel } from '../utils/logger';
import { loadGlobalEnv } from '../utils/global-config';

function parseToolResult(raw?: string): unknown {
  if (!raw) {
    throw new Error('Missing --tool-result JSON');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('--tool-result must be valid JSON');
  }
}

export function createResumeCommand(): Command {
  return new Command('resume')
    .description('Resume a suspended agent session')
    .argument('<sessionId>', 'Session ID to resume')
    .option('--tool-result <json>', 'JSON result to return to the pending await_* tool')
    .option('--resume-token <token>', 'Capability token from the suspension notifier')
    .option('-C, --directory <path>', 'Run as if agentuse was started in <path> instead of the current directory')
    .option('-d, --debug', 'Enable debug logging')
    .action(async (sessionId: string, options: { toolResult?: string; resumeToken?: string; directory?: string; debug?: boolean }) => {
      logger.configure({
        level: options.debug ? LogLevel.DEBUG : LogLevel.INFO,
        ...(options.debug && { enableDebug: true })
      });

      const cwd = options.directory ? resolve(options.directory) : process.cwd();
      const projectContext = resolveProjectContext(cwd, {
        ...(options.directory && { projectRoot: cwd })
      });

      loadGlobalEnv();
      if (existsSync(projectContext.envFile)) {
        dotenv.config({ path: projectContext.envFile });
      }

      await initStorage(projectContext.projectRoot);
      const sessionManager = new SessionManager();
      const found = await sessionManager.findSession(sessionId);
      if (!found) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (!found.session.agent.filePath) {
        throw new Error(`Session ${sessionId} does not record an agent file path`);
      }

      const toolResult = parseToolResult(options.toolResult);
      const { agentFilePath } = await applyResumeToolResult({
        sessionManager,
        sessionId,
        toolResult,
        ...(options.resumeToken && { resumeToken: options.resumeToken })
      });

      const agentPath = agentFilePath ?? found.session.agent.filePath;
      const agent = await parseAgent(agentPath);
      const mcp = await connectMCP(agent.config.mcpServers, options.debug ?? false, dirname(agentPath));

      const result = await runAgent(
        agent,
        mcp,
        options.debug ?? false,
        undefined,
        Date.now(),
        options.debug ?? false,
        agentPath,
        undefined,
        sessionManager,
        { projectRoot: projectContext.projectRoot, cwd },
        undefined,
        undefined,
        false,
        undefined,
        true,
        sessionId
      );

      console.log(JSON.stringify({
        success: true,
        sessionId,
        status: result.status ?? 'completed',
        result: {
          text: result.text,
          finishReason: result.finishReason,
          toolCalls: result.toolCallCount
        }
      }));
    });
}
