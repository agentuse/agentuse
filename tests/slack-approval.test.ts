import { describe, expect, it } from 'bun:test';
import { __testing } from '../src/slack/approval';

describe('Slack approval blocks', () => {
  it('uses unique action_ids for every approval button', () => {
    const blocks = __testing.buildApprovalBlocks({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this',
      resumeToken: 'resume-token',
      expiresAt: new Date(0).toISOString()
    });

    const actionsBlock = blocks.find((block: any) => block.type === 'actions') as any;
    const actionIds = actionsBlock.elements.map((element: any) => element.action_id);

    expect(actionIds).toHaveLength(3);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds.every((id: string) => id.startsWith('agentuse_approval_action_'))).toBe(true);
  });

  it('keeps custom action routing in button values', () => {
    const blocks = __testing.buildApprovalBlocks({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this',
      actions: [
        { id: 'approve now', label: 'Approve' },
        { id: 'reject now', label: 'Reject' }
      ],
      resumeToken: 'resume-token',
      expiresAt: new Date(0).toISOString()
    });

    const actionsBlock = blocks.find((block: any) => block.type === 'actions') as any;
    const values = actionsBlock.elements.map((element: any) => JSON.parse(element.value).action);

    expect(values).toEqual(['approve now', 'reject now']);
  });
});
