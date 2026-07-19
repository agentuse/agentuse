import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { createSessionLogSink, describeLogPart, LoggerTerminalPresenter, processAgentStream, type AgentChunk } from '../src/runner';
import { isSoftToolError } from '../src/runner/execution';
import { createBashTool } from '../src/tools/bash';
import { logger, runWithLogSink, type LogRecord } from '../src/utils/logger';

describe('describeLogPart (log part -> session-view entry)', () => {
  it('uses a single-line message as the title with no separate body', () => {
    expect(describeLogPart({ level: 'info', message: 'loading agent' })).toEqual({ level: 'info', title: 'loading agent' });
  });
  it('splits a multi-line message into first-line title + remaining body', () => {
    expect(describeLogPart({ level: 'error', message: 'tool failed\nstack 1\nstack 2' }))
      .toEqual({ level: 'error', title: 'tool failed', message: 'stack 1\nstack 2' });
  });
  it('defaults an unknown or missing level to info (guards the log-level-* CSS class)', () => {
    expect(describeLogPart({ level: 'bogus', message: 'x' }).level).toBe('info');
    expect(describeLogPart({ message: 'x' }).level).toBe('info');
    expect(describeLogPart({ level: 'system', message: 'x' }).level).toBe('system');
  });
  it('falls back to the level label when the message is blank', () => {
    expect(describeLogPart({ level: 'debug', message: '   ' })).toEqual({ level: 'debug', title: 'debug' });
  });
  it('trims trailing whitespace and newlines', () => {
    expect(describeLogPart({ level: 'info', message: 'one line\n' })).toEqual({ level: 'info', title: 'one line' });
  });
});

describe('isSoftToolError (soft tool-failure classification)', () => {
  it('does not fail when an error keyword only appears mid-output (the LinkedIn false positive)', () => {
    const result = '// Extract posts from LinkedIn feed\nconst x = 1; // page not found handler\nwindow.MAX_ITEMS = 5;';
    expect(isSoftToolError({ toolName: 'tools__bash' }, result)).toBe(false);
  });

  it('does not fail when the first line is a success title containing an error word', () => {
    expect(isSoftToolError({ toolName: 'tools__bash' }, '✓ Search | LinkedIn — 3 results, none unauthorized')).toBe(false);
  });

  it('fails when the result actually starts as an error', () => {
    expect(isSoftToolError({ toolName: 'tools__bash' }, 'Error: command not found: foo')).toBe(true);
  });

  it('skips skill tools whose content documents errors', () => {
    expect(isSoftToolError({ toolName: 'tools__skill_load' }, 'Error: not found')).toBe(false);
  });
});

describe('runWithLogSink (logger structured capture)', () => {
  it('captures every severity emitted within the scope, regardless of terminal level', () => {
    const records: LogRecord[] = [];
    runWithLogSink((r) => records.push(r), () => {
      logger.info('an info line');
      logger.warn('a warn line');
      logger.error('a failure', new Error('boom'));
      logger.system('a system line');
      logger.debug('a debug line'); // captured even though terminal debug is off
    });

    const byLevel = Object.fromEntries(records.map((r) => [r.level, r.message]));
    expect(byLevel.info).toBe('an info line');
    expect(byLevel.warn).toBe('a warn line');
    expect(byLevel.error).toBe('a failure: boom');
    expect(byLevel.system).toBe('a system line');
    expect(byLevel.debug).toBe('a debug line');
    expect(records.every((r) => typeof r.time === 'number')).toBe(true);
  });

  it('routes to the innermost sink so concurrent/nested runs stay isolated', () => {
    const outer: string[] = [];
    const inner: string[] = [];
    runWithLogSink((r) => outer.push(r.message), () => {
      logger.info('outer-before');
      runWithLogSink((r) => inner.push(r.message), () => {
        logger.info('inner-only');
      });
      logger.info('outer-after');
    });

    expect(outer).toEqual(['outer-before', 'outer-after']);
    expect(inner).toEqual(['inner-only']);
  });

  it('does nothing (and never throws) when no sink is attached', () => {
    expect(() => logger.info('no sink attached')).not.toThrow();
  });

  it('keeps non-TTY tool announcements out of the session sink while preserving terminal output', () => {
    const records: LogRecord[] = [];
    logger.configure({ disableTUI: true });
    logger.startCapture();
    try {
      runWithLogSink((r) => records.push(r), () => {
        logger.tool('tools__bash', { command: 'echo hello' });
        logger.tool('mcp__search__query', { query: 'hello' });
        logger.info('ordinary operational info');
      });
      const terminalOutput = logger.stopCapture();

      expect(terminalOutput).toContain('Bash: echo hello');
      expect(terminalOutput).toContain('Calling tool: search:query (MCP)');
      expect(records.map((r) => r.message)).toEqual(['ordinary operational info']);
    } finally {
      // stopCapture is idempotent enough for the assertion-failure path and
      // avoids leaking capture/config state into later tests in this process.
      logger.stopCapture();
      logger.configure({ disableTUI: false });
    }
  });

  it('keeps every terminal projection out of the session sink', () => {
    const records: LogRecord[] = [];
    const presenter = new LoggerTerminalPresenter();
    logger.configure({ disableTUI: true });
    logger.startCapture();
    try {
      runWithLogSink((record) => records.push(record), () => {
        presenter.llmStarted('demo:model');
        presenter.llmFirstToken('demo:model', 25);
        presenter.toolStarted('tools__bash', { command: 'echo hello' });
        presenter.toolFinished('hello', { duration: 5, success: true });
        presenter.warning('tool-output warning');
        presenter.text('answer');
        presenter.responseComplete();
        logger.info('real operational diagnostic');
      });

      expect(logger.stopCapture()).toContain('Bash: echo hello');
      expect(records.map((record) => record.message)).toEqual(['real operational diagnostic']);
    } finally {
      logger.stopCapture();
      logger.configure({ disableTUI: false });
    }
  });

  it('returns a blocked Bash command as structured output without a warning log', async () => {
    const records: LogRecord[] = [];
    const bash = createBashTool({ commands: ['ls *'] }, tmpdir(), { projectRoot: tmpdir() }) as any;

    const result = await runWithLogSink((record) => records.push(record), () =>
      bash.execute({ command: 'head -80' }, { toolCallId: 'blocked-call' })
    );
    // Regression guard for the former setImmediate(logger.warn(...)) path.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(JSON.parse(result.output)).toMatchObject({
      success: false,
      error: expect.stringContaining('Command blocked by agent configuration'),
    });
    expect(records).toHaveLength(0);
  });

  // Mirrors run.ts/subagent.ts: the stream is an async generator created and
  // consumed inside the sink scope. The context must survive each yield/await
  // so logs emitted between chunks (deep in the stream) are still captured.
  it('captures logs emitted across yields of an async generator consumed in-scope', async () => {
    async function* streamLike(): AsyncGenerator<number> {
      logger.info('stream: starting');
      yield 1;
      await Promise.resolve();
      logger.debug('stream: mid-flight detail');
      yield 2;
      logger.error('stream: a failure', new Error('nope'));
    }
    const records: LogRecord[] = [];
    await runWithLogSink((r) => records.push(r), async () => {
      for await (const _chunk of streamLike()) { /* drain the stream */ }
    });
    expect(records.map((r) => `${r.level}:${r.message}`)).toEqual([
      'info:stream: starting',
      'debug:stream: mid-flight detail',
      'error:stream: a failure: nope',
    ]);
  });
});

async function makeSessionWithMessage(projectRoot: string) {
  const sessionManager = new SessionManager();
  const sessionID = await sessionManager.createSession({
    agent: { id: 'agents/review', name: 'review', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageID = await sessionManager.createMessage(sessionID, 'agents/review', {
    user: { prompt: { task: 'do work' } },
    assistant: {
      system: [],
      modelID: 'demo:test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  return { sessionManager, sessionID, messageID };
}

async function withTempProject(prefix: string, fn: (projectRoot: string) => Promise<void>) {
  const originalXdg = process.env.XDG_DATA_HOME;
  const projectRoot = await mkdtemp(join(tmpdir(), prefix));
  process.env.XDG_DATA_HOME = projectRoot;
  try {
    await initStorage(projectRoot);
    await fn(projectRoot);
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    await rm(projectRoot, { recursive: true, force: true });
  }
}

describe('createSessionLogSink', () => {
  it('persists one structured tool record with no terminal-presentation log duplicate', async () => {
    await withTempProject('agentuse-single-tool-record-', async () => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(process.env.XDG_DATA_HOME!);
      const sink = createSessionLogSink(sessionManager, sessionID, 'agents/review', messageID);

      async function* chunks(): AsyncGenerator<AgentChunk> {
        yield {
          type: 'tool-call',
          toolName: 'tools__bash',
          toolCallId: 'blocked-call',
          toolInput: { command: 'head -80' },
          toolStartTime: 1_000,
        };
        yield {
          type: 'tool-result',
          toolName: 'tools__bash',
          toolCallId: 'blocked-call',
          toolDuration: 5,
          toolResult: '{"success":false,"error":"Command blocked"}',
          toolResultRaw: { error: 'Command blocked' },
        };
      }

      await runWithLogSink(sink.capture, () => processAgentStream(chunks(), {
        sessionManager,
        sessionID,
        agentId: 'agents/review',
        messageID,
      }));
      await sink.flush();

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      expect(parts.filter((part) => part.type === 'tool')).toHaveLength(1);
      expect(parts.filter((part) => part.type === 'log')).toHaveLength(0);
      expect((parts.find((part) => part.type === 'tool') as any).state).toMatchObject({
        status: 'error',
        error: 'Command blocked',
      });
    });
  });

  it('persists captured records as ordered log parts', async () => {
    await withTempProject('agentuse-log-sink-', async () => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(process.env.XDG_DATA_HOME!);
      const sink = createSessionLogSink(sessionManager, sessionID, 'agents/review', messageID);

      sink.capture({ level: 'info', message: 'loading agent', time: 1 });
      sink.capture({ level: 'debug', message: 'connecting to mcp', time: 2 });
      sink.capture({ level: 'error', message: 'tool failed', time: 3 });
      await sink.flush();

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const logs = parts.filter((p) => p.type === 'log') as Array<any>;
      expect(logs.map((p) => p.level)).toEqual(['info', 'debug', 'error']);
      expect(logs.map((p) => p.message)).toEqual(['loading agent', 'connecting to mcp', 'tool failed']);
      expect(logs.map((p) => p.time.start)).toEqual([1, 2, 3]);
    });
  });

  it('caps total log parts and writes a single truncation marker', async () => {
    await withTempProject('agentuse-log-cap-', async () => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(process.env.XDG_DATA_HOME!);
      const sink = createSessionLogSink(sessionManager, sessionID, 'agents/review', messageID, { limit: 3 });

      for (let i = 1; i <= 6; i++) {
        sink.capture({ level: 'debug', message: `line ${i}`, time: i });
      }
      await sink.flush();

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const logs = parts.filter((p) => p.type === 'log') as Array<any>;
      // 3 real lines + exactly one truncation marker.
      expect(logs).toHaveLength(4);
      const realLines = logs.filter((p) => p.level === 'debug');
      expect(realLines.map((p) => p.message)).toEqual(['line 1', 'line 2', 'line 3']);
      const truncation = logs.filter((p) => p.level === 'warn');
      expect(truncation).toHaveLength(1);
      expect(truncation[0].message).toContain('truncated');
    });
  });

  it('persists buffered logs even when the wrapped run throws', async () => {
    await withTempProject('agentuse-log-throw-', async () => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(process.env.XDG_DATA_HOME!);
      const sink = createSessionLogSink(sessionManager, sessionID, 'agents/review', messageID);

      let thrown: Error | undefined;
      try {
        await runWithLogSink(sink.capture, async () => {
          logger.info('before failure');
          logger.error('it broke');
          throw new Error('boom');
        });
      } catch (err) {
        thrown = err as Error;
      } finally {
        await sink.flush();
      }
      expect(thrown?.message).toBe('boom');

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const messages = (parts.filter((p) => p.type === 'log') as Array<any>).map((p) => p.message);
      expect(messages).toContain('before failure');
      expect(messages).toContain('it broke');
    });
  });

  it('stops buffering after the cap holds across repeated flushes (no unbounded growth)', async () => {
    await withTempProject('agentuse-log-cap2-', async () => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(process.env.XDG_DATA_HOME!);
      const sink = createSessionLogSink(sessionManager, sessionID, 'agents/review', messageID, { limit: 2 });

      for (let i = 1; i <= 3; i++) sink.capture({ level: 'debug', message: `a${i}`, time: i });
      await sink.flush();
      // Flooding more after the cap must not add any further parts.
      for (let i = 1; i <= 100; i++) sink.capture({ level: 'debug', message: `b${i}`, time: 100 + i });
      await sink.flush();

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const logs = parts.filter((p) => p.type === 'log');
      // 2 real lines + 1 truncation marker, and it stays there.
      expect(logs).toHaveLength(3);
    });
  });

  it('mirrors logger output into the session when wrapped with runWithLogSink', async () => {
    await withTempProject('agentuse-log-wired-', async () => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(process.env.XDG_DATA_HOME!);
      const sink = createSessionLogSink(sessionManager, sessionID, 'agents/review', messageID);

      await runWithLogSink(sink.capture, async () => {
        logger.tool('tools__bash', { command: 'echo session-file-check' });
        logger.info('run starting');
        logger.debug('verbose detail');
        await Promise.resolve();
        logger.warn('a soft warning');
      });
      await sink.flush();

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const logs = parts.filter((p) => p.type === 'log') as Array<any>;
      const messages = logs.map((p) => p.message);
      expect(messages).toContain('run starting');
      expect(messages).toContain('verbose detail');
      expect(messages).toContain('a soft warning');
      expect(messages).not.toContain('Bash: echo session-file-check');
    });
  });
});
