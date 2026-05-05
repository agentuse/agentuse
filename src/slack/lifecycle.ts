import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger';

export interface SlackPostedMessage {
  channel: string;
  ts: string;
}

export interface SlackThreadMessage {
  text: string;
  blocks?: any[];
}

export async function postSlackRootMessage(
  web: WebClient,
  fallbackChannelId: string,
  payload: {
    channel: string;
    text: string;
    blocks: any[];
  }
): Promise<SlackPostedMessage> {
  const response = await web.chat.postMessage(payload);
  const channel = typeof response.channel === 'string' ? response.channel : fallbackChannelId;
  const ts = typeof response.ts === 'string' ? response.ts : undefined;
  if (!ts) {
    throw new Error('Slack message was sent but Slack did not return a message timestamp');
  }
  return { channel, ts };
}

export async function updateSlackRootMessage(
  web: WebClient,
  payload: {
    channel: string;
    ts: string;
    text: string;
    blocks: any[];
  }
): Promise<void> {
  await web.chat.update(payload);
}

export async function postSlackThreadMessages(
  web: WebClient,
  channelId: string,
  threadTs: string,
  messages: SlackThreadMessage[],
  options?: {
    logPrefix?: string;
  }
): Promise<void> {
  for (const message of messages) {
    try {
      await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: message.text,
        ...(message.blocks && { blocks: message.blocks })
      });
    } catch (err) {
      const prefix = options?.logPrefix ?? 'Slack thread message';
      logger.warn(`${prefix} failed: ${(err as Error).message}`);
    }
  }
}

export async function setSlackThreadStatus(
  web: WebClient,
  channelId: string,
  threadTs: string,
  status: string
): Promise<void> {
  await web.apiCall('assistant.threads.setStatus', {
    channel_id: channelId,
    thread_ts: threadTs,
    status
  });
}

export async function clearSlackThreadStatus(
  web: WebClient,
  channelId: string,
  threadTs: string
): Promise<void> {
  await setSlackThreadStatus(web, channelId, threadTs, '');
}

export async function bestEffortSlackThreadStatus(
  web: WebClient,
  channelId: string,
  threadTs: string,
  status: string
): Promise<void> {
  try {
    await setSlackThreadStatus(web, channelId, threadTs, status);
  } catch (err) {
    logger.debug(`Slack assistant thread status skipped: ${(err as Error).message}`);
  }
}

export async function bestEffortClearSlackThreadStatus(
  web: WebClient,
  channelId: string,
  threadTs: string
): Promise<void> {
  try {
    await clearSlackThreadStatus(web, channelId, threadTs);
  } catch (err) {
    logger.debug(`Slack assistant thread status clear skipped: ${(err as Error).message}`);
  }
}
