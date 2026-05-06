import { describe, expect, it } from 'bun:test';
import { __testing } from '../src/slack/approval';

describe('Slack approval blocks', () => {
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

  it('renders approval review details as thread messages', () => {
    const messages = __testing.buildDetailThreadMessages({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this deployment?',
      summary: 'Deploying the release candidate',
      draft: 'Release candidate v1.2.3',
      artifactUrl: 'https://agentuse.example.com/artifact',
      context: 'Prepared from the staging build.',
      risk: 'Needs final reviewer confirmation.',
      resumeToken: 'resume-token'
    });
    const text = JSON.stringify(messages);

    expect(messages).toHaveLength(5);
    expect(text).toContain('Summary');
    expect(text).toContain('Release candidate v1.2.3');
    expect(text).toContain('https://agentuse.example.com/artifact');
    expect(text).toContain('Needs final reviewer confirmation.');
  });

  it('renders approval actions as a thread message targeting the root card', () => {
    const message = __testing.buildActionThreadMessage({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this deployment?',
      resumeToken: 'resume-token',
      rootChannelId: 'C123',
      rootMessageTs: '111.222'
    });
    const actionsBlock = message.blocks.find((block: any) => block.type === 'actions') as any;
    const actionIds = actionsBlock.elements.map((element: any) => element.action_id);
    const values = actionsBlock.elements.map((element: any) => JSON.parse(element.value));

    expect(message.text).toContain('Approval decision');
    expect(actionIds).toHaveLength(3);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds.every((id: string) => id.startsWith('agentuse_approval_action_'))).toBe(true);
    expect(actionsBlock.elements.map((element: any) => element.text.text)).toEqual(['Approve', 'Reject', 'Comment']);
    expect(values).toEqual([
      expect.objectContaining({ action: 'approve', rootChannelId: 'C123', rootMessageTs: '111.222' }),
      expect.objectContaining({ action: 'reject', rootChannelId: 'C123', rootMessageTs: '111.222' }),
      expect.objectContaining({ action: 'comment', rootChannelId: 'C123', rootMessageTs: '111.222' })
    ]);
  });

  it('omits Slack thread actions by default for web-first approvals', () => {
    const messages = __testing.buildApprovalThreadMessages({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this deployment?',
      summary: 'Deploying the release candidate',
      resumeToken: 'resume-token',
      approvalUrl: 'https://agentuse.example.com/approvals/session-1?token=resume-token',
      rootChannelId: 'C123',
      rootMessageTs: '111.222'
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks.some((block: any) => block.type === 'actions')).toBe(false);
  });

  it('includes Slack thread actions when interactivity is enabled', () => {
    const messages = __testing.buildApprovalThreadMessages({
      botToken: 'xoxb-test',
      channelId: 'C123',
      sessionId: 'session-1',
      prompt: 'Approve this deployment?',
      resumeToken: 'resume-token',
      approvalUrl: 'https://agentuse.example.com/approvals/session-1?token=resume-token',
      rootChannelId: 'C123',
      rootMessageTs: '111.222',
      interactive: true
    });

    expect(messages).toHaveLength(1);
    const threadActions = messages[0].blocks.find((block: any) => block.type === 'actions') as any;
    expect(threadActions.elements.map((element: any) => element.text.text)).toEqual(['Approve', 'Reject', 'Comment']);
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
    const statuses: any[] = [];
    (socket as any).web.chat.update = async (payload: any) => {
      updates.push(payload);
      return { ok: true };
    };
    (socket as any).web.apiCall = async (method: string, payload: any) => {
      statuses.push({ method, payload });
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
    expect(statuses[0]).toMatchObject({
      method: 'assistant.threads.setStatus',
      payload: {
        channel_id: 'C123',
        thread_ts: '111.222',
        status: 'is working...'
      }
    });
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
    expect(statuses.some((entry) => entry.payload.status === '')).toBe(true);
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
    (socket as any).web.apiCall = async () => ({ ok: true });

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

  it('treats plain Slack approval thread replies as comment decisions', async () => {
    let received: any;
    let acked = false;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async (comment) => {
        received = comment;
        return { handled: true };
      }
    });

    const statuses: any[] = [];
    const replies: any[] = [];
    (socket as any).web.apiCall = async (method: string, payload: any) => {
      statuses.push({ method, payload });
      return { ok: true };
    };
    (socket as any).web.chat.postMessage = async (payload: any) => {
      replies.push(payload);
      return { ok: true };
    };

    await (socket as any).handleMessageEvent({
      ack: async () => {
        acked = true;
      },
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '222.333',
        text: 'Please make the headline more specific.',
        user: 'U123',
        team: 'T123'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(acked).toBe(true);
    expect(received).toEqual({
      channel: 'C123',
      threadTs: '111.222',
      messageTs: '222.333',
      text: 'Please make the headline more specific.',
      userId: 'U123',
      teamId: 'T123'
    });
    expect(statuses[0]).toMatchObject({
      method: 'assistant.threads.setStatus',
      payload: {
        channel_id: 'C123',
        thread_ts: '111.222',
        status: 'is working...'
      }
    });
    expect(statuses.some((entry) => entry.payload.status === '')).toBe(true);
    expect(replies[0]).toMatchObject({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'AgentUse approval comment received'
    });
  });

  it('ignores Slack root messages and bot thread replies for approval comments', async () => {
    const received: any[] = [];
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async (comment) => {
        received.push(comment);
        return { handled: true };
      }
    });

    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '111.222',
        text: 'Root message',
        user: 'U123'
      }
    });
    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '222.333',
        text: 'Bot message',
        user: 'U123',
        subtype: 'bot_message'
      }
    });

    expect(received).toEqual([]);
  });

  it('does not acknowledge thread replies that are not approval threads', async () => {
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async () => ({ handled: false })
    });

    const replies: any[] = [];
    const statuses: any[] = [];
    (socket as any).web.chat.postMessage = async (payload: any) => {
      replies.push(payload);
      return { ok: true };
    };
    (socket as any).web.apiCall = async (method: string, payload: any) => {
      statuses.push({ method, payload });
      return { ok: true };
    };

    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '222.333',
        text: 'Unrelated thread reply',
        user: 'U123'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(replies).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it('continues run channel threads when approval lookup does not handle the reply', async () => {
    let runComment: any;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async () => ({ handled: false }),
      onRunThreadComment: async (comment) => {
        runComment = comment;
        return { handled: true };
      }
    });

    const replies: any[] = [];
    const statuses: any[] = [];
    (socket as any).web.chat.postMessage = async (payload: any) => {
      replies.push(payload);
      return { ok: true };
    };
    (socket as any).web.apiCall = async (method: string, payload: any) => {
      statuses.push({ method, payload });
      return { ok: true };
    };

    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '222.333',
        text: 'Can you revise the title?',
        user: 'U123'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runComment).toMatchObject({
      channel: 'C123',
      threadTs: '111.222',
      text: 'Can you revise the title?',
      userId: 'U123'
    });
    expect(replies[0]).toMatchObject({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'AgentUse run follow-up received'
    });
    expect(statuses[0]).toMatchObject({
      method: 'assistant.threads.setStatus',
      payload: {
        channel_id: 'C123',
        thread_ts: '111.222',
        status: 'is working...'
      }
    });
    expect(statuses.some((entry) => entry.payload.status === '')).toBe(true);
  });

  it('continues run channel threads from Slack message_replied events', async () => {
    let runComment: any;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async () => ({ handled: false }),
      onRunThreadComment: async (comment) => {
        runComment = comment;
        return { handled: true };
      }
    });

    const replies: any[] = [];
    (socket as any).web.conversations.replies = async (payload: any) => ({
      ok: true,
      messages: [{
        type: 'message',
        channel: payload.channel,
        thread_ts: payload.ts,
        ts: '222.333',
        text: 'Actually add Hello World to the title',
        user: 'U123'
      }]
    });
    (socket as any).web.chat.postMessage = async (payload: any) => {
      replies.push(payload);
      return { ok: true };
    };
    (socket as any).web.apiCall = async () => ({ ok: true });

    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        subtype: 'message_replied',
        channel: 'C123',
        message: {
          type: 'message',
          ts: '111.222',
          thread_ts: '111.222',
          latest_reply: '222.333',
          replies: [{ user: 'U123', ts: '222.333' }]
        }
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runComment).toMatchObject({
      channel: 'C123',
      threadTs: '111.222',
      messageTs: '222.333',
      text: 'Actually add Hello World to the title',
      userId: 'U123'
    });
    expect(replies[0]).toMatchObject({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'AgentUse run follow-up received'
    });
  });

  it('continues run channel threads from Slack thread_broadcast replies', async () => {
    let runComment: any;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async () => ({ handled: false }),
      onRunThreadComment: async (comment) => {
        runComment = comment;
        return { handled: true };
      }
    });

    const replies: any[] = [];
    (socket as any).web.chat.postMessage = async (payload: any) => {
      replies.push(payload);
      return { ok: true };
    };
    (socket as any).web.apiCall = async () => ({ ok: true });

    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        subtype: 'thread_broadcast',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '333.444',
        text: 'Actually say bye world',
        user: 'U123'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runComment).toMatchObject({
      channel: 'C123',
      threadTs: '111.222',
      messageTs: '333.444',
      text: 'Actually say bye world',
      userId: 'U123'
    });
    expect(replies[0]).toMatchObject({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'AgentUse run follow-up received'
    });
  });

  it('dedupes the same Slack thread reply across event shapes', async () => {
    let count = 0;
    const socket = new (await import('../src/slack/approval')).SlackApprovalSocket({
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      onDecision: async () => undefined,
      onThreadComment: async () => ({ handled: false }),
      onRunThreadComment: async () => {
        count += 1;
        return { handled: true };
      }
    });

    (socket as any).web.conversations.replies = async (payload: any) => ({
      ok: true,
      messages: [{
        type: 'message',
        channel: payload.channel,
        thread_ts: payload.ts,
        ts: '333.444',
        text: 'Actually say bye world',
        user: 'U123'
      }]
    });
    (socket as any).web.chat.postMessage = async () => ({ ok: true });
    (socket as any).web.apiCall = async () => ({ ok: true });

    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '111.222',
        ts: '333.444',
        text: 'Actually say bye world',
        user: 'U123'
      }
    });
    await (socket as any).handleMessageEvent({
      event: {
        type: 'message',
        subtype: 'message_replied',
        channel: 'C123',
        message: {
          type: 'message',
          ts: '111.222',
          latest_reply: '333.444'
        }
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(count).toBe(1);
  });
});
