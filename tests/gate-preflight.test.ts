import { describe, expect, it } from 'bun:test';
import {
  attachCommandToPendingGate,
  validateEffectfulGatePlan,
} from '../src/runner/gate-preflight';

const patterns = ['birdc reply *'];

describe('gate plan preflight', () => {
  it('accepts empty changes and a complete gated command', () => {
    expect(validateEffectfulGatePlan({ prompt: 'Review the final answer?' }, patterns)).toBeUndefined();
    expect(validateEffectfulGatePlan({
      changes: [{ content: 'birdc reply 1 "approved"' }],
    }, patterns)).toBeUndefined();
  });

  it('rejects content-only changes that would grant no command', () => {
    expect(validateEffectfulGatePlan({
      changes: [{ content: 'approved reply text' }],
    }, patterns)).toContain('would authorize no gated command');
  });

  it('requires an option-scoped gated command for every choice', () => {
    const failure = validateEffectfulGatePlan({
      options: [{ id: 'a' }, { id: 'b' }],
      changes: [
        { content: 'birdc reply 1 "A"', optionId: 'a' },
        { content: 'candidate B text', optionId: 'b' },
      ],
    }, patterns);
    expect(failure).toContain('without a gated command: b');
  });

  it('auto-attaches only to plain gates and never duplicates a command', () => {
    const plain: Record<string, unknown> = { prompt: 'Post?' };
    expect(attachCommandToPendingGate(plain, 'birdc reply 1 "A"')).toBe(true);
    expect(attachCommandToPendingGate(plain, 'birdc reply 1 "A"')).toBe(false);
    expect((plain.changes as unknown[])).toHaveLength(1);

    const pick: Record<string, unknown> = {
      prompt: 'Pick?',
      options: [{ id: 'a' }, { id: 'b' }],
    };
    expect(attachCommandToPendingGate(pick, 'birdc reply 1 "A"')).toBe(false);
    expect(pick.changes).toBeUndefined();
  });
});
