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

  it('renders resume failures into Slack-visible blocks', () => {
    const blocks = __testing.resumeFailedBlocks({
      status: 'approve',
      sessionId: 'session-1',
      error: new Error('ModelMessage schema mismatch'),
      reviewer: { id: 'U123' }
    });

    expect(blocks[0].text.text).toContain('resume failed');
    expect(blocks[0].text.text).toContain('session-1');
    expect(blocks[0].text.text).toContain('<@U123>');
    expect(blocks[1].text.text).toContain('ModelMessage schema mismatch');
  });

  it('keeps approval context after a decision', () => {
    const originalBlocks = __testing.buildApprovalBlocks({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this deployment?',
      summary: 'Deploying the release candidate',
      draft: 'Release candidate v1.2.3',
      resumeToken: 'resume-token',
      expiresAt: new Date(0).toISOString()
    });

    const blocks = __testing.resolvedBlocks('approve', { id: 'U123' }, undefined, originalBlocks);
    const text = JSON.stringify(blocks);

    expect(blocks.some((block: any) => block.type === 'actions')).toBe(false);
    expect(text).toContain('AgentUse approval approved');
    expect(text).toContain('Approve this deployment?');
    expect(text).toContain('Deploying the release candidate');
    expect(text).toContain('Release candidate v1.2.3');
  });

  it('updates Slack before awaiting resumed execution', async () => {
    let releaseDecision!: () => void;
    let decisionStarted = false;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => {
        decisionStarted = true;
        await new Promise<void>(resolve => {
          releaseDecision = resolve;
        });
      }
    });

    const updates: any[] = [];
    (socket as any).web.chat.update = async (payload: any) => {
      updates.push(payload);
      return { ok: true };
    };

    await (socket as any).handleBlockAction({
      channel: { id: 'C123' },
      message: {
        ts: '123.456',
        blocks: __testing.buildApprovalBlocks({
          botToken: 'xoxb-test',
          channelId: 'C123',
          sessionId: 'session-1',
          prompt: 'Approve this deployment?',
          summary: 'Deploying the release candidate',
          draft: 'Release candidate v1.2.3',
          resumeToken: 'resume-token',
          expiresAt: new Date(0).toISOString()
        })
      },
      user: { id: 'U123' },
      team: { id: 'T123' },
      actions: [{
        action_id: 'agentuse_approval_action_0_approve',
        value: JSON.stringify({
          sessionId: 'session-1',
          resumeToken: 'resume-token',
          action: 'approve'
        })
      }]
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].text).toBe('AgentUse approval received: approve');
    expect(JSON.stringify(updates[0].blocks)).toContain('Release candidate v1.2.3');
    expect(decisionStarted).toBe(true);

    releaseDecision();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
