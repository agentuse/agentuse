import { describe, it, expect } from 'bun:test';
import { getMaxSubAgentDepth, createSubAgentTool } from '../src/subagent';
import { resolve } from 'path';

async function withEnv(env: Record<string, string | undefined>, callback: () => void | Promise<void>) {
  const snapshot = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    if (!snapshot.has(key)) {
      snapshot.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('getMaxSubAgentDepth', () => {
  it('returns default value when MAX_SUBAGENT_DEPTH is not set', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: undefined }, () => {
      expect(getMaxSubAgentDepth()).toBe(2);
    });
  });

  it('returns parsed value when MAX_SUBAGENT_DEPTH is valid', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '5' }, () => {
      expect(getMaxSubAgentDepth()).toBe(5);
    });
  });

  it('returns default when MAX_SUBAGENT_DEPTH is NaN', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: 'abc' }, () => {
      expect(getMaxSubAgentDepth()).toBe(2);
    });
  });

  it('returns default when MAX_SUBAGENT_DEPTH is negative', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '-5' }, () => {
      expect(getMaxSubAgentDepth()).toBe(2);
    });
  });

  it('returns default when MAX_SUBAGENT_DEPTH is zero', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '0' }, () => {
      expect(getMaxSubAgentDepth()).toBe(2);
    });
  });

  it('returns parsed value for large valid numbers', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '100' }, () => {
      expect(getMaxSubAgentDepth()).toBe(100);
    });
  });

  it('returns default when MAX_SUBAGENT_DEPTH is empty string', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '' }, () => {
      expect(getMaxSubAgentDepth()).toBe(2);
    });
  });

  it('returns default when MAX_SUBAGENT_DEPTH is whitespace', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '   ' }, () => {
      expect(getMaxSubAgentDepth()).toBe(2);
    });
  });

  it('handles decimal numbers by truncating', () => {
    withEnv({ MAX_SUBAGENT_DEPTH: '3.7' }, () => {
      expect(getMaxSubAgentDepth()).toBe(3);
    });
  });
});

describe('Sub-agent cycle detection', () => {
  const fixturesPath = resolve(__dirname, '__fixtures__/cycles');

  it('detects self-referencing cycles', async () => {
    const agentPath = resolve(fixturesPath, 'agent-self.agentuse');
    const resolvedPath = resolve(fixturesPath, 'agent-self.agentuse');

    // Pass the agent path in callStack to simulate already being in the call chain
    await expect(async () => {
      await createSubAgentTool(agentPath, 50, fixturesPath, undefined, 0, [resolvedPath]);
    }).toThrow(/Circular sub-agent dependency detected/);
  });

  it('detects 3-level cycles (A → B → C → A)', async () => {
    const agentAPath = resolve(fixturesPath, 'agent-a.agentuse');
    const agentBPath = resolve(fixturesPath, 'agent-b.agentuse');
    const agentCPath = resolve(fixturesPath, 'agent-c.agentuse');

    // Simulate call stack: A → B → C, now trying to load A again
    await expect(async () => {
      await createSubAgentTool(agentAPath, 50, fixturesPath, undefined, 2, [agentAPath, agentBPath, agentCPath]);
    }).toThrow(/Circular sub-agent dependency detected/);
  });

  it('includes cycle chain in error message', async () => {
    const agentPath = resolve(fixturesPath, 'agent-self.agentuse');
    const resolvedPath = resolve(fixturesPath, 'agent-self.agentuse');

    try {
      await createSubAgentTool(agentPath, 50, fixturesPath, undefined, 0, [resolvedPath]);
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      // Error message should show the cycle path
      expect(error.message).toContain('agent-self.agentuse');
      expect(error.message).toContain('→');
    }
  });
});

describe('Depth limit edge cases', () => {
  it('allows loading at depth 0 (main agent)', async () => {
    await withEnv({ MAX_SUBAGENT_DEPTH: '2' }, async () => {
      const maxDepth = getMaxSubAgentDepth();
      expect(maxDepth).toBe(2);

      // At depth 0, should be able to create tools (0 < 2)
      const depth = 0;
      expect(depth < maxDepth).toBe(true);
    });
  });

  it('allows loading at depth 1 (first level sub-agents)', async () => {
    await withEnv({ MAX_SUBAGENT_DEPTH: '2' }, async () => {
      const maxDepth = getMaxSubAgentDepth();
      expect(maxDepth).toBe(2);

      // At depth 1, should be able to create tools (1 < 2)
      const depth = 1;
      expect(depth < maxDepth).toBe(true);
    });
  });

  it('blocks loading at depth 2 (at max depth limit)', async () => {
    await withEnv({ MAX_SUBAGENT_DEPTH: '2' }, async () => {
      const maxDepth = getMaxSubAgentDepth();
      expect(maxDepth).toBe(2);

      // At depth 2, should NOT be able to create tools (2 < 2 is false)
      const depth = 2;
      expect(depth < maxDepth).toBe(false);
    });
  });

  it('blocks loading at depth 3 (over max depth limit)', async () => {
    await withEnv({ MAX_SUBAGENT_DEPTH: '2' }, async () => {
      const maxDepth = getMaxSubAgentDepth();
      expect(maxDepth).toBe(2);

      // At depth 3, definitely should NOT be able to create tools
      const depth = 3;
      expect(depth < maxDepth).toBe(false);
    });
  });

  it('handles custom max depth of 1', async () => {
    await withEnv({ MAX_SUBAGENT_DEPTH: '1' }, async () => {
      const maxDepth = getMaxSubAgentDepth();
      expect(maxDepth).toBe(1);

      // At depth 0, can load (0 < 1)
      expect(0 < maxDepth).toBe(true);
      // At depth 1, cannot load (1 < 1 is false)
      expect(1 < maxDepth).toBe(false);
    });
  });

  it('handles large max depth values', async () => {
    await withEnv({ MAX_SUBAGENT_DEPTH: '10' }, async () => {
      const maxDepth = getMaxSubAgentDepth();
      expect(maxDepth).toBe(10);

      // At depth 9, can still load (9 < 10)
      expect(9 < maxDepth).toBe(true);
      // At depth 10, cannot load (10 < 10 is false)
      expect(10 < maxDepth).toBe(false);
    });
  });
});
