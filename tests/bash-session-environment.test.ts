import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBashTool } from '../src/tools/bash';
import type { PathResolverContext } from '../src/tools/path-validator';

const originalSessionId = process.env.AGENTUSE_SESSION_ID;

afterEach(() => {
  if (originalSessionId === undefined) delete process.env.AGENTUSE_SESSION_ID;
  else process.env.AGENTUSE_SESSION_ID = originalSessionId;
});

async function childEnvironment(context: PathResolverContext): Promise<string> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-session-env-'));
  try {
    context.projectRoot = projectRoot;
    const tool = createBashTool({ commands: ['env'] }, projectRoot, context) as any;
    const result = await tool.execute({ command: 'env' }, { toolCallId: 'session-env' });
    expect(result.metadata.exitCode).toBe(0);
    return result.output;
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe('bash child session identity', () => {
  it('injects the authoritative AgentUse session id', async () => {
    process.env.AGENTUSE_SESSION_ID = 'stale-parent-session';
    const output = await childEnvironment({
      projectRoot: '',
      sessionId: '01CURRENTSESSION',
    });

    expect(output).toContain('AGENTUSE_SESSION_ID=01CURRENTSESSION');
    expect(output).not.toContain('AGENTUSE_SESSION_ID=stale-parent-session');
  });

  it('reads a session id bound after tool construction', async () => {
    const context: PathResolverContext = { projectRoot: '' };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-session-late-'));
    try {
      context.projectRoot = projectRoot;
      const tool = createBashTool({ commands: ['env'] }, projectRoot, context) as any;
      context.sessionId = '01LATEBOUNDSESSION';
      const result = await tool.execute({ command: 'env' }, { toolCallId: 'session-late' });

      expect(result.output).toContain('AGENTUSE_SESSION_ID=01LATEBOUNDSESSION');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes an inherited session id when no session is bound', async () => {
    process.env.AGENTUSE_SESSION_ID = 'stale-parent-session';
    const output = await childEnvironment({ projectRoot: '' });

    expect(output).not.toContain('AGENTUSE_SESSION_ID=');
  });
});
