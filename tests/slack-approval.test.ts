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

  it('renders the default Slack message as a compact review link', () => {
    const request = {
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      projectId: 'project-1',
      prompt: 'Approve this deployment?',
      summary: 'Deploying the release candidate',
      draft: 'Release candidate v1.2.3',
      resumeToken: 'resume-token',
      approvalUrl: 'https://agentuse.example.com/approvals/session-1?token=resume-token',
      expiresAt: new Date(0).toISOString()
    };

    const blocks = __testing.buildReviewLinkBlocks(request);
    const text = JSON.stringify(blocks);
    const actionsBlock = blocks.find((block: any) => block.type === 'actions') as any;

    expect(text).toContain('Approve this deployment?');
    expect(text).toContain('project-1');
    expect(text).not.toContain('Release candidate v1.2.3');
    expect(actionsBlock.elements).toHaveLength(1);
    expect(actionsBlock.elements[0]).toMatchObject({
      type: 'button',
      url: request.approvalUrl
    });
  });

  it('omits expiration from compact Slack messages when approval is unlimited', () => {
    const blocks = __testing.buildReviewLinkBlocks({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this deployment?',
      resumeToken: 'resume-token',
      approvalUrl: 'https://agentuse.example.com/approvals/session-1?token=resume-token'
    });
    const text = JSON.stringify(blocks);

    expect(text).not.toContain('*Expires*');
  });

  it('renders compact Slack status updates without review details', () => {
    const blocks = __testing.buildReviewStatusBlocks({
      prompt: 'Approve this deployment?',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'completed',
      decision: 'approve',
      approvalUrl: 'https://agentuse.example.com/approvals/session-1?token=resume-token',
      expiresAt: new Date(0).toISOString()
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain('AgentUse approval completed');
    expect(text).toContain('approve');
    expect(text).not.toContain('Review approval');
  });

  it('renders resume failures into the channel status card', () => {
    const blocks = __testing.buildStatusBlocks({
      phase: 'failed',
      prompt: 'Approve this deployment?',
      sessionId: 'session-1',
      decision: 'approve',
      error: new Error('ModelMessage schema mismatch'),
      reviewer: { id: 'U123' }
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain('AgentUse approval failed');
    expect(text).toContain('session-1');
    expect(text).toContain('<@U123>');
    expect(text).toContain('ModelMessage schema mismatch');
  });

  it('adds actionable context for Slack channel_not_found errors', () => {
    const message = __testing.slackApprovalPostErrorMessage('C123', {
      data: { error: 'channel_not_found' }
    });

    expect(message).toContain('C123');
    expect(message).toContain('SLACK_BOT_TOKEN');
    expect(message).toContain('private channels');
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
        ts: '222.333',
        thread_ts: '111.222'
      },
      user: { id: 'U123' },
      team: { id: 'T123' },
      actions: [{
        action_id: 'agentuse_approval_action_0_approve',
        value: JSON.stringify({
          sessionId: 'session-1',
          resumeToken: 'resume-token',
          rootChannelId: 'C123',
          rootMessageTs: '111.222',
          prompt: 'Approve this deployment?',
          action: 'approve'
        })
      }]
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      channel: 'C123',
      ts: '111.222',
      text: 'AgentUse approval resuming'
    });
    expect(JSON.stringify(updates[0].blocks)).toContain('Status');
    expect(JSON.stringify(updates[0].blocks)).toContain('resuming');
    expect(updates[1]).toMatchObject({
      channel: 'C123',
      ts: '222.333',
      text: 'AgentUse approval received: approve'
    });
    expect(decisionStarted).toBe(true);

    releaseDecision();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(updates).toHaveLength(3);
    expect(updates[2]).toMatchObject({
      channel: 'C123',
      ts: '111.222',
      text: 'AgentUse approval completed'
    });
  });

  it('starts resumed execution without waiting for Slack message updates', async () => {
    let decisionStarted = false;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => {
        decisionStarted = true;
      }
    });

    const updates: any[] = [];
    const releaseUpdates: Array<() => void> = [];
    (socket as any).web.chat.update = async (payload: any) => {
      updates.push(payload);
      if (updates.length <= 2) {
        await new Promise<void>(resolve => {
          releaseUpdates.push(resolve);
        });
      }
      return { ok: true };
    };

    await (socket as any).handleBlockAction({
      channel: { id: 'C123' },
      message: {
        ts: '222.333',
        thread_ts: '111.222'
      },
      user: { id: 'U123' },
      team: { id: 'T123' },
      actions: [{
        action_id: 'agentuse_approval_action_0_approve',
        value: JSON.stringify({
          sessionId: 'session-1',
          resumeToken: 'resume-token',
          rootChannelId: 'C123',
          rootMessageTs: '111.222',
          prompt: 'Approve this deployment?',
          action: 'approve'
        })
      }]
    });

    expect(decisionStarted).toBe(true);
    expect(updates).toHaveLength(2);

    for (const release of releaseUpdates) release();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(updates).toHaveLength(3);
    expect(updates[2]).toMatchObject({
      channel: 'C123',
      ts: '111.222',
      text: 'AgentUse approval completed'
    });
  });
});
