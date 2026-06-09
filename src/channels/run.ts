import { WebClient } from '@slack/web-api';
import type { ParsedAgent } from '../parser';
import type { RunAgentResult } from '../runner/types';
import { logger } from '../utils/logger';
import { getSessionUrl } from '../tools/await-human';
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

function runTitleBase(status: RunLifecycleStatus): string {
  switch (status) {
    case 'running':
      return 'run started';
    case 'suspended':
      return 'run waiting for approval';
    case 'completed':
      return 'run completed';
    case 'failed':
      return 'run failed';
  }
}

/**
 * Header line for run cards, matching the approval card shape: lead with the
 * agent name so a channel of cards is scannable, fall back to the generic
 * product-prefixed title when no name is available.
 */
function runTitle(agentName: string | undefined, status: RunLifecycleStatus): string {
  const base = runTitleBase(status);
  return (agentName ? `${agentName} · ${base}` : `AgentUse ${base}`).slice(0, 150);
}

function runPreview(options: RunChannelOptions): string {
  if (options.event === 'completion') {
    return options.result?.text?.trim() || 'Agent completed without a final answer.';
  }
  return options.error !== undefined ? errorMessage(options.error) : 'Agent run failed.';
}

/**
 * Link to the session page. Every run has a session page, so the card always
 * links to it — using the approval URL when present (it already carries the
 * token) and otherwise building the session URL from the id.
 */
function sessionUrl(options: RunChannelDisplayOptions): string | undefined {
  return options.result?.approvalUrl ?? getSessionUrl(options.sessionId);
}

function buildRunRootBlocks(options: RunChannelDisplayOptions): any[] {
  const durationMs = runDurationMs(options);
  const status = runStatus(options);
  // Agent name and status live in the title; only the per-run facts go in the
  // field grid, mirroring the approval card layout.
  const fields = [
    ...(durationMs !== undefined ? [{
      type: 'mrkdwn',
      text: `*Duration*\n${formatDuration(durationMs)}`
    }] : []),
    ...(options.sessionId ? [{
      type: 'mrkdwn',
      text: `*Session*\n\`${options.sessionId}\``
    }] : []),
  ];

  const url = sessionUrl(options);
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: runTitle(options.agent.name, status)
      }
    },
    ...(fields.length > 0 ? [{
      type: 'section',
      fields
    }] : []),
    // Permanent link to the session page (every run has one), as a context
    // link rather than a button so it survives status updates.
    ...(url ? [{
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `<${url}|Open in AgentUse web UI>`
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
