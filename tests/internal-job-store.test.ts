import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSessionStorageDir } from '../src/storage';
import {
  readInternalAgentJobRecord,
  recoverInternalCreatorSession,
  writeInternalAgentJobRecord,
} from '../src/onboarding/internal-job-store';

describe('internal agent job recovery', () => {
  let root: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-job-recovery-'));
    previousDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = path.join(root, 'data');
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('persists the host job envelope atomically', async () => {
    const record = { job: { id: '01ABC', status: 'running' }, ownerPid: 42 };
    await writeInternalAgentJobRecord(root, '01ABC', record);
    expect(await readInternalAgentJobRecord(root, '01ABC')).toEqual(record);
  });

  test('recovers a completed source from its structured checkpoint', async () => {
    const storage = await getSessionStorageDir(root);
    const sessionDir = path.join(storage, '01CHECKPOINT-internal-agent-creator');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ status: 'completed' }));
    fs.writeFileSync(path.join(sessionDir, 'structured-delivery.json'), JSON.stringify({
      kind: 'agent-source',
      name: 'Recovered agent',
      fileName: 'recovered-agent.agentuse',
      model: 'openai:gpt-5.6-luna',
      source: '---\nname: Recovered agent\nmodel: openai:gpt-5.6-luna\n---\n\nRecover work.\n',
    }));

    const recovered = await recoverInternalCreatorSession(root, '01CHECKPOINT');
    expect(recovered?.status).toBe('completed');
    if (recovered?.status === 'completed') expect(recovered.submission.fileName).toBe('recovered-agent.agentuse');
  });

  test('falls back to an accepted pre-checkpoint WAL submission', async () => {
    const storage = await getSessionStorageDir(root);
    const sessionDir = path.join(storage, '01LEGACY-internal-agent-creator');
    const source = '---\nname: Legacy agent\nmodel: openai:gpt-5.6-luna\n---\n\nRecover work.\n';
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ status: 'completed' }));
    fs.writeFileSync(path.join(sessionDir, 'effect-wal.jsonl'), [
      JSON.stringify({ event: 'tool-start', callId: 'call-1', tool: 'submit_agent_source', input: {
        name: 'Legacy agent', filename: 'legacy-agent.agentuse', source,
      } }),
      JSON.stringify({ event: 'tool-end', callId: 'call-1', tool: 'submit_agent_source', ok: true }),
      '',
    ].join('\n'));

    expect(await recoverInternalCreatorSession(root, '01LEGACY')).toEqual({
      status: 'completed',
      submission: {
        name: 'Legacy agent',
        fileName: 'legacy-agent.agentuse',
        model: 'openai:gpt-5.6-luna',
        source,
      },
    });
  });
});
