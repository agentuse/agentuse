import { describe, expect, it, spyOn } from 'bun:test';
import { processAgentStream } from '../src/runner/stream';
import type { AgentChunk } from '../src/runner/types';
import { DoomLoopDetector, DoomLoopError } from '../src/tools/doom-loop-detector';

describe('DoomLoopDetector', () => {
  it('does not trigger below threshold', () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    detector.check('bash', { command: 'echo hi' });
    const result = detector.check('bash', { command: 'echo hi' });

    expect(result.isLoop).toBe(false);
    expect(result.count).toBe(2);
  });

  it('triggers at threshold for consecutive identical calls', () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    detector.check('bash', { command: 'echo hi' });
    detector.check('bash', { command: 'echo hi' });

    expect(() => detector.check('bash', { command: 'echo hi' })).toThrow(DoomLoopError);
  });

  it('does not trigger when text exists between identical tool calls', () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    const command = 'python3 -c "import random; print(random.randint(1, 100))"';

    detector.check('bash', { command });
    detector.recordNonToolEvent();
    detector.check('bash', { command });
    detector.recordNonToolEvent();

    const result = detector.check('bash', { command });
    expect(result.isLoop).toBe(false);
    expect(result.count).toBe(1);
  });

  it('still triggers when identical calls are truly consecutive', () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    detector.check('bash', { command: 'echo stuck' });
    detector.check('bash', { command: 'echo stuck' });

    expect(() => detector.check('bash', { command: 'echo stuck' })).toThrow(DoomLoopError);
  });

  it('does not break chain for non-tool event when history is empty', () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    detector.recordNonToolEvent();

    expect(detector.getHistory()).toHaveLength(0);
  });

  it('resets consecutive count after a different tool call', () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    detector.check('bash', { command: 'echo a' });
    detector.check('bash', { command: 'echo a' });
    detector.check('bash', { command: 'echo b' });
    detector.check('bash', { command: 'echo a' });
    detector.check('bash', { command: 'echo a' });

    const result = detector.check('bash', { command: 'echo b' });
    expect(result.isLoop).toBe(false);
  });

  it('warns instead of throwing when action is warn', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const detector = new DoomLoopDetector({ threshold: 3, action: 'warn' });

    try {
      detector.check('bash', { command: 'echo hi' });
      detector.check('bash', { command: 'echo hi' });
      const result = detector.check('bash', { command: 'echo hi' });

      expect(result.isLoop).toBe(true);
      expect(result.count).toBe(3);
      expect(warnSpy).toHaveBeenCalledWith('[DoomLoopDetector] Doom loop detected: bash called 3 times with identical arguments');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('DoomLoopDetector integration with processAgentStream', () => {
  async function* makeStream(chunks: AgentChunk[]): AsyncGenerator<AgentChunk> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  const randomCommand = 'python3 -c "import random; print(random.randint(1, 100))"';

  it('does not trigger when text exists between identical tool calls', async () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    const chunks: AgentChunk[] = [
      { type: 'text', text: 'Generate a random number for profile selection.\n' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_1', toolInput: { command: randomCommand } },
      { type: 'tool-result', toolCallId: 'call_1', toolResult: '89' },
      { type: 'text', text: 'Got 89. Generate another random number for format.\n' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_2', toolInput: { command: randomCommand } },
      { type: 'tool-result', toolCallId: 'call_2', toolResult: '20' },
      { type: 'text', text: 'Got 20. Generate a random number for hook tier.\n' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_3', toolInput: { command: randomCommand } },
      { type: 'tool-result', toolCallId: 'call_3', toolResult: '55' },
      { type: 'finish', finishReason: 'stop' },
    ];

    const result = await processAgentStream(makeStream(chunks), {
      doomLoopDetector: detector,
      quiet: true,
    });

    expect(result.text).toContain('Got 89');
    expect(result.hasTextOutput).toBe(true);
  });

  it('still triggers when identical tool calls have no text between them', async () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    const chunks: AgentChunk[] = [
      { type: 'text', text: 'Try this.\n' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_1', toolInput: { command: 'cat /missing' } },
      { type: 'tool-result', toolCallId: 'call_1', toolResult: 'No such file' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_2', toolInput: { command: 'cat /missing' } },
      { type: 'tool-result', toolCallId: 'call_2', toolResult: 'No such file' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_3', toolInput: { command: 'cat /missing' } },
      { type: 'tool-result', toolCallId: 'call_3', toolResult: 'No such file' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await expect(processAgentStream(makeStream(chunks), {
      doomLoopDetector: detector,
      quiet: true,
    })).rejects.toThrow(DoomLoopError);
  });

  it('does not trigger when different tool calls are interleaved', async () => {
    const detector = new DoomLoopDetector({ threshold: 3 });
    const chunks: AgentChunk[] = [
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_1', toolInput: { command: 'echo a' } },
      { type: 'tool-result', toolCallId: 'call_1', toolResult: 'a' },
      { type: 'tool-call', toolName: 'tools__read', toolCallId: 'call_2', toolInput: { path: '/tmp/x' } },
      { type: 'tool-result', toolCallId: 'call_2', toolResult: 'contents' },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_3', toolInput: { command: 'echo a' } },
      { type: 'tool-result', toolCallId: 'call_3', toolResult: 'a' },
      { type: 'finish', finishReason: 'stop' },
    ];

    const result = await processAgentStream(makeStream(chunks), {
      doomLoopDetector: detector,
      quiet: true,
    });

    expect(result).toBeDefined();
  });
});
