import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger';

/**
 * The Slack SDKs cost ~23MB of heap and were loaded by every agentuse process at
 * startup -- including the serve workers, which touch Slack only if an agent
 * suspends on a gate with Slack configured. Both have to be deferred together:
 * @slack/socket-mode depends on @slack/web-api, so deferring one alone saves
 * nothing. Callers await loadSlackSdk() before constructing either client.
 */
type SlackSdk = {
  WebClient: typeof import('@slack/web-api').WebClient;
  SocketModeClient: typeof import('@slack/socket-mode').SocketModeClient;
};
let slackSdkCache: SlackSdk | undefined;
let slackSdkPending: Promise<SlackSdk> | undefined;

export async function loadSlackSdk(): Promise<SlackSdk> {
  if (slackSdkCache) return slackSdkCache;
  // Share one in-flight import: concurrent approvals would otherwise each start
  // their own, and the first use is exactly when several tend to land at once.
  slackSdkPending ??= Promise.all([import('@slack/web-api'), import('@slack/socket-mode')])
    .then(([web, socket]) => {
      slackSdkCache = { WebClient: web.WebClient, SocketModeClient: socket.SocketModeClient };
      return slackSdkCache;
    })
    .finally(() => { slackSdkPending = undefined; });
  return slackSdkPending;
}

/** The loaded SDK, for sync contexts that a caller has already primed. */
export function loadedSlackSdk(): SlackSdk {
  if (!slackSdkCache) {
    throw new Error('Slack SDK not loaded yet — await loadSlackSdk() before constructing a Slack client');
  }
  return slackSdkCache;
}

// Slack rate-limits per bot token, and every WebClient carries its own request
// queue and retry state -- a client built per call left concurrent runs racing
// Slack with no shared throttle. One client per token gives them one queue.
// The SDK default (100) is well above what a Slack tier-3 method allows.
const SLACK_MAX_REQUEST_CONCURRENCY = 10;
const slackWebClients = new Map<string, WebClient>();

export async function getSlackWebClient(botToken: string): Promise<WebClient> {
  const cached = slackWebClients.get(botToken);
  if (cached) return cached;
  const sdk = await loadSlackSdk();
  // Re-check: concurrent first callers all suspend on the import above.
  const raced = slackWebClients.get(botToken);
  if (raced) return raced;
  const web = new sdk.WebClient(botToken, { maxRequestConcurrency: SLACK_MAX_REQUEST_CONCURRENCY });
  slackWebClients.set(botToken, web);
  return web;
}

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
): Promise<Array<SlackPostedMessage | undefined>> {
  const posted: Array<SlackPostedMessage | undefined> = [];
  for (const message of messages) {
    try {
      const response = await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: message.text,
        ...(message.blocks && { blocks: message.blocks })
      });
      const channel = typeof response.channel === 'string' ? response.channel : channelId;
      const ts = typeof response.ts === 'string' ? response.ts : undefined;
      posted.push(ts ? { channel, ts } : undefined);
    } catch (err) {
      const prefix = options?.logPrefix ?? 'Slack thread message';
      logger.warn(`${prefix} failed: ${(err as Error).message}`);
      posted.push(undefined);
    }
  }
  return posted;
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
