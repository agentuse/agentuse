import { WebClient } from '@slack/web-api';
import type { ParsedAgent } from '../parser';
import type { RunAgentResult } from '../runner/types';
import { logger } from '../utils/logger';

type TerminalNotificationEvent = 'completion' | 'failure';

type SlackRoute = {
  name?: string;
  channelId?: string;
};

type SlackTerminalSender = (route: SlackRoute, options: TerminalNotificationOptions) => Promise<void>;

export interface TerminalNotificationOptions {
  event: TerminalNotificationEvent;
  agent: ParsedAgent;
  agentFilePath?: string;
  sessionId?: string;
  result?: RunAgentResult;
  error?: unknown;
  startTime?: number;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 12))}\n...(truncated)`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function slackRoutesForEvent(agent: ParsedAgent, event: TerminalNotificationEvent): SlackRoute[] {
  const routes: SlackRoute[] = [];
  for (const route of agent.config.notifications?.routes ?? []) {
    if (route.enabled === false || !route.on.includes(event)) continue;
    const destinations = route.to as Record<string, unknown>;
    const slack = destinations.slack;
    if (slack === undefined) continue;
    const slackConfig = slack && typeof slack === 'object'
      ? slack as { channel_id?: unknown }
      : {};
    routes.push({
      ...(route.name && { name: route.name }),
      ...(typeof slackConfig.channel_id === 'string' && { channelId: slackConfig.channel_id })
    });
  }
  return routes;
}

function resolveSlackChannelId(route: SlackRoute): string | undefined {
  return route.channelId ?? process.env.SLACK_APPROVAL_CHANNEL;
}

function buildTerminalSlackBlocks(options: TerminalNotificationOptions): any[] {
  const completed = options.event === 'completion';
  const durationMs = options.startTime !== undefined ? Date.now() - options.startTime : undefined;
  const status = completed ? 'completed' : 'failed';
  const fields = [
    {
      type: 'mrkdwn',
      text: `*Agent*\n${truncate(options.agent.name, 200)}`
    },
    ...(options.sessionId ? [{
      type: 'mrkdwn',
      text: `*Session*\n\`${options.sessionId}\``
    }] : []),
    {
      type: 'mrkdwn',
      text: `*Status*\n${status}`
    },
    ...(durationMs !== undefined ? [{
      type: 'mrkdwn',
      text: `*Duration*\n${formatDuration(durationMs)}`
    }] : []),
    ...(options.result ? [{
      type: 'mrkdwn',
      text: `*Tool calls*\n${options.result.toolCallCount}`
    }] : []),
    ...(options.result?.usage?.totalTokens !== undefined ? [{
      type: 'mrkdwn',
      text: `*Tokens*\n${options.result.usage.totalTokens}`
    }] : [])
  ];

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: completed ? 'AgentUse run completed' : 'AgentUse run failed'
      }
    },
    {
      type: 'section',
      fields
    }
  ];

  if (completed) {
    const answer = options.result?.text?.trim() || 'Agent completed without a final answer.';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Final answer*\n\`\`\`${truncate(answer, 2500)}\`\`\``
      }
    });
  } else if (options.error !== undefined) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`\`\`${truncate(errorMessage(options.error), 2500)}\`\`\``
      }
    });
  }

  return blocks;
}

async function sendSlackTerminalNotification(route: SlackRoute, options: TerminalNotificationOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveSlackChannelId(route);
  if (!botToken || !channelId) {
    logger.warn('Slack terminal notification skipped: missing SLACK_BOT_TOKEN and route channel_id or SLACK_APPROVAL_CHANNEL');
    return;
  }

  const web = new WebClient(botToken);
  await web.chat.postMessage({
    channel: channelId,
    text: options.event === 'completion'
      ? `AgentUse run completed: ${options.agent.name}`
      : `AgentUse run failed: ${options.agent.name}`,
    blocks: buildTerminalSlackBlocks(options)
  });
}

export async function sendTerminalRunNotifications(
  options: TerminalNotificationOptions,
  sender: SlackTerminalSender = sendSlackTerminalNotification
): Promise<void> {
  const routes = slackRoutesForEvent(options.agent, options.event);
  for (const route of routes) {
    try {
      await sender(route, options);
    } catch (err) {
      logger.warn(`Slack terminal notification failed: ${(err as Error).message}`);
    }
  }
}

export const __testing = {
  buildTerminalSlackBlocks,
  resolveSlackChannelId,
  slackRoutesForEvent
};
