import { describe, expect, it } from 'bun:test';
import {
  attachCommandToPendingGate,
  validateEffectfulGateCommandSyntax,
  validateEffectfulGatePlan,
  withGatePlanPreflight,
} from '../src/runner/gate-preflight';

const patterns = ['birdc reply *'];

describe('gate plan preflight', () => {
  it('accepts empty changes and a complete gated command', () => {
    expect(validateEffectfulGatePlan({ prompt: 'Review the final answer?' }, patterns)).toBeUndefined();
    expect(validateEffectfulGatePlan({
      changes: [{ content: 'birdc reply 1 "approved"' }],
    }, patterns)).toBeUndefined();
  });

  it('rejects gated commands with unterminated shell quotes before review', async () => {
    const failure = await validateEffectfulGateCommandSyntax({
      changes: [{
        label: 'Schedule X post',
        content: `birdc reply 1 '[{"text":"approved"}]`,
      }],
    }, patterns);

    expect(failure).toContain('Schedule X post');
    expect(failure).toContain('invalid shell syntax');
  });

  it('accepts a gated command with a complete quoted JSON payload', async () => {
    const failure = await validateEffectfulGateCommandSyntax({
      changes: [{
        label: 'Schedule X post',
        content: `birdc reply 1 '[{"text":"approved"}]'`,
      }],
    }, patterns);

    expect(failure).toBeUndefined();
  });

  it('does not apply shell syntax rules to direct-argv payload commands', async () => {
    const failure = await validateEffectfulGateCommandSyntax({
      changes: [{
        content: `agent-browser eval Array.from(document.querySelectorAll('a[href*="/in/"]')).map(a=>({text:a.innerText,href:a.href}))`,
      }],
    }, ['agent-browser eval *']);

    expect(failure).toBeUndefined();
  });

  it('resolves malformed commands as machine preflight feedback without opening the gate', async () => {
    let gateExecuted = false;
    const wrapped = withGatePlanPreflight({
      execute: async () => {
        gateExecuted = true;
        throw new Error('gate should not execute');
      },
    } as any, { effectPatterns: patterns });

    const result = await wrapped.execute?.({
      prompt: 'Approve?',
      changes: [{ content: `birdc reply 1 '[{"text":"approved"}]` }],
    } as never, {} as never) as any;

    expect(gateExecuted).toBe(false);
    expect(result.source).toBe('gate-preflight');
    expect(result.comment).toContain('invalid shell syntax');
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

  it('requires binding even when the agent scoped nothing at all', () => {
    // The dangerous shape: N candidate commands, none bound. Approving one
    // option would grant a lease covering every candidate, because an unbound
    // entry survives the choice filter in deriveLeaseEntries.
    const failure = validateEffectfulGatePlan({
      options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      changes: [
        { content: 'birdc reply 1 "A"' },
        { content: 'birdc reply 1 "B"' },
        { content: 'birdc reply 1 "C"' },
      ],
    }, patterns);
    expect(failure).toContain('without a gated command: a, b, c');
  });

  it('accepts a pick gate whose every option binds its own command', () => {
    expect(validateEffectfulGatePlan({
      options: [{ id: 'a' }, { id: 'b' }],
      changes: [
        { content: 'birdc reply 1 "A"', displayContent: 'A', optionId: 'a' },
        { content: 'birdc reply 1 "B"', displayContent: 'B', optionId: 'b' },
      ],
    }, patterns)).toBeUndefined();
  });

  it('accepts the same unconditional command bound to every option', () => {
    // The escape hatch for an action that does not depend on the pick: bind it
    // to each option so the grant is explicit rather than implicitly universal.
    expect(validateEffectfulGatePlan({
      options: [{ id: 'a' }, { id: 'b' }],
      changes: [
        { content: 'birdc reply 1 "ack"', optionId: 'a' },
        { content: 'birdc reply 1 "ack"', optionId: 'b' },
      ],
    }, patterns)).toBeUndefined();
  });

  it('leaves a pick gate that authorizes nothing to the earlier check', () => {
    // Reply text only, no command anywhere: that is the "authorizes nothing"
    // failure, not a per-option binding failure.
    const failure = validateEffectfulGatePlan({
      options: [{ id: 'a' }, { id: 'b' }],
      changes: [{ content: 'candidate A text' }, { content: 'candidate B text' }],
    }, patterns);
    expect(failure).toContain('would authorize no gated command');
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
