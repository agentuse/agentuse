import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { connectMCP } from '../src/mcp';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MCP stdio working directory', () => {
  it('launches the server in the logical run cwd instead of the daemon cwd', async () => {
    const runCwd = await mkdtemp(join(tmpdir(), 'agentuse-mcp-cwd-'));
    tempDirs.push(runCwd);
    const serverPath = join(import.meta.dir, 'fixtures', 'mcp-cwd-server.mjs');

    const connections = await connectMCP(
      {
        probe: {
          command: process.execPath,
          args: [serverPath, runCwd],
        },
      },
      false,
      undefined,
      runCwd
    );

    expect(connections).toHaveLength(1);
    await Promise.all(connections.map(({ client }) => client.close()));
  });
});
