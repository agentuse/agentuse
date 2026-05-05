import { describe, expect, it } from 'bun:test';
import type { ParsedAgent } from '../src/parser';
import { __testing, sendTerminalRunNotifications } from '../src/notifications/terminal';

function agentWithRoutes(routes: NonNullable<ParsedAgent['config']['notifications']>['routes']): ParsedAgent {
  return {
    name: 'notify-test',
    instructions: 'Return a result.',
    config: {
      model: 'demo:welcome',
      notifications: { routes }
    }
  };
}

describe('terminal notifications', () => {
  it('filters Slack routes by event and enabled flag', () => {
    const agent = agentWithRoutes([
      {
        enabled: false,
        on: ['completion'],
        to: { slack: { channel_id: 'C_DISABLED' } }
      },
      {
        on: ['approval'],
        to: { slack: { channel_id: 'C_APPROVAL' } }
      },
      {
        name: 'run-result',
        on: ['completion', 'failure'],
        to: { slack: { channel_id: 'C_TERMINAL' } }
      }
    ]);

    expect(__testing.slackRoutesForEvent(agent, 'completion')).toEqual([
      { name: 'run-result', channelId: 'C_TERMINAL' }
    ]);
    expect(__testing.slackRoutesForEvent(agent, 'failure')).toEqual([
      { name: 'run-result', channelId: 'C_TERMINAL' }
    ]);
  });

  it('sends terminal notifications through matching routes only', async () => {
    const agent = agentWithRoutes([
      {
        on: ['completion'],
        to: { slack: { channel_id: 'C_COMPLETE' } }
      },
      {
        on: ['failure'],
        to: { slack: { channel_id: 'C_FAIL' } }
      }
    ]);
    const sent: Array<{ channelId?: string; event: string }> = [];

    await sendTerminalRunNotifications({
      event: 'completion',
      agent,
      sessionId: 'session-1',
      result: {
        status: 'completed',
        text: 'Done',
        toolCallCount: 2,
        hasTextOutput: true
      }
    }, async (route, options) => {
      sent.push({ channelId: route.channelId, event: options.event });
    });

    expect(sent).toEqual([{ channelId: 'C_COMPLETE', event: 'completion' }]);
  });

  it('prefers route Slack channel over env fallback', () => {
    const previous = process.env.SLACK_APPROVAL_CHANNEL;
    process.env.SLACK_APPROVAL_CHANNEL = 'C_ENV';
    try {
      expect(__testing.resolveSlackChannelId({ channelId: 'C_ROUTE' })).toBe('C_ROUTE');
      expect(__testing.resolveSlackChannelId({})).toBe('C_ENV');
    } finally {
      if (previous === undefined) {
        delete process.env.SLACK_APPROVAL_CHANNEL;
      } else {
        process.env.SLACK_APPROVAL_CHANNEL = previous;
      }
    }
  });

  it('renders completion cards with the final answer', () => {
    const blocks = __testing.buildTerminalSlackBlocks({
      event: 'completion',
      agent: agentWithRoutes([]),
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
    const text = JSON.stringify(blocks);

    expect(text).toContain('AgentUse run completed');
    expect(text).toContain('session-1');
    expect(text).toContain('The launch announcement is ready.');
    expect(text).toContain('30');
  });

  it('renders failure cards with the error message', () => {
    const blocks = __testing.buildTerminalSlackBlocks({
      event: 'failure',
      agent: agentWithRoutes([]),
      sessionId: 'session-1',
      error: new Error('Publish failed')
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain('AgentUse run failed');
    expect(text).toContain('session-1');
    expect(text).toContain('Publish failed');
  });
});
