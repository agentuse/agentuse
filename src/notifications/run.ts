import { WebClient } from '@slack/web-api';
import type { ParsedAgent } from '../parser';
import type { RunAgentResult } from '../runner/types';
import { logger } from '../utils/logger';

type RunNotificationEvent = 'completion' | 'failure';

type SlackRoute = {
  name?: string;
  channelId?: string;
};

type SlackRunSender = (route: SlackRoute, options: RunNotificationOptions) => Promise<void>;

export interface RunNotificationOptions {
  event: RunNotificationEvent;
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

function slackRoutesForEvent(agent: ParsedAgent, event: RunNotificationEvent): SlackRoute[] {
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

function runDurationMs(options: RunNotificationOptions): number | undefined {
  return options.startTime !== undefined ? Date.now() - options.startTime : undefined;
}

function runStatus(options: RunNotificationOptions): 'completed' | 'failed' {
  return options.event === 'completion' ? 'completed' : 'failed';
}

function runPreview(options: RunNotificationOptions): string {
  if (options.event === 'completion') {
    return options.result?.text?.trim() || 'Agent completed without a final answer.';
  }
  return options.error !== undefined ? errorMessage(options.error) : 'Agent run failed.';
}

function buildRunRootBlocks(options: RunNotificationOptions): any[] {
  const completed = options.event === 'completion';
  const durationMs = runDurationMs(options);
  const status = runStatus(options);
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
  ];

  return [
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
}

function buildRunThreadMessages(options: RunNotificationOptions): Array<{ text: string; blocks: any[] }> {
  const durationMs = runDurationMs(options);
  const details = [
    `Agent: ${options.agent.name}`,
    ...(options.sessionId ? [`Session: ${options.sessionId}`] : []),
    `Status: ${runStatus(options)}`,
    ...(durationMs !== undefined ? [`Duration: ${formatDuration(durationMs)}`] : []),
    ...(options.result ? [`Tool calls: ${options.result.toolCallCount}`] : []),
    ...(options.result?.usage?.totalTokens !== undefined ? [`Tokens: ${options.result.usage.totalTokens}`] : []),
    ...(options.agent.config.model ? [`Model: ${options.agent.config.model}`] : []),
    ...(options.agentFilePath ? [`Agent file: ${options.agentFilePath}`] : [])
  ];
  const messages: Array<{ text: string; blocks: any[] }> = [];

  messages.push({
    text: options.event === 'completion'
      ? `Final answer: ${truncate(runPreview(options), 120)}`
      : `Error: ${truncate(runPreview(options), 120)}`,
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: options.event === 'completion'
          ? `*Final answer*\n\`\`\`${truncate(runPreview(options), 2800)}\`\`\``
          : `*Error*\n\`\`\`${truncate(runPreview(options), 2800)}\`\`\``
      }
    }]
  });

  messages.push({
    text: `Run details: ${options.agent.name}`,
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Run details*\n${details.map((line) => `- ${line}`).join('\n')}`
      }
    }]
  });

  return messages;
}

function buildRunSlackBlocks(options: RunNotificationOptions): any[] {
  return buildRunRootBlocks(options);
}

async function postRunThreadMessages(web: WebClient, channelId: string, threadTs: string, options: RunNotificationOptions): Promise<void> {
  for (const message of buildRunThreadMessages(options)) {
    try {
      await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: message.text,
        blocks: message.blocks
      });
    } catch (err) {
      logger.warn(`Slack run thread message failed: ${(err as Error).message}`);
    }
  }
}

async function sendSlackRunNotification(route: SlackRoute, options: RunNotificationOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveSlackChannelId(route);
  if (!botToken || !channelId) {
    logger.warn('Slack run notification skipped: missing SLACK_BOT_TOKEN and route channel_id or SLACK_APPROVAL_CHANNEL');
    return;
  }

  const web = new WebClient(botToken);
  const response = await web.chat.postMessage({
    channel: channelId,
    text: options.event === 'completion'
      ? `AgentUse run completed: ${options.agent.name}`
      : `AgentUse run failed: ${options.agent.name}`,
    blocks: buildRunRootBlocks(options)
  });
  const ts = typeof response.ts === 'string' ? response.ts : undefined;
  if (!ts) {
    logger.warn('Slack run notification sent without a message timestamp; skipping thread details');
    return;
  }
  await postRunThreadMessages(web, channelId, ts, options);
}

export async function sendRunNotifications(
  options: RunNotificationOptions,
  sender: SlackRunSender = sendSlackRunNotification
): Promise<void> {
  const routes = slackRoutesForEvent(options.agent, options.event);
  for (const route of routes) {
    try {
      await sender(route, options);
    } catch (err) {
      logger.warn(`Slack run notification failed: ${(err as Error).message}`);
    }
  }
}

export const __testing = {
  buildRunRootBlocks,
  buildRunSlackBlocks,
  buildRunThreadMessages,
  resolveSlackChannelId,
  slackRoutesForEvent
};
