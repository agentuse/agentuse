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

type RunChannelEvent = 'completion' | 'failure';
type RunLifecycleStatus = 'running' | 'suspended' | 'completed' | 'failed';

type SlackChannel = {
  channelId?: string;
  events: Array<'approval' | 'completion' | 'failure'>;
};

type SlackRunSender = (channel: SlackChannel, options: RunChannelOptions) => Promise<void>;
type SlackRunStartSender = (channel: SlackChannel, options: RunChannelStartOptions) => Promise<RunChannelHandle | undefined>;

export interface RunChannelOptions {
  event: RunChannelEvent;
  agent: ParsedAgent;
  agentFilePath?: string;
  sessionId?: string;
  result?: RunAgentResult;
  error?: unknown;
  startTime?: number;
}

export interface RunChannelStartOptions {
  agent: ParsedAgent;
  agentFilePath?: string;
  sessionId?: string;
  startTime?: number;
}

export interface RunChannelHandle extends SlackChannel {
  channel: string;
  ts: string;
}

interface RunChannelDisplayOptions extends Omit<RunChannelOptions, 'event'> {
  event?: RunChannelEvent;
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

function slackChannelForEvent(agent: ParsedAgent, event: RunChannelEvent): SlackChannel[] {
  const slack = agent.config.channels?.slack;
  if (!slack || slack.enabled === false || !slack.events.includes(event)) return [];
  const channelId = 'channelId' in slack ? slack.channelId : undefined;
  return [{
    events: slack.events,
    ...(channelId && { channelId })
  }];
}

function slackLiveChannelForRun(agent: ParsedAgent): SlackChannel[] {
  const slack = agent.config.channels?.slack;
  if (!slack || slack.enabled === false) return [];
  const isApprovalChannel = slack.events.includes('approval');
  const isTerminalRunChannel = slack.events.includes('completion') && slack.events.includes('failure');
  if (!isApprovalChannel && !isTerminalRunChannel) return [];
  const channelId = 'channelId' in slack ? slack.channelId : undefined;
  return [{
    events: slack.events,
    ...(channelId && { channelId })
  }];
}

function resolveSlackChannelId(channel: SlackChannel): string | undefined {
  return channel.channelId ?? process.env.SLACK_APPROVAL_CHANNEL;
}

function runDurationMs(options: Pick<RunChannelOptions, 'startTime'>): number | undefined {
  return options.startTime !== undefined ? Date.now() - options.startTime : undefined;
}

function runStatus(options: RunChannelDisplayOptions): RunLifecycleStatus {
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

function runPreview(options: RunChannelOptions): string {
  if (options.event === 'completion') {
    return options.result?.text?.trim() || 'Agent completed without a final answer.';
  }
  return options.error !== undefined ? errorMessage(options.error) : 'Agent run failed.';
}

function approvalUrl(options: RunChannelDisplayOptions): string | undefined {
  return options.result?.approvalUrl;
}

function buildRunRootBlocks(options: RunChannelDisplayOptions): any[] {
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

function buildRunThreadMessages(options: RunChannelOptions): SlackThreadMessage[] {
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

function buildRunSlackBlocks(options: RunChannelOptions): any[] {
  return buildRunRootBlocks(options);
}

function matchesHandle(handle: RunChannelHandle, channel: SlackChannel): boolean {
  const resolvedChannel = resolveSlackChannelId(channel);
  return Boolean(resolvedChannel) &&
    (handle.channel === resolvedChannel || handle.channelId === channel.channelId);
}

function findHandle(handles: RunChannelHandle[], channel: SlackChannel): RunChannelHandle | undefined {
  return handles.find((handle) => matchesHandle(handle, channel));
}

function shouldUpdateHandleForEvent(handle: RunChannelHandle, event: RunChannelEvent): boolean {
  return handle.events.includes(event) || handle.events.includes('approval');
}

function terminalText(options: RunChannelOptions): string {
  return options.event === 'completion'
    ? `AgentUse run completed: ${options.agent.name}`
    : `AgentUse run failed: ${options.agent.name}`;
}

async function sendSlackRunChannelMessage(channel: SlackChannel, options: RunChannelOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveSlackChannelId(channel);
  if (!botToken || !channelId) {
    logger.warn('Slack run channel skipped: missing SLACK_BOT_TOKEN and channels.slack.channel_id or SLACK_APPROVAL_CHANNEL');
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

async function sendSlackRunStartChannelMessage(channel: SlackChannel, options: RunChannelStartOptions): Promise<RunChannelHandle | undefined> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = resolveSlackChannelId(channel);
  if (!botToken || !channelId) {
    logger.warn('Slack run start channel skipped: missing SLACK_BOT_TOKEN and channels.slack.channel_id or SLACK_APPROVAL_CHANNEL');
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
    ...channel,
    channel: message.channel,
    ts: message.ts
  };
}

async function updateSlackRunChannelMessage(handle: RunChannelHandle, options: RunChannelOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn('Slack run channel update skipped: missing SLACK_BOT_TOKEN');
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

async function updateSlackRunSuspendedChannelMessage(handle: RunChannelHandle, options: RunChannelStartOptions & { result: RunAgentResult }): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn('Slack run suspension channel update skipped: missing SLACK_BOT_TOKEN');
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

export async function startRunChannels(
  options: RunChannelStartOptions,
  sender: SlackRunStartSender = sendSlackRunStartChannelMessage
): Promise<RunChannelHandle[]> {
  const handles: RunChannelHandle[] = [];
  const channels = slackLiveChannelForRun(options.agent);
  for (const channel of channels) {
    try {
      const handle = await sender(channel, options);
      if (handle) handles.push(handle);
    } catch (err) {
      logger.warn(`Slack run start channel failed: ${(err as Error).message}`);
    }
  }
  return handles;
}

export async function sendRunChannelMessages(
  options: RunChannelOptions,
  sender: SlackRunSender = sendSlackRunChannelMessage,
  handles: RunChannelHandle[] = []
): Promise<void> {
  const channels = slackChannelForEvent(options.agent, options.event);
  const updatedHandles = new Set<RunChannelHandle>();
  if (handles.length > 0 && sender === sendSlackRunChannelMessage) {
    for (const handle of handles) {
      if (!shouldUpdateHandleForEvent(handle, options.event)) continue;
      try {
        await updateSlackRunChannelMessage(handle, options);
        updatedHandles.add(handle);
      } catch (err) {
        logger.warn(`Slack run channel update failed: ${(err as Error).message}`);
      }
    }
  }

  for (const channel of channels) {
    try {
      const handle = findHandle(handles, channel);
      if (handle && updatedHandles.has(handle)) continue;
      await sender(channel, options);
    } catch (err) {
      logger.warn(`Slack run channel failed: ${(err as Error).message}`);
    }
  }
}

export async function suspendRunChannels(
  options: RunChannelStartOptions & { result: RunAgentResult },
  handles: RunChannelHandle[]
): Promise<void> {
  const channels = slackLiveChannelForRun(options.agent);
  for (const channel of channels) {
    const handle = findHandle(handles, channel);
    if (!handle) continue;
    try {
      await updateSlackRunSuspendedChannelMessage(handle, options);
    } catch (err) {
      logger.warn(`Slack run suspension channel failed: ${(err as Error).message}`);
    }
  }
}

export const __testing = {
  buildRunRootBlocks,
  buildRunSlackBlocks,
  buildRunThreadMessages,
  slackLiveChannelForRun,
  resolveSlackChannelId,
  slackChannelForEvent,
  shouldUpdateHandleForEvent
};
