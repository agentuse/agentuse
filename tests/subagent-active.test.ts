import { describe, expect, it } from 'bun:test';
import { computeSubagentActiveIds } from '../src/session/subagent-active';

const row = (sessionId: string, status: string, parentSessionId?: string) => ({
  sessionId,
  status,
  ...(parentSessionId && { parentSessionId }),
});

describe('computeSubagentActiveIds', () => {
  it('flags a suspended parent whose delegated child is running', () => {
    const ids = computeSubagentActiveIds([
      row('mgr', 'suspended'),
      row('leaf', 'running', 'mgr'),
    ]);
    expect(ids.has('mgr')).toBe(true);
    expect(ids.has('leaf')).toBe(false);
  });

  it('does NOT flag a parent whose child is suspended at its own gate', () => {
    // A child parked at an await_human gate is suspended, not running: the run is
    // blocked on a human ("awaiting approval"), not progressing in a subagent. It
    // becomes subagent-active only once the gate is decided and the child runs.
    const ids = computeSubagentActiveIds([
      row('mgr', 'suspended'),
      row('leaf', 'suspended', 'mgr'),
    ]);
    expect(ids.size).toBe(0);
  });

  it('does NOT flag a completed parent or a top-level running run', () => {
    const ids = computeSubagentActiveIds([
      row('done', 'completed'),
      row('doneChild', 'running', 'done'), // parent already ended
      row('top', 'running'),               // genuine top-level run, no parent
    ]);
    expect(ids.size).toBe(0);
  });

  it('flags every suspended ancestor under nested delegation', () => {
    // manager -> mid -> leaf, only the leaf is running.
    const ids = computeSubagentActiveIds([
      row('mgr', 'suspended'),
      row('mid', 'suspended', 'mgr'),
      row('leaf', 'running', 'mid'),
    ]);
    expect(ids.has('mgr')).toBe(true);
    expect(ids.has('mid')).toBe(true);
    expect(ids.has('leaf')).toBe(false);
  });

  it('marks a suspended ancestor through a non-suspended intermediate', () => {
    // manager(suspended) -> mid(running) -> leaf(running): mid still marks manager.
    const ids = computeSubagentActiveIds([
      row('mgr', 'suspended'),
      row('mid', 'running', 'mgr'),
      row('leaf', 'running', 'mid'),
    ]);
    expect(ids.has('mgr')).toBe(true);
  });

  it('ignores a running child pointing at a missing parent', () => {
    const ids = computeSubagentActiveIds([row('leaf', 'running', 'ghost')]);
    expect(ids.size).toBe(0);
  });

  it('terminates on a corrupt parent cycle', () => {
    const ids = computeSubagentActiveIds([
      row('a', 'suspended', 'b'),
      row('b', 'suspended', 'a'),
      row('leaf', 'running', 'a'),
    ]);
    // Both suspended nodes get marked; the depth cap prevents an infinite walk.
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
  });
});
