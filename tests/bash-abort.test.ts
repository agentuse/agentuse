import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBashTool } from '../src/tools/bash';
import type { EffectAuditSink } from '../src/tools/types';

class RecordingAudit implements EffectAuditSink {
  records: Array<Record<string, unknown>> = [];
  append(record: Record<string, unknown>): void {
    this.records.push(record);
  }
}

describe('bash tool abort + audit', () => {
  let projectRoot: string;
  let audit: RecordingAudit;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-abort-test-'));
    audit = new RecordingAudit();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeTool(commands: string[]) {
    return createBashTool(
      { commands },
      projectRoot,
      { projectRoot, effectAudit: audit }
    ) as any;
  }

  test('normal run: audits spawn and exit with pid and exit code', async () => {
    const tool = makeTool(['echo *']);
    const result = await tool.execute({ command: 'echo hello' }, { toolCallId: 'call-1' });

    expect(result.output).toContain('hello');
    expect(result.metadata.exitCode).toBe(0);
    expect(result.metadata.aborted).toBeUndefined();

    const spawn = audit.records.find((r) => r.event === 'bash-spawn');
    const exit = audit.records.find((r) => r.event === 'bash-exit');
    expect(spawn).toMatchObject({ event: 'bash-spawn', callId: 'call-1', command: 'echo hello' });
    expect(typeof spawn!.pid).toBe('number');
    expect(exit).toMatchObject({ event: 'bash-exit', callId: 'call-1', code: 0, timedOut: false, aborted: false });
  });

  test('abort mid-run kills the process tree before its effect lands', async () => {
    const marker = path.join(projectRoot, 'ghost-marker.txt');
    const tool = makeTool(['sleep *', 'touch *']);
    const controller = new AbortController();

    const started = Date.now();
    const resultPromise = tool.execute(
      { command: `sleep 5 && touch ${marker}` },
      { toolCallId: 'call-2', abortSignal: controller.signal }
    );
    setTimeout(() => controller.abort(), 200);

    const result = await resultPromise;
    const elapsed = Date.now() - started;

    // Killed promptly, not after the 5s sleep — and the effect never happened.
    expect(elapsed).toBeLessThan(3000);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.metadata.aborted).toBe(true);
    expect(result.output).toContain('aborted');

    const exit = audit.records.find((r) => r.event === 'bash-exit');
    expect(exit).toMatchObject({ event: 'bash-exit', callId: 'call-2', aborted: true });

    // Wait past the original effect time to prove the kill was real, not a race.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('already-aborted signal refuses to spawn at all', async () => {
    const tool = makeTool(['echo *']);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      { command: 'echo should-not-run' },
      { toolCallId: 'call-3', abortSignal: controller.signal }
    );

    expect(result.output).toContain('Command not started');
    expect(result.metadata.aborted).toBe(true);
    expect(audit.records.some((r) => r.event === 'bash-spawn')).toBe(false);
    expect(audit.records.some((r) => r.event === 'bash-refused-aborted')).toBe(true);
  });

  test('abort during async artifact preparation refuses to spawn', async () => {
    const marker = path.join(projectRoot, 'pre-spawn-marker.txt');
    const controller = new AbortController();
    let releaseArtifact!: () => void;
    let artifactEntered!: () => void;
    const entered = new Promise<void>((resolve) => { artifactEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseArtifact = resolve; });
    let discarded = false;
    const tool = createBashTool(
      { commands: ['touch *'] },
      projectRoot,
      {
        projectRoot,
        effectAudit: audit,
        toolOutputArtifacts: {
          createStream: async () => {
            artifactEntered();
            await release;
            return {
              write: () => {},
              finalize: async () => ({
                kind: 'tool-output' as const,
                path: 'unused',
                absolutePath: 'unused',
                bytes: 0,
                originalChars: 0,
              }),
              discard: async () => { discarded = true; },
            };
          },
        },
      }
    ) as any;

    const resultPromise = tool.execute(
      { command: `touch ${marker}` },
      { toolCallId: 'call-gap', abortSignal: controller.signal }
    );
    await entered;
    controller.abort();
    releaseArtifact();
    const result = await resultPromise;

    expect(result.metadata.aborted).toBe(true);
    expect(discarded).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(audit.records.some((r) => r.event === 'bash-spawn')).toBe(false);
    expect(audit.records.some((r) => r.event === 'bash-refused-aborted')).toBe(true);
  });

  test('works without an audit sink (no crash) and without an abort signal', async () => {
    const tool = createBashTool({ commands: ['echo *'] }, projectRoot, { projectRoot }) as any;
    const result = await tool.execute({ command: 'echo plain' });
    expect(result.output).toContain('plain');
    expect(result.metadata.exitCode).toBe(0);
  });
});
