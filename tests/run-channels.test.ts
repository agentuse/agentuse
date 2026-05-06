import { describe, expect, it } from 'bun:test';
import type { ParsedAgent } from '../src/parser';
import { __testing, sendRunChannelMessages, startRunChannels } from '../src/channels/run';

type SlackConfig = NonNullable<ParsedAgent['config']['channels']>['slack'];

function agentWithSlack(slack?: SlackConfig): ParsedAgent {
  return {
    name: 'channel-test',
    instructions: 'Return a result.',
    config: {
      model: 'demo:welcome',
      ...(slack && { channels: { slack } })
    }
  };
}

describe('run channels', () => {
  it('filters Slack channel by event and enabled flag', () => {
    const agent = agentWithSlack({
      enabled: true,
      events: ['completion', 'failure'],
      channelId: 'C_TERMINAL'
    });

    expect(__testing.slackChannelForEvent(agent, 'completion')).toEqual([
      { events: ['completion', 'failure'], channelId: 'C_TERMINAL' }
    ]);
    expect(__testing.slackChannelForEvent(agent, 'failure')).toEqual([
      { events: ['completion', 'failure'], channelId: 'C_TERMINAL' }
    ]);
    expect(__testing.slackChannelForEvent(agentWithSlack({
      enabled: false,
      events: ['completion'],
      channelId: 'C_DISABLED'
    }), 'completion')).toEqual([]);
  });

  it('sends run channel messages through matching Slack channel only', async () => {
    const agent = agentWithSlack({
      enabled: true,
      events: ['completion'],
      channelId: 'C_COMPLETE'
    });
    const sent: Array<{ channelId?: string; event: string }> = [];

    await sendRunChannelMessages({
      event: 'completion',
      agent,
      sessionId: 'session-1',
      result: {
        status: 'completed',
        text: 'Done',
        toolCallCount: 2,
        hasTextOutput: true
      }
    }, async (channel, options) => {
      sent.push({ channelId: channel.channelId, event: options.event });
    });

    expect(sent).toEqual([{ channelId: 'C_COMPLETE', event: 'completion' }]);
  });

  it('updates approval live channel handles on terminal events', async () => {
    expect(__testing.shouldUpdateHandleForEvent({
      events: ['approval'],
      channelId: 'C_APPROVAL',
      channel: 'C_APPROVAL',
      ts: '111.222'
    }, 'completion')).toBe(true);
    expect(__testing.shouldUpdateHandleForEvent({
      events: ['failure'],
      channelId: 'C_FAILURE',
      channel: 'C_FAILURE',
      ts: '111.222'
    }, 'completion')).toBe(false);
  });

  it('starts live run channels for approval and full terminal Slack channels', async () => {
    const agent = agentWithSlack({
      enabled: true,
      events: ['approval', 'completion', 'failure'],
      channelId: 'C_LIVE'
    });
    const started: string[] = [];

    const handles = await startRunChannels({
      agent,
      sessionId: 'session-1'
    }, async (channel) => {
      started.push(channel.channelId ?? 'missing');
      return {
        ...channel,
        channel: channel.channelId ?? 'C_UNKNOWN',
        ts: '111.222'
      };
    });

    expect(started).toEqual(['C_LIVE']);
    expect(handles).toEqual([
      {
        channelId: 'C_LIVE',
        events: ['approval', 'completion', 'failure'],
        channel: 'C_LIVE',
        ts: '111.222'
      }
    ]);
    expect(__testing.slackLiveChannelForRun(agent)).toEqual([
      { events: ['approval', 'completion', 'failure'], channelId: 'C_LIVE' }
    ]);
  });

  it('keeps single terminal events terminal-only', async () => {
    const agent = agentWithSlack({
      enabled: true,
      events: ['completion'],
      channelId: 'C_COMPLETE'
    });
    const started: string[] = [];

    const handles = await startRunChannels({
      agent,
      sessionId: 'session-1'
    }, async (channel) => {
      started.push(channel.channelId ?? 'missing');
      return {
        ...channel,
        channel: channel.channelId ?? 'C_UNKNOWN',
        ts: '111.222'
      };
    });

    expect(started).toEqual([]);
    expect(handles).toHaveLength(0);
    expect(__testing.slackLiveChannelForRun(agent)).toEqual([]);
  });

  it('prefers configured Slack channel over env fallback', () => {
    const previous = process.env.SLACK_APPROVAL_CHANNEL;
    process.env.SLACK_APPROVAL_CHANNEL = 'C_ENV';
    try {
      expect(__testing.resolveSlackChannelId({ events: ['completion'], channelId: 'C_CONFIG' })).toBe('C_CONFIG');
      expect(__testing.resolveSlackChannelId({ events: ['completion'] })).toBe('C_ENV');
    } finally {
      if (previous === undefined) {
        delete process.env.SLACK_APPROVAL_CHANNEL;
      } else {
        process.env.SLACK_APPROVAL_CHANNEL = previous;
      }
    }
  });

  it('renders compact completion cards without the final answer', () => {
    const blocks = __testing.buildRunRootBlocks({
      event: 'completion',
      agent: agentWithSlack(),
      sessionId: 'session-1',
      result: {
        status: 'completed',
        text: 'The launch announcement is ready.'.repeat(30),
        toolCallCount: 3,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30
        },
        hasTextOutput: true
      }
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain('AgentUse run completed');
    expect(text).toContain('session-1');
    expect(text).not.toContain('The launch announcement is ready.');
    expect(text).not.toContain('Tool calls');
    expect(text).not.toContain('Tokens');
    expect(text).not.toContain('Final answer');
  });

  it('renders running and suspended live run cards', () => {
    const running = __testing.buildRunRootBlocks({
      lifecycleStatus: 'running',
      agent: agentWithSlack(),
      sessionId: 'session-1'
    });
    const suspended = __testing.buildRunRootBlocks({
      lifecycleStatus: 'suspended',
      agent: agentWithSlack(),
      sessionId: 'session-1',
      result: {
        status: 'suspended',
        text: '',
        toolCallCount: 1,
        hasTextOutput: false,
        approvalUrl: 'https://agentuse.example.com/approvals/session-1?token=abc'
      }
    });
    const runningText = JSON.stringify(running);
    const suspendedText = JSON.stringify(suspended);

    expect(runningText).toContain('AgentUse run started');
    expect(runningText).toContain('running');
    expect(suspendedText).toContain('AgentUse run waiting for approval');
    expect(suspendedText).toContain('suspended');
    expect(suspendedText).toContain('Review approval');
  });

  it('renders completion thread messages with full answer and run details', () => {
    const messages = __testing.buildRunThreadMessages({
      event: 'completion',
      agent: agentWithSlack(),
      agentFilePath: '/tmp/channel.agentuse',
      sessionId: 'session-1',
      result: {
        status: 'completed',
        text: 'The launch announcement is ready.',
        toolCallCount: 3,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30
        },
        hasTextOutput: true
      }
    });
    const text = JSON.stringify(messages);

    expect(messages).toHaveLength(2);
    expect(text).toContain('Final answer');
    expect(text).toContain('The launch announcement is ready.');
    expect(text).toContain('Tool calls: 3');
    expect(text).toContain('Tokens: 30');
    expect(text).toContain('/tmp/channel.agentuse');
  });

  it('renders compact failure cards without the error message', () => {
    const blocks = __testing.buildRunRootBlocks({
      event: 'failure',
      agent: agentWithSlack(),
      sessionId: 'session-1',
      error: new Error('Publish failed')
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain('AgentUse run failed');
    expect(text).toContain('session-1');
    expect(text).not.toContain('Publish failed');
    expect(text).not.toContain('*Error*');
  });

  it('renders failure thread messages with error and run details', () => {
    const messages = __testing.buildRunThreadMessages({
      event: 'failure',
      agent: agentWithSlack(),
      agentFilePath: '/tmp/channel.agentuse',
      sessionId: 'session-1',
      error: new Error('Publish failed')
    });
    const text = JSON.stringify(messages);

    expect(messages).toHaveLength(2);
    expect(text).toContain('Error');
    expect(text).toContain('Publish failed');
    expect(text).toContain('Status: failed');
    expect(text).toContain('/tmp/channel.agentuse');
  });
});
