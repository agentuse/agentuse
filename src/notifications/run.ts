import { WebClient } from '@slack/web-api';
import type { ParsedAgent } from '../parser';
import type { RunAgentResult } from '../runner/types';
import { logger } from '../utils/logger';
import {
  bestEffortClearSlackThreadStatus,
  bestEffortSlackThreadStatus,
  postSlackRootMessage,
  postSlackThreadMessages,
  updateSlackRootMessage,
  type SlackThreadMessage
} from '../slack/lifecycle';

type RunNotificationEvent = 'completion' | 'failure';
type RunLifecycleStatus = 'running' | 'suspended' | 'completed' | 'failed';

type SlackRoute = {
  name?: string;
  channelId?: string;
};

type SlackRunSender = (route: SlackRoute, options: RunNotificationOptions) => Promise<void>;
type SlackRunStartSender = (route: SlackRoute, options: RunNotificationStartOptions) => Promise<RunNotificationHandle | undefined>;

export interface RunNotificationOptions {
  event: RunNotificationEvent;
  agent: ParsedAgent;
  agentFilePath?: string;
  sessionId?: string;
  result?: RunAgentResult;
  error?: unknown;
  startTime?: number;
}

export interface RunNotificationStartOptions {
  agent: ParsedAgent;
  agentFilePath?: string;
  sessionId?: string;
  startTime?: number;
}

export interface RunNotificationHandle extends SlackRoute {
  channel: string;
  ts: string;
}

interface RunNotificationDisplayOptions extends Omit<RunNotificationOptions, 'event'> {
  event?: RunNotificationEvent;
  lifecycleStatus?: RunLifecycleStatus;
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

function slackLiveRoutesForRun(agent: ParsedAgent): SlackRoute[] {
  const routes = new Map<string, SlackRoute>();
  for (const route of agent.config.notifications?.routes ?? []) {
    if (route.enabled === false) continue;
    const isApprovalRoute = route.on.includes('approval');
    const isTerminalRunRoute = route.on.includes('completion') && route.on.includes('failure');
    if (!isApprovalRoute && !isTerminalRunRoute) continue;
    const destinations = route.to as Record<string, unknown>;
    const slack = destinations.slack;
    if (slack === undefined) continue;
    const slackConfig = slack && typeof slack === 'object'
      ? slack as { channel_id?: unknown }
      : {};
    const slackRoute = {
      ...(route.name && { name: route.name }),
      ...(typeof slackConfig.channel_id === 'string' && { channelId: slackConfig.channel_id })
    };
    const key = resolveSlackChannelId(slackRoute) ?? `route:${route.name ?? routes.size}`;
    if (!routes.has(key)) routes.set(key, slackRoute);
  }
  return [...routes.values()];
}

function resolveSlackChannelId(route: SlackRoute): string | undefined {
  return route.channelId ?? process.env.SLACK_APPROVAL_CHANNEL;
}

function runDurationMs(options: Pick<RunNotificationOptions, 'startTime'>): number | undefined {
  return options.startTime !== undefined ? Date.now() - options.startTime : undefined;
}

function runStatus(options: RunNotificationDisplayOptions): RunLifecycleStatus {
  if (options.lifecycleStatus) return options.lifecycleStatus;
  return options.event === 'completion' ? 'completed' : 'failed';
}

function runTitle(status: RunLifecycleStatus): string {
  switch (status) {
    case 'running':
      return 'AgentUse run started';
    case 'suspended':
      return 'AgentUse run waiting for approval';
    case 'completed':
      return 'AgentUse run completed';
    case 'failed':
      return 'AgentUse run failed';
  }
}

function runPreview(options: RunNotificationOptions): string {
  if (options.event === 'completion') {
    return options.result?.text?.trim() || 'Agent completed without a final answer.';
  }
  return options.error !== undefined ? errorMessage(options.error) : 'Agent run failed.';
}

function approvalUrl(options: RunNotificationDisplayOptions): string | undefined {
  return options.result?.approvalUrl;
}

function buildRunRootBlocks(options: RunNotificationDisplayOptions): any[] {
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
        text: runTitle(status)
      }
    },
    {
      type: 'section',
      fields
    },
    ...(approvalUrl(options) ? [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Review approval'
        },
        url: approvalUrl(options),
        style: 'primary'
      }]
    }] : [])
  ];
}

function buildRunThreadMessages(options: RunNotificationOptions): SlackThreadMessage[] {
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
  const messages: SlackThreadMessage[] = [];

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

function matchesHandle(handle: RunNotificationHandle, route: SlackRoute): boolean {
  const routeChannel = resolveSlackChannelId(route);
  return Boolean(routeChannel) &&
    (handle.channel === routeChannel || handle.channelId === route.channelId);
}

function findHandle(handles: RunNotificationHandle[], route: SlackRoute): RunNotificationHandle | undefined {
  return handles.find((handle) => matchesHandle(handle, route));
}

function terminalText(options: RunNotificationOptions): string {
  return options.event === 'completion'
    ? `AgentUse run completed: ${options.agent.name}`
    : `AgentUse run failed: ${options.agent.name}`;
}

async function sendSlackRunNotification(route: SlackRoute, options: RunNotificationOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveSlackChannelId(route);
  if (!botToken || !channelId) {
    logger.warn('Slack run notification skipped: missing SLACK_BOT_TOKEN and route channel_id or SLACK_APPROVAL_CHANNEL');
    return;
  }

  const web = new WebClient(botToken);
  const message = await postSlackRootMessage(web, channelId, {
    channel: channelId,
    text: terminalText(options),
    blocks: buildRunRootBlocks(options)
  });
  await postSlackThreadMessages(
    web,
    message.channel,
    message.ts,
    buildRunThreadMessages(options),
    { logPrefix: 'Slack run thread message' }
  );
}

async function sendSlackRunStartNotification(route: SlackRoute, options: RunNotificationStartOptions): Promise<RunNotificationHandle | undefined> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveSlackChannelId(route);
  if (!botToken || !channelId) {
    logger.warn('Slack run start notification skipped: missing SLACK_BOT_TOKEN and route channel_id or SLACK_APPROVAL_CHANNEL');
    return undefined;
  }

  const web = new WebClient(botToken);
  const message = await postSlackRootMessage(web, channelId, {
    channel: channelId,
    text: `AgentUse run started: ${options.agent.name}`,
    blocks: buildRunRootBlocks({
      ...options,
      lifecycleStatus: 'running'
    })
  });
  void bestEffortSlackThreadStatus(web, message.channel, message.ts, 'is working...');
  return {
    ...route,
    channel: message.channel,
    ts: message.ts
  };
}

async function updateSlackRunNotification(handle: RunNotificationHandle, options: RunNotificationOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn('Slack run notification update skipped: missing SLACK_BOT_TOKEN');
    return;
  }

  const web = new WebClient(botToken);
  await updateSlackRootMessage(web, {
    channel: handle.channel,
    ts: handle.ts,
    text: terminalText(options),
    blocks: buildRunRootBlocks(options)
  });
  void bestEffortClearSlackThreadStatus(web, handle.channel, handle.ts);
  await postSlackThreadMessages(
    web,
    handle.channel,
    handle.ts,
    buildRunThreadMessages(options),
    { logPrefix: 'Slack run thread message' }
  );
}

async function updateSlackRunSuspendedNotification(handle: RunNotificationHandle, options: RunNotificationStartOptions & { result: RunAgentResult }): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn('Slack run suspension update skipped: missing SLACK_BOT_TOKEN');
    return;
  }

  const web = new WebClient(botToken);
  await updateSlackRootMessage(web, {
    channel: handle.channel,
    ts: handle.ts,
    text: `AgentUse run waiting for approval: ${options.agent.name}`,
    blocks: buildRunRootBlocks({
      ...options,
      result: options.result,
      lifecycleStatus: 'suspended'
    })
  });
  void bestEffortClearSlackThreadStatus(web, handle.channel, handle.ts);
}

export async function startRunNotifications(
  options: RunNotificationStartOptions,
  sender: SlackRunStartSender = sendSlackRunStartNotification
): Promise<RunNotificationHandle[]> {
  const handles: RunNotificationHandle[] = [];
  const routes = slackLiveRoutesForRun(options.agent);
  for (const route of routes) {
    try {
      const handle = await sender(route, options);
      if (handle) handles.push(handle);
    } catch (err) {
      logger.warn(`Slack run start notification failed: ${(err as Error).message}`);
    }
  }
  return handles;
}

export async function sendRunNotifications(
  options: RunNotificationOptions,
  sender: SlackRunSender = sendSlackRunNotification,
  handles: RunNotificationHandle[] = []
): Promise<void> {
  const routes = slackRoutesForEvent(options.agent, options.event);
  const updatedHandles = new Set<RunNotificationHandle>();
  if (handles.length > 0 && sender === sendSlackRunNotification) {
    for (const handle of handles) {
      try {
        await updateSlackRunNotification(handle, options);
        updatedHandles.add(handle);
      } catch (err) {
        logger.warn(`Slack run notification update failed: ${(err as Error).message}`);
      }
    }
  }

  for (const route of routes) {
    try {
      const handle = findHandle(handles, route);
      if (handle && updatedHandles.has(handle)) continue;
      await sender(route, options);
    } catch (err) {
      logger.warn(`Slack run notification failed: ${(err as Error).message}`);
    }
  }
}

export async function suspendRunNotifications(
  options: RunNotificationStartOptions & { result: RunAgentResult },
  handles: RunNotificationHandle[]
): Promise<void> {
  const routes = slackLiveRoutesForRun(options.agent);
  for (const route of routes) {
    const handle = findHandle(handles, route);
    if (!handle) continue;
    try {
      await updateSlackRunSuspendedNotification(handle, options);
    } catch (err) {
      logger.warn(`Slack run suspension notification failed: ${(err as Error).message}`);
    }
  }
}

export const __testing = {
  buildRunRootBlocks,
  buildRunSlackBlocks,
  buildRunThreadMessages,
  slackLiveRoutesForRun,
  resolveSlackChannelId,
  slackRoutesForEvent
};
