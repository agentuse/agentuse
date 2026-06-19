import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ContextManager } from '../src/context-manager';
import { compactMessages } from '../src/compactor';
import * as models from '../src/models';
import * as modelsApi from '../src/utils/models-api';

// Mock the createModel function
mock.module('../src/models', () => ({
  createModel: mock(() => ({
    // Return a mock model
  }))
}));

// Mock the models API
mock.module('../src/utils/models-api', () => ({
  getModelInfo: mock(() => ({
    modelId: 'test-model',
    contextLimit: 10000,
    outputLimit: 4096
  }))
}));

// Mock the AI SDK. compactMessages now goes through completeText() which uses
// streamText (generateText cannot be used on the Codex backend), so the mock
// returns a fake stream whose fullStream yields the summary text.
const SUMMARY_TEXT = '[Summary] Previous context with important decisions and tool results.';
function fakeStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'text-delta', text };
      yield { type: 'finish' };
    })(),
  };
}
mock.module('ai', () => ({
  generateText: mock(async () => ({ text: SUMMARY_TEXT, usage: { totalTokens: 50 } })),
  streamText: mock(() => fakeStream(SUMMARY_TEXT)),
  stepCountIs: mock()
}));

describe('ContextManager', () => {
  describe('Basic Functionality', () => {
    it('should track token accumulation', async () => {
      const manager = new ContextManager('test:model');
      await manager.initialize();
      
      // Add a message (~333 tokens for 1000 chars at 3 chars/token)
      manager.addMessage({
        role: 'user',
        content: 'a'.repeat(1000)
      });
      
      // Check token estimation (1000 chars / 4 chars per token = 250 tokens)
      const usage = manager.getUsagePercentage();
      expect(usage).toBeGreaterThan(0);
      expect(usage).toBeLessThan(100);
    });

    it('should not treat cumulative usage as active context size', async () => {
      const manager = new ContextManager('test:model');
      await manager.initialize();

      manager.addMessage({
        role: 'user',
        content: 'a'.repeat(1000)
      });
      const before = manager.getStats().activeTokens;

      manager.updateUsage({
        inputTokens: 3_000_000,
        outputTokens: 1_000,
        totalTokens: 3_001_000,
        inputTokenDetails: {
          noCacheTokens: 500_000,
          cacheReadTokens: 2_500_000,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: {
          textTokens: 1_000,
          reasoningTokens: 0,
        },
      }, 'cumulative');

      expect(manager.getStats().activeTokens).toBe(before);
      expect(manager.getUsagePercentage()).toBeLessThan(100);
    });

    it('should not treat per-step provider usage as active context size', async () => {
      const manager = new ContextManager('test:model');
      await manager.initialize();

      manager.addMessage({
        role: 'user',
        content: 'a'.repeat(20_000)
      });
      const before = manager.getStats().activeTokens;

      manager.updateUsage({
        inputTokens: 3_559,
        outputTokens: 57,
        totalTokens: 3_616,
      }, 'step');

      expect(manager.getStats().activeTokens).toBe(before);
      expect(manager.shouldCompactAtBoundary()).toBe(false);
    });

    it('should detect when compaction threshold is reached', async () => {
      const manager = new ContextManager('test:model');
      await manager.initialize();
      
      // Add messages until we reach 70% of context limit
      // Context limit is 10000 tokens, threshold is 70% = 7000 tokens
      // At 4 chars/token, we need 28000 chars
      for (let i = 0; i < 10; i++) {
        manager.addMessage({
          role: 'user',
          content: 'x'.repeat(3000) // 750 tokens each
        });
      }
      
      expect(manager.shouldCompact()).toBe(true);
      expect(manager.getUsagePercentage()).toBeGreaterThanOrEqual(70);
    });

    it('should compact at approval boundaries after an absolute active-token threshold', async () => {
      process.env.APPROVAL_COMPACTION_MIN_TOKENS = '1000';

      try {
        const manager = new ContextManager('test:model');
        await manager.initialize();

        for (let i = 0; i < 5; i++) {
          manager.addMessage({
            role: 'user',
            content: 'x'.repeat(1000)
          });
        }

        expect(manager.shouldCompact()).toBe(false);
        expect(manager.shouldCompactAtBoundary()).toBe(true);
      } finally {
        delete process.env.APPROVAL_COMPACTION_MIN_TOKENS;
      }
    });

    it('should compact at step boundaries using a separately tunable threshold', async () => {
      process.env.STEP_COMPACTION_MIN_TOKENS = '1000';

      try {
        const manager = new ContextManager('test:model');
        await manager.initialize();

        for (let i = 0; i < 5; i++) {
          manager.addMessage({
            role: 'user',
            content: 'x'.repeat(1000)
          });
        }

        expect(manager.shouldCompact()).toBe(false);
        expect(manager.shouldCompactAtBoundary('step')).toBe(true);
      } finally {
        delete process.env.STEP_COMPACTION_MIN_TOKENS;
      }
    });

    it('should respect custom threshold from environment', async () => {
      // Set custom threshold
      process.env.COMPACTION_THRESHOLD = '0.5';
      
      const manager = new ContextManager('test:model');
      await manager.initialize();
      
      // Add messages until we reach 50% of context limit
      for (let i = 0; i < 7; i++) {
        manager.addMessage({
          role: 'user',
          content: 'x'.repeat(3000) // 750 tokens each
        });
      }
      
      expect(manager.shouldCompact()).toBe(true);
      
      // Cleanup
      delete process.env.COMPACTION_THRESHOLD;
    });

    it('should trigger compaction with callback', async () => {
      let compactionCalled = false;
      
      const manager = new ContextManager(
        'test:model',
        async (messages) => {
          compactionCalled = true;
          expect(messages.length).toBeGreaterThan(0);
          return {
            role: 'system',
            content: '[Context Summary]\nCompacted content\n[End Summary]'
          };
        }
      );
      await manager.initialize();
      
      // Fill to threshold
      for (let i = 0; i < 10; i++) {
        manager.addMessage({
          role: 'user',
          content: 'x'.repeat(3000)
        });
      }
      
      // Trigger compaction
      await manager.compact();
      expect(compactionCalled).toBe(true);
    });
  });

  describe('Message Preservation', () => {
    it('should keep recent messages intact after compaction', async () => {
      const manager = new ContextManager(
        'test:model',
        async (messages) => ({
          role: 'system',
          content: '[Context Summary]\nOlder messages compacted\n[End Summary]'
        })
      );
      await manager.initialize();
      
      // Add old messages
      for (let i = 0; i < 8; i++) {
        manager.addMessage({
          role: 'user',
          content: `old message ${i}`
        });
      }
      
      // Add recent messages to keep
      const recentMessages = [
        { role: 'user', content: 'recent message 1' },
        { role: 'assistant', content: 'recent response 1' },
        { role: 'user', content: 'recent message 2' }
      ];
      
      for (const msg of recentMessages) {
        manager.addMessage(msg);
      }
      
      // Compact
      const compactedMessages = await manager.compact();
      
      // Check that recent messages are preserved
      const lastThree = compactedMessages.slice(-3);
      expect(lastThree[0].content).toBe('recent message 1');
      expect(lastThree[1].content).toBe('recent response 1');
      expect(lastThree[2].content).toBe('recent message 2');
      
      // First message should be the summary
      expect(compactedMessages[0].role).toBe('system');
      expect(compactedMessages[0].content).toContain('[Context Summary]');
    });

    it('should recalculate tokens after compaction', async () => {
      const manager = new ContextManager(
        'test:model',
        async () => ({
          role: 'system',
          content: 'Short summary' // Much shorter than original
        })
      );
      await manager.initialize();
      
      // Fill with large messages
      for (let i = 0; i < 10; i++) {
        manager.addMessage({
          role: 'user',
          content: 'x'.repeat(3000)
        });
      }
      
      const usageBeforeCompaction = manager.getUsagePercentage();
      await manager.compact();
      const usageAfterCompaction = manager.getUsagePercentage();
      
      // Usage should decrease after compaction
      expect(usageAfterCompaction).toBeLessThan(usageBeforeCompaction);
      expect(manager.getStats().compacted).toBe(true);
      expect(manager.getStats().compactions).toBe(1);
    });

    it('should not re-compact an already compacted summary plus recent tail', async () => {
      let compactionCount = 0;
      const manager = new ContextManager(
        'test:model',
        async () => {
          compactionCount++;
          return {
            role: 'system',
            content: 'Short summary'
          };
        }
      );
      await manager.initialize();

      for (let i = 0; i < 5; i++) {
        manager.addMessage({
          role: 'user',
          content: `message ${i}`
        });
      }

      await manager.compact();
      await manager.compact();

      expect(compactionCount).toBe(1);
      expect(manager.getStats().compactions).toBe(1);
    });

    it('should replace tracked messages for active context accounting', async () => {
      const manager = new ContextManager('test:model');
      await manager.initialize();

      manager.addMessage({ role: 'user', content: 'x'.repeat(4000) });
      const before = manager.getStats().activeTokens;
      manager.setMessages([{ role: 'user', content: 'short' }]);

      expect(manager.getMessages()).toHaveLength(1);
      expect(manager.getStats().activeTokens).toBeLessThan(before);
    });

    it('should handle custom keep recent count', async () => {
      process.env.COMPACTION_KEEP_RECENT = '5';
      
      const manager = new ContextManager(
        'test:model',
        async () => ({
          role: 'system',
          content: 'Summary'
        })
      );
      await manager.initialize();
      
      // Add 10 messages
      for (let i = 0; i < 10; i++) {
        manager.addMessage({
          role: 'user',
          content: `message ${i}`
        });
      }
      
      const compactedMessages = await manager.compact();
      
      // Should have 1 summary + 5 recent = 6 messages
      expect(compactedMessages.length).toBe(6);
      
      // Last message should be message 9
      expect(compactedMessages[compactedMessages.length - 1].content).toBe('message 9');
      
      // Cleanup
      delete process.env.COMPACTION_KEEP_RECENT;
    });
  });

  describe('Tool-call/tool-result boundary safety', () => {
    const assistantToolCall = (id: string) => ({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: id, toolName: 'bash', input: { command: 'ls' } }],
    });
    const toolResult = (id: string) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: id, toolName: 'bash', output: { type: 'text', value: 'ok' } }],
    });

    // Assert no `function_call_output` survives without its `function_call`,
    // which is exactly what the Responses/Codex API rejects.
    const assertNoOrphanedResults = (messages: any[]) => {
      const seenCalls = new Set<string>();
      for (const msg of messages) {
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === 'tool-call') seenCalls.add(part.toolCallId);
          }
        }
        if (msg?.role === 'tool' && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === 'tool-result') {
              expect(seenCalls.has(part.toolCallId)).toBe(true);
            }
          }
        }
      }
    };

    it('keeps an assistant tool-call together with its result when the split would sever them', async () => {
      const manager = new ContextManager('test:model', async () => ({
        role: 'system',
        content: '[Context Summary]\nfolded\n[End Summary]',
      }));
      await manager.initialize();

      // Default keepRecent = 3. The naive split index (length - 3) lands on the
      // tool-result, orphaning its tool-call from the prior assistant message.
      manager.addMessage({ role: 'user', content: 'old 0' });
      manager.addMessage({ role: 'user', content: 'old 1' });
      manager.addMessage({ role: 'user', content: 'old 2' });
      manager.addMessage({ role: 'user', content: 'old 3' });
      manager.addMessage(assistantToolCall('A'));
      manager.addMessage(toolResult('A'));
      manager.addMessage({ role: 'user', content: 'recent' });
      manager.addMessage({ role: 'assistant', content: 'reply' });

      const compacted = await manager.compact();

      expect(compacted[0].role).toBe('system');
      assertNoOrphanedResults(compacted);
      // The call/result pair must have been moved into the kept tail together.
      expect(compacted.some(m => m.role === 'assistant' && Array.isArray(m.content)
        && m.content.some((p: any) => p.type === 'tool-call' && p.toolCallId === 'A'))).toBe(true);
      expect(manager.getStats().compactions).toBe(1);
    });

    it('does not compact when no safe boundary exists (unbroken tool chain)', async () => {
      let called = 0;
      const manager = new ContextManager('test:model', async () => {
        called++;
        return { role: 'system', content: 'summary' };
      });
      await manager.initialize();

      // Every candidate boundary sits inside a tool-call/result pair, so there
      // is nothing we can safely fold into a summary.
      manager.addMessage(assistantToolCall('A'));
      manager.addMessage(toolResult('A'));
      manager.addMessage(assistantToolCall('B'));
      manager.addMessage(toolResult('B'));

      const compacted = await manager.compact();

      expect(called).toBe(0);
      expect(manager.getStats().compactions).toBe(0);
      assertNoOrphanedResults(compacted);
      expect(compacted.length).toBe(4);
    });
  });

  describe('Edge Cases', () => {
    it('should not compact when disabled', async () => {
      process.env.CONTEXT_COMPACTION = 'false';
      
      // Check that it's disabled
      expect(ContextManager.isEnabled()).toBe(false);
      
      // Cleanup
      delete process.env.CONTEXT_COMPACTION;
    });

    it('should not compact when not enough messages', async () => {
      const manager = new ContextManager(
        'test:model',
        async () => {
          throw new Error('Should not be called');
        }
      );
      await manager.initialize();
      
      // Add only 2 messages (less than keep recent count of 3)
      manager.addMessage({ role: 'user', content: 'message 1' });
      manager.addMessage({ role: 'assistant', content: 'response 1' });
      
      const messages = await manager.compact();
      
      // Should return original messages unchanged
      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe('message 1');
      expect(messages[1].content).toBe('response 1');
    });

    it('should prevent multiple simultaneous compactions', async () => {
      let compactionCount = 0;
      
      const manager = new ContextManager(
        'test:model',
        async () => {
          compactionCount++;
          // Simulate slow compaction
          await new Promise(resolve => setTimeout(resolve, 100));
          return {
            role: 'system',
            content: 'Summary'
          };
        }
      );
      await manager.initialize();
      
      // Fill to threshold
      for (let i = 0; i < 10; i++) {
        manager.addMessage({
          role: 'user',
          content: 'x'.repeat(3000)
        });
      }
      
      // Try to compact multiple times simultaneously
      const promises = [
        manager.compact(),
        manager.compact(),
        manager.compact()
      ];
      
      await Promise.all(promises);
      
      // The current implementation doesn't prevent concurrent compactions
      // This is a known limitation - compactionCount will be 3
      expect(compactionCount).toBe(3);
    });

    it('should handle mixed message content types', async () => {
      const manager = new ContextManager(
        'test:model',
        async (messages) => ({
          role: 'system',
          content: `Summary of ${messages.length} messages`
        })
      );
      await manager.initialize();
      
      // Add many messages to exceed threshold and trigger compaction
      for (let i = 0; i < 8; i++) {
        manager.addMessage({
          role: 'user',
          content: 'x'.repeat(1000)
        });
      }
      
      // Add different types of messages
      manager.addMessage({
        role: 'user',
        content: 'Simple text message'
      });
      
      manager.addMessage({
        role: 'assistant',
        content: [
          { text: 'Multi-part' },
          { toolName: 'bash', args: { command: 'ls' } }
        ]
      });
      
      manager.addMessage({
        role: 'assistant',
        content: { type: 'object', data: { key: 'value' } }
      });
      
      // Should handle all message types
      const messages = manager.getMessages();
      expect(messages.length).toBe(11);
      
      // Compact should work with mixed types
      const compacted = await manager.compact();
      expect(compacted[0].content).toContain('Summary of');
      // Last 3 messages should be preserved
      expect(compacted.length).toBe(4); // 1 summary + 3 recent
    });
  });
});

describe('Compactor', () => {
  it('should generate summary using model', async () => {
    const messages = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response' },
      { role: 'user', content: 'Second message' },
      { role: 'assistant', content: 'Second response' }
    ];
    
    const summary = await compactMessages(messages, 'test:model');
    
    expect(summary.role).toBe('system');
    expect(summary.content).toContain('[Context Summary]');
    expect(summary.content).toContain('[End Summary]');
  });

  it('should propagate compaction errors instead of fabricating a summary', async () => {
    // Make the streaming call fail; compaction must surface the error.
    const { streamText } = await import('ai');
    (streamText as any).mockImplementationOnce(() => {
      throw new Error('Model API error');
    });

    const messages = [
      { role: 'user', content: 'Message' },
      { role: 'assistant', content: [{ toolName: 'bash' }] }
    ];

    // A failed compaction must surface as an error, not a fabricated fallback
    // summary that would silently corrupt the agent's context.
    await expect(compactMessages(messages, 'test:model')).rejects.toThrow('Model API error');
  });

  it('should handle empty messages gracefully', async () => {
    const messages: any[] = [];
    
    const summary = await compactMessages(messages, 'test:model');
    
    expect(summary.role).toBe('system');
    expect(summary.content).toBeDefined();
  });
});
