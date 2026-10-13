import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeAgent } from '../src/worker/run';
import { createWorkerContext } from '../src/worker/context';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session/manager';

let projectRoot: string;
const priorDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-startup-failure-'));
  process.env.XDG_DATA_HOME = join(projectRoot, 'data');
});

afterEach(async () => {
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorDataHome;
  await rm(projectRoot, { recursive: true, force: true });
});

const writeAgent = (frontmatter: string) => writeFile(join(projectRoot, 'nightly.agentuse'), `---
model: openai:gpt-5
${frontmatter}
---
Do the nightly job.
`);

async function sessionsFor(agentId: string) {
  await initStorage(projectRoot);
  const rows = await new SessionManager().listSessionsCreatedAfter(0);
  return rows.filter((row) => row.agentId === agentId).map((row) => row.session);
}

describe('fresh runs that fail during startup', () => {
  it('records a scheduled run whose MCP server cannot start as a failed session', async () => {
    await writeAgent(`mcpServers:
  broken:
    command: /definitely/not/a/real/mcp-server
    connectTimeout: 1`);

    const response = await executeAgent(createWorkerContext(), {
      id: 'req-1',
      type: 'execute',
      agentPath: './nightly.agentuse',
      projectRoot,
      trigger: 'scheduled',
    });

    expect(response.success).toBe(false);
    const sessions = await sessionsFor('nightly');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      status: 'error',
      trigger: 'scheduled',
      error: { message: expect.stringMatching(/^All MCP servers failed to connect\. Failed to connect to MCP server broken/) },
    });
  });

  it('records a missing env var on the id the caller pre-assigned', async () => {
    await writeAgent(`mcpServers:
  needs-key:
    command: /bin/true
    requiredEnvVars: [AGENTUSE_TEST_SURELY_UNSET_VAR]`);

    const response = await executeAgent(createWorkerContext(), {
      id: 'req-2',
      type: 'execute',
      agentPath: './nightly.agentuse',
      projectRoot,
      newSessionId: '01TESTSTARTUPFAILURE000000',
      trigger: 'api',
    });

    expect(!response.success && response.error.code).toBe('ENV_MISSING');
    const sessions = await sessionsFor('nightly');
    expect(sessions.map((s) => [s.id, s.status])).toEqual([['01TESTSTARTUPFAILURE000000', 'error']]);
  });
});
