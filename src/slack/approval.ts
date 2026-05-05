import { SocketModeClient, LogLevel as SlackSocketLogLevel } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger';
import {
  bestEffortClearSlackThreadStatus,
  bestEffortSlackThreadStatus,
  postSlackRootMessage,
  postSlackThreadMessages,
  updateSlackRootMessage
} from './lifecycle';

export interface SlackApprovalRequest {
  botToken: string;
  channelId: string;
  sessionId?: string;
  projectId?: string;
  prompt: string;
  summary?: string;
  draft?: string;
  draftUrl?: string;
  artifactUrl?: string;
  context?: string;
  risk?: string;
  resumeToken: string;
  approvalUrl?: string;
  expiresAt?: string;
  interactive?: boolean;
}

export interface SlackApprovalMessage {
  channel: string;
  ts: string;
}

export interface SlackApprovalDecision {
  sessionId: string;
  projectId?: string;
  resumeToken: string;
  toolResult: {
    status: string;
    comment?: string;
    reviewer?: {
      id?: string;
      username?: string;
      teamId?: string;
    };
  };
}

export interface SlackApprovalThreadComment {
  channel: string;
  threadTs: string;
  messageTs?: string;
  text: string;
  userId?: string;
  username?: string;
  teamId?: string;
}

export interface SlackApprovalThreadCommentResult {
  handled: boolean;
  done?: Promise<void>;
}

export interface SlackRunThreadCommentResult {
  handled: boolean;
  done?: Promise<void>;
}

const ACTION_ID_PREFIX = 'agentuse_approval_action';
const COMMENT_CALLBACK_ID = 'agentuse_approval_comment';
const COMMENT_BLOCK_ID = 'comment';
const COMMENT_INPUT_ID = 'value';
const SLACK_APPROVAL_ACTIONS: Array<{ id: string; label: string; style?: 'primary' | 'danger' }> = [
  { id: 'approve', label: 'Approve', style: 'primary' },
  { id: 'reject', label: 'Reject', style: 'danger' },
  { id: 'comment', label: 'Comment' }
];

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 12))}\n...(truncated)`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function actionIdFor(action: { id: string }, index: number): string {
  const safeId = action.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'action';
  return `${ACTION_ID_PREFIX}_${index}_${safeId}`;
}

function encodeActionValue(options: {
  sessionId?: string;
  projectId?: string;
  rootChannelId?: string;
  rootMessageTs?: string;
  prompt?: string;
  resumeToken: string;
  action: string;
}): string {
  return JSON.stringify({
    ...(options.sessionId && { sessionId: options.sessionId }),
    ...(options.projectId && { projectId: options.projectId }),
    ...(options.rootChannelId && { rootChannelId: options.rootChannelId }),
    ...(options.rootMessageTs && { rootMessageTs: options.rootMessageTs }),
    ...(options.prompt && { prompt: truncate(options.prompt, 500) }),
    resumeToken: options.resumeToken,
    action: options.action
  });
}

function parseActionValue(value: unknown): {
  sessionId: string;
  projectId?: string;
  rootChannelId?: string;
  rootMessageTs?: string;
  prompt?: string;
  resumeToken: string;
  action: string;
} {
  if (typeof value !== 'string') {
    throw new Error('Slack approval action is missing a value');
  }
  const parsed = JSON.parse(value) as {
    sessionId?: unknown;
    projectId?: unknown;
    rootChannelId?: unknown;
    rootMessageTs?: unknown;
    prompt?: unknown;
    resumeToken?: unknown;
    action?: unknown;
  };
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
    throw new Error('Slack approval action is missing sessionId');
  }
  if (typeof parsed.resumeToken !== 'string' || parsed.resumeToken.length === 0) {
    throw new Error('Slack approval action is missing resumeToken');
  }
  if (typeof parsed.action !== 'string' || parsed.action.length === 0) {
    throw new Error('Slack approval action is missing action');
  }
  return {
    sessionId: parsed.sessionId,
    ...(typeof parsed.projectId === 'string' && parsed.projectId.length > 0 && { projectId: parsed.projectId }),
    ...(typeof parsed.rootChannelId === 'string' && parsed.rootChannelId.length > 0 && { rootChannelId: parsed.rootChannelId }),
    ...(typeof parsed.rootMessageTs === 'string' && parsed.rootMessageTs.length > 0 && { rootMessageTs: parsed.rootMessageTs }),
    ...(typeof parsed.prompt === 'string' && parsed.prompt.length > 0 && { prompt: parsed.prompt }),
    resumeToken: parsed.resumeToken,
    action: parsed.action
  };
}

function buildStatusBlocks(options: {
  phase: 'waiting' | 'resuming' | 'completed' | 'failed';
  prompt: string;
  sessionId?: string;
  decision?: string;
  reviewer?: SlackApprovalDecision['toolResult']['reviewer'];
  durationMs?: number;
  error?: unknown;
  expiresAt?: string;
}): any[] {
  const title = options.phase === 'waiting'
    ? 'AgentUse approval requested'
    : options.phase === 'resuming'
      ? `AgentUse approval ${statusLabel(options.decision ?? 'submitted')}`
      : options.phase === 'completed'
        ? 'AgentUse approval completed'
        : 'AgentUse approval failed';
  const reviewer = options.reviewer?.id
    ? `<@${options.reviewer.id}>`
    : options.reviewer?.username;
  const status = options.phase === 'waiting'
    ? 'waiting for approval'
    : options.phase;
  const fields = [
    {
      type: 'mrkdwn',
      text: `*Prompt*\n${truncate(options.prompt, 600)}`
    },
    {
      type: 'mrkdwn',
      text: `*Session*\n\`${options.sessionId ?? 'unknown'}\``
    },
    ...(options.decision ? [{
      type: 'mrkdwn',
      text: `*Decision*\n\`${options.decision}\``
    }] : []),
    ...(reviewer ? [{
      type: 'mrkdwn',
      text: `*Reviewer*\n${reviewer}`
    }] : []),
    {
      type: 'mrkdwn',
      text: `*Status*\n${status}`
    },
    ...(options.durationMs !== undefined ? [{
      type: 'mrkdwn',
      text: `*Duration*\n${formatDuration(options.durationMs)}`
    }] : []),
    ...(options.expiresAt ? [{
      type: 'mrkdwn',
      text: `*Expires*\n${options.expiresAt}`
    }] : []),
  ];

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: title.slice(0, 150)
      }
    },
    {
      type: 'section',
      fields
    }
  ];

  if (options.phase === 'failed' && options.error !== undefined) {
    const message = options.error instanceof Error ? options.error.message : String(options.error);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`\`\`${truncate(message, 2500)}\`\`\``
      }
    });
  }

  return blocks;
}

function buildDetailThreadMessages(request: SlackApprovalRequest): Array<{ text: string; blocks: any[] }> {
  const messages: Array<{ text: string; blocks: any[] }> = [];

  if (request.summary) {
    messages.push({
      text: `Summary: ${truncate(request.summary, 120)}`,
      blocks: [sectionBlock('Summary', request.summary, 2800)]
    });
  }

  if (request.artifactUrl) {
    messages.push({
      text: `Review artifact: ${request.artifactUrl}`,
      blocks: [sectionBlock('Review artifact', request.artifactUrl, 2800)]
    });
  }

  if (request.draft) {
    messages.push({
      text: `Draft: ${truncate(request.draft, 120)}`,
      blocks: [sectionBlock('Draft', request.draft, 2800)]
    });
  }

  if (request.draftUrl) {
    messages.push({
      text: `Draft URL: ${request.draftUrl}`,
      blocks: [sectionBlock('Draft URL', request.draftUrl, 2800)]
    });
  }

  if (request.context) {
    messages.push({
      text: `Context: ${truncate(request.context, 120)}`,
      blocks: [sectionBlock('Context', request.context, 2000)]
    });
  }

  if (request.risk) {
    messages.push({
      text: `Risk / notes: ${truncate(request.risk, 120)}`,
      blocks: [sectionBlock('Risk / notes', request.risk, 2000)]
    });
  }

  return messages;
}

function buildActionThreadMessage(request: SlackApprovalRequest & { rootChannelId: string; rootMessageTs: string }): { text: string; blocks: any[] } {
  return {
    text: `Approval decision: ${request.prompt}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Decision*\nApprove, reject, or comment from this thread.'
        }
      },
      ...buildActionBlocks(request)
    ]
  };
}

function sectionBlock(title: string, value: string, maxLength: number): any {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${title}*\n${truncate(value, maxLength)}`
    }
  };
}

function buildActionBlocks(request: SlackApprovalRequest & { rootChannelId?: string; rootMessageTs?: string }): any[] {
  return [{
    type: 'actions',
    elements: SLACK_APPROVAL_ACTIONS.map((action, index) => ({
      type: 'button',
      action_id: actionIdFor(action, index),
      text: {
        type: 'plain_text',
        text: action.label.slice(0, 75)
      },
      value: encodeActionValue({
        ...(request.sessionId && { sessionId: request.sessionId }),
        ...(request.projectId && { projectId: request.projectId }),
        ...(request.rootChannelId && { rootChannelId: request.rootChannelId }),
        ...(request.rootMessageTs && { rootMessageTs: request.rootMessageTs }),
        prompt: request.prompt,
        resumeToken: request.resumeToken,
        action: action.id
      }),
      ...(action.style && { style: action.style })
    }))
  }, {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
          text: request.expiresAt
            ? `Session \`${request.sessionId ?? 'unknown'}\` expires ${request.expiresAt}`
            : `Session \`${request.sessionId ?? 'unknown'}\` has no approval timeout`
      }
    ]
  }];
}

function buildReviewLinkBlocks(request: SlackApprovalRequest): any[] {
  const fields = [
    {
      type: 'mrkdwn',
      text: `*Session*\n\`${request.sessionId ?? 'unknown'}\``
    },
    ...(request.projectId ? [{
      type: 'mrkdwn',
      text: `*Project*\n\`${request.projectId}\``
    }] : []),
    {
      type: 'mrkdwn',
      text: `*Status*\nwaiting for approval`
    },
    ...(request.expiresAt ? [{
      type: 'mrkdwn',
      text: `*Expires*\n${request.expiresAt}`
    }] : [])
  ];

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'AgentUse approval requested'
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Prompt*\n${truncate(request.prompt, 800)}`
      }
    },
    {
      type: 'section',
      fields
    },
    ...(request.approvalUrl ? [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Review approval'
        },
        url: request.approvalUrl,
        style: 'primary'
      }]
    }] : [])
  ];
}

function buildApprovalThreadMessages(
  request: SlackApprovalRequest & { rootChannelId: string; rootMessageTs: string }
): Array<{ text: string; blocks: any[] }> {
  return [
    ...buildDetailThreadMessages(request),
    ...(request.interactive ? [buildActionThreadMessage(request)] : [])
  ];
}

function buildReviewStatusBlocks(options: {
  prompt: string;
  sessionId?: string;
  projectId?: string;
  status: 'waiting' | 'resuming' | 'completed' | 'failed';
  decision?: string;
  error?: unknown;
  approvalUrl?: string;
  expiresAt?: string;
}): any[] {
  const fields = [
    {
      type: 'mrkdwn',
      text: `*Session*\n\`${options.sessionId ?? 'unknown'}\``
    },
    ...(options.projectId ? [{
      type: 'mrkdwn',
      text: `*Project*\n\`${options.projectId}\``
    }] : []),
    ...(options.decision ? [{
      type: 'mrkdwn',
      text: `*Decision*\n\`${options.decision}\``
    }] : []),
    {
      type: 'mrkdwn',
      text: `*Status*\n${options.status}`
    },
    ...(options.expiresAt ? [{
      type: 'mrkdwn',
      text: `*Expires*\n${options.expiresAt}`
    }] : [])
  ];
  const error = options.error instanceof Error ? options.error.message : options.error;

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: options.status === 'waiting'
          ? 'AgentUse approval requested'
          : `AgentUse approval ${options.status}`
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Prompt*\n${truncate(options.prompt, 800)}`
      }
    },
    {
      type: 'section',
      fields
    },
    ...(error ? [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`\`\`${truncate(String(error), 2500)}\`\`\``
      }
    }] : []),
    ...(options.approvalUrl && options.status === 'waiting' ? [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Review approval'
        },
        url: options.approvalUrl,
        style: 'primary'
      }]
    }] : [])
  ];
}

export const __testing = {
  buildActionBlocks,
  buildActionThreadMessage,
  buildApprovalThreadMessages,
  buildDetailThreadMessages,
  buildReviewLinkBlocks,
  buildReviewStatusBlocks,
  buildStatusBlocks,
  slackApprovalPostErrorMessage,
  resolvedBlocks,
  resumeFailedBlocks
};

export async function sendSlackApprovalRequest(request: SlackApprovalRequest): Promise<SlackApprovalMessage> {
  if (!request.sessionId) {
    throw new Error('Slack approval requires a session id');
  }

  const web = new WebClient(request.botToken);
  const message = await postSlackApprovalMessage(web, request.channelId, {
    channel: request.channelId,
    text: `AgentUse approval requested: ${request.prompt}`,
    blocks: buildReviewLinkBlocks(request)
  });

  await postSlackThreadMessages(
    web,
    message.channel,
    message.ts,
    buildApprovalThreadMessages({
      ...request,
      rootChannelId: message.channel,
      rootMessageTs: message.ts
    }),
    { logPrefix: 'Slack approval detail thread message' }
  );

  return message;
}

export async function sendSlackApprovalRequestToThread(
  request: SlackApprovalRequest,
  root: SlackApprovalMessage
): Promise<SlackApprovalMessage> {
  await postSlackThreadMessages(
    new WebClient(request.botToken),
    root.channel,
    root.ts,
    buildApprovalThreadMessages({
      ...request,
      rootChannelId: root.channel,
      rootMessageTs: root.ts
    }),
    { logPrefix: 'Slack approval detail thread message' }
  );

  return root;
}

export async function updateSlackApprovalRequestStatus(options: {
  botToken: string;
  channelId: string;
  ts: string;
  prompt: string;
  sessionId?: string;
  projectId?: string;
  approvalUrl?: string;
  expiresAt?: string;
  status: 'waiting' | 'resuming' | 'completed' | 'failed';
  decision?: string;
  error?: unknown;
}): Promise<void> {
  const web = new WebClient(options.botToken);
  await updateSlackRootMessage(web, {
    channel: options.channelId,
    ts: options.ts,
    text: `AgentUse approval ${options.status}`,
    blocks: buildReviewStatusBlocks({
      prompt: options.prompt,
      ...(options.sessionId && { sessionId: options.sessionId }),
      ...(options.projectId && { projectId: options.projectId }),
      ...(options.approvalUrl && { approvalUrl: options.approvalUrl }),
      ...(options.expiresAt && { expiresAt: options.expiresAt }),
      status: options.status,
      ...(options.decision && { decision: options.decision }),
      ...(options.error !== undefined && { error: options.error })
    })
  });
  if (options.status === 'resuming') {
    void bestEffortSlackThreadStatus(web, options.channelId, options.ts, 'is working...');
  } else {
    void bestEffortClearSlackThreadStatus(web, options.channelId, options.ts);
  }
}

async function postSlackApprovalMessage(web: WebClient, channelId: string, payload: any) {
  try {
    return await postSlackRootMessage(web, channelId, payload);
  } catch (err) {
    const message = slackApprovalPostErrorMessage(channelId, err);
    if (message) throw new Error(message);
    throw err;
  }
}

function slackApprovalPostErrorMessage(channelId: string, err: unknown): string | undefined {
  const errorCode = slackApiErrorCode(err);
  if (errorCode !== 'channel_not_found') return undefined;
  return `Slack could not post approval request to channel "${channelId}" (channel_not_found). Check that SLACK_BOT_TOKEN belongs to the same Slack workspace as the channel and that the bot is a member of private channels.`;
}

function slackApiErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const data = (err as { data?: { error?: unknown } }).data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

type SlackApprovalReviewer = NonNullable<SlackApprovalDecision['toolResult']['reviewer']>;

function reviewerFromBody(body: any): SlackApprovalReviewer {
  return {
    ...(typeof body?.user?.id === 'string' && { id: body.user.id }),
    ...(typeof body?.user?.username === 'string' && { username: body.user.username }),
    ...(typeof body?.team?.id === 'string' && { teamId: body.team.id })
  };
}

function findCommentValue(values: any): string {
  const direct = values?.[COMMENT_BLOCK_ID]?.[COMMENT_INPUT_ID]?.value;
  if (typeof direct === 'string') return direct;

  for (const block of Object.values(values ?? {})) {
    if (!block || typeof block !== 'object') continue;
    for (const action of Object.values(block as Record<string, any>)) {
      if (typeof action?.value === 'string') return action.value;
    }
  }

  return '';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'comment':
      return 'commented';
    default:
      return status;
  }
}

function resolvedBlocks(status: string, reviewer?: SlackApprovalDecision['toolResult']['reviewer'], comment?: string): any[] {
  const who = reviewer?.id ? `<@${reviewer.id}>` : 'A reviewer';
  const commentText = comment ? `\n>${truncate(comment, 1500)}` : '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: status === 'comment'
          ? `*Comment received*\n${who} commented. AgentUse is resuming the session with this feedback.${commentText}`
          : `*Decision recorded*\n${who} submitted \`${status}\`. The channel message is the source of truth for status.${commentText}`
      }
    }
  ];
}

function resumeFailedBlocks(options: {
  status: string;
  sessionId: string;
  error: unknown;
  reviewer?: SlackApprovalDecision['toolResult']['reviewer'];
}): any[] {
  const who = options.reviewer?.id ? `<@${options.reviewer.id}>` : 'A reviewer';
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*AgentUse approval resume failed*\n${who} submitted \`${options.status}\`, but AgentUse could not resume session \`${options.sessionId}\`.`
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`\`\`${truncate(message, 2500)}\`\`\``
      }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Check `agentuse sessions <session_id>` and the `agentuse serve` log for details.'
        }
      ]
    }
  ];
}

export class SlackApprovalSocket {
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private readonly seenThreadComments = new Set<string>();

  constructor(private readonly options: {
    appToken: string;
    botToken: string;
    onDecision: (decision: SlackApprovalDecision) => Promise<void>;
    onThreadComment?: (comment: SlackApprovalThreadComment) => Promise<SlackApprovalThreadCommentResult>;
    onRunThreadComment?: (comment: SlackApprovalThreadComment) => Promise<SlackRunThreadCommentResult>;
    debug?: boolean;
  }) {
    this.socket = new SocketModeClient({
      appToken: options.appToken,
      logLevel: options.debug ? SlackSocketLogLevel.DEBUG : SlackSocketLogLevel.ERROR
    });
    this.web = new WebClient(options.botToken);
    this.socket.on('interactive', (event: any) => {
      void this.handleInteractive(event);
    });
    this.socket.on('message', (event: any) => {
      void this.handleMessageEvent(event);
    });
    this.socket.on('error', (error: Error) => {
      logger.warn(`Slack approval socket error: ${error.message}`);
    });
  }

  async start(): Promise<void> {
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }

  private async handleInteractive(event: any): Promise<void> {
    const ack = typeof event?.ack === 'function' ? event.ack : async () => undefined;
    const body = event?.body;

    try {
      await ack();

      if (body?.type === 'block_actions') {
        void this.handleBlockAction(body).catch((err) => {
          logger.warn(`Slack approval block action failed: ${(err as Error).message}`);
        });
        return;
      }

      if (body?.type === 'view_submission') {
        void this.handleViewSubmission(body).catch((err) => {
          logger.warn(`Slack approval view submission failed: ${(err as Error).message}`);
        });
      }
    } catch (err) {
      logger.warn(`Slack approval interaction failed: ${(err as Error).message}`);
    }
  }

  private async handleMessageEvent(envelope: any): Promise<void> {
    const ack = typeof envelope?.ack === 'function' ? envelope.ack : async () => undefined;
    try {
      await ack();
    } catch (err) {
      logger.warn(`Slack approval message ack failed: ${(err as Error).message}`);
    }

    const rawEvent = envelope?.event && typeof envelope.event === 'object'
      ? envelope.event
      : envelope;
    const event = await this.normalizeThreadReplyEvent(rawEvent);
    const channel = event.channel;
    const threadTs = event.threadTs;
    const messageTs = event.messageTs;
    const text = event.text.trim();

    if (!this.options.onThreadComment && !this.options.onRunThreadComment) return;
    if (!channel || !threadTs || !messageTs || !text) return;
    if (messageTs === threadTs) return;
    if (event.botId) return;
    const commentKey = `${channel}:${messageTs}`;
    if (this.seenThreadComments.has(commentKey)) return;
    this.rememberThreadComment(commentKey);

    const comment: SlackApprovalThreadComment = {
      channel,
      threadTs,
      messageTs,
      text,
      ...(event.userId && { userId: event.userId }),
      ...(event.username && { username: event.username }),
      ...(event.teamId && { teamId: event.teamId })
    };

    const reviewer = {
      ...(comment.userId && { id: comment.userId }),
      ...(comment.username && { username: comment.username }),
      ...(comment.teamId && { teamId: comment.teamId })
    };

    const handleResult = async (
      result: SlackApprovalThreadCommentResult | SlackRunThreadCommentResult,
      options: { text: string; blocks: any[] }
    ) => {
      if (!result.handled) return;

      void bestEffortSlackThreadStatus(this.web, channel, threadTs, 'is working...');
      void this.web.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: options.text,
        blocks: options.blocks
      }).catch((err) => {
        logger.warn(`Slack thread comment acknowledgement failed: ${(err as Error).message}`);
      });

      await result.done;
      await bestEffortClearSlackThreadStatus(this.web, channel, threadTs);
    };

    const handleFailure = async (err: unknown, failureText: string) => {
      await bestEffortClearSlackThreadStatus(this.web, channel, threadTs);
      await this.web.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: failureText,
        blocks: resumeFailedBlocks({
          status: 'comment',
          sessionId: 'unknown',
          error: err,
          reviewer
        })
      });
      logger.warn(`Slack thread comment failed: ${(err as Error).message}`);
    };

    const approvalCommentResult = this.options.onThreadComment
      ? this.options.onThreadComment(comment)
      : Promise.resolve({ handled: false });

    approvalCommentResult.then(async (result) => {
      if (result.handled) {
        await handleResult(result, {
          text: 'AgentUse approval comment received',
          blocks: resolvedBlocks('comment', reviewer, text)
        });
        return;
      }

      if (!this.options.onRunThreadComment) return;
      const runResult = await this.options.onRunThreadComment(comment);
      await handleResult(runResult, {
        text: 'AgentUse run follow-up received',
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Follow-up received*\nAgentUse is continuing the session with this feedback.\n>${truncate(text, 1500)}`
          }
        }]
      });
    }).catch(async (err) => {
      await handleFailure(err, 'AgentUse thread comment failed');
    });
  }

  private async normalizeThreadReplyEvent(event: any): Promise<{
    channel?: string;
    threadTs?: string;
    messageTs?: string;
    text: string;
    userId?: string;
    username?: string;
    teamId?: string;
    botId?: string;
  }> {
    if (event?.subtype === 'message_replied') {
      const channel = typeof event.channel === 'string' ? event.channel : undefined;
      const root = event.message && typeof event.message === 'object' ? event.message : {};
      const threadTs = typeof root.thread_ts === 'string'
        ? root.thread_ts
        : typeof root.ts === 'string'
          ? root.ts
          : undefined;
      const latestReplyTs = typeof root.latest_reply === 'string'
        ? root.latest_reply
        : Array.isArray(root.replies)
          ? [...root.replies].reverse().find((reply: any) => typeof reply?.ts === 'string')?.ts
          : undefined;

      if (!channel || !threadTs || !latestReplyTs) {
        return { text: '' };
      }

      const reply = await this.fetchSlackThreadReply(channel, threadTs, latestReplyTs);
      if (!reply) {
        return { text: '' };
      }

      return {
        channel,
        threadTs,
        messageTs: typeof reply.ts === 'string' ? reply.ts : latestReplyTs,
        text: typeof reply.text === 'string' ? reply.text : '',
        ...(typeof reply.user === 'string' && { userId: reply.user }),
        ...(typeof reply.username === 'string' && { username: reply.username }),
        ...(typeof reply.team === 'string' && { teamId: reply.team }),
        ...(typeof reply.bot_id === 'string' && { botId: reply.bot_id })
      };
    }

    if (event?.subtype && event.subtype !== 'thread_broadcast') {
      return { text: '', ...(typeof event.bot_id === 'string' && { botId: event.bot_id }) };
    }

    return {
      ...(typeof event?.channel === 'string' && { channel: event.channel }),
      ...(typeof event?.thread_ts === 'string' && { threadTs: event.thread_ts }),
      ...(typeof event?.ts === 'string' && { messageTs: event.ts }),
      text: typeof event?.text === 'string' ? event.text : '',
      ...(typeof event?.user === 'string' && { userId: event.user }),
      ...(typeof event?.username === 'string' && { username: event.username }),
      ...(typeof event?.team === 'string' && { teamId: event.team }),
      ...(typeof event?.bot_id === 'string' && { botId: event.bot_id })
    };
  }

  private rememberThreadComment(key: string): void {
    this.seenThreadComments.add(key);
    if (this.seenThreadComments.size <= 500) return;
    const oldest = this.seenThreadComments.values().next().value;
    if (oldest) this.seenThreadComments.delete(oldest);
  }

  private async fetchSlackThreadReply(channel: string, threadTs: string, replyTs: string): Promise<any | undefined> {
    try {
      const response = await this.web.conversations.replies({
        channel,
        ts: threadTs,
        oldest: replyTs,
        latest: replyTs,
        inclusive: true,
        limit: 1
      });
      return response.messages?.find((message: any) => message?.ts === replyTs) ?? response.messages?.[0];
    } catch (err) {
      logger.warn(`Slack thread reply lookup failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async handleBlockAction(body: any): Promise<void> {
    const action = body?.actions?.[0];
    if (typeof action?.action_id !== 'string' || !action.action_id.startsWith(`${ACTION_ID_PREFIX}_`)) return;

    const value = parseActionValue(action.value);
    if (value.action === 'comment') {
      await this.openCommentModal(body, value);
      return;
    }

    const reviewer = reviewerFromBody(body);
    const target = this.rootTarget(body, value);
    const rootUpdate = target
      ? this.updateRootMessage(target, {
        phase: 'resuming',
        decision: value.action,
        reviewer
      }).catch((err) => {
        logger.warn(`Slack approval status update failed: ${(err as Error).message}`);
      })
      : Promise.resolve();
    const actionUpdate = this.updateActionMessage(body, value.action, reviewer).catch((err) => {
      logger.warn(`Slack approval action message update failed: ${(err as Error).message}`);
    });

    const start = Date.now();
    void this.options.onDecision({
      sessionId: value.sessionId,
      ...(value.projectId && { projectId: value.projectId }),
      resumeToken: value.resumeToken,
      toolResult: {
        status: value.action,
        ...(Object.keys(reviewer).length > 0 && { reviewer })
      }
    }).then(async () => {
      await rootUpdate;
      if (target) {
        void bestEffortClearSlackThreadStatus(this.web, target.channel, target.ts);
        await this.updateRootMessage(target, {
          phase: 'completed',
          decision: value.action,
          reviewer,
          durationMs: Date.now() - start
        });
      }
    }).catch(async (err) => {
      await rootUpdate;
      if (target) {
        void bestEffortClearSlackThreadStatus(this.web, target.channel, target.ts);
        await this.updateRootMessage(target, {
          phase: 'failed',
          decision: value.action,
          reviewer,
          durationMs: Date.now() - start,
          error: err
        });
      }
      logger.warn(`Slack approval resume failed: ${(err as Error).message}`);
    });
    void actionUpdate;
  }

  private async openCommentModal(body: any, value: ReturnType<typeof parseActionValue>): Promise<void> {
    const channel = typeof body?.channel?.id === 'string' ? body.channel.id : undefined;
    const messageTs = typeof body?.message?.ts === 'string' ? body.message.ts : undefined;
    const privateMetadata = JSON.stringify({
      ...value,
      ...(channel && { channel }),
      ...(messageTs && { messageTs })
    });

    await this.web.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: COMMENT_CALLBACK_ID,
        private_metadata: privateMetadata,
        title: {
          type: 'plain_text',
          text: 'AgentUse approval'
        },
        submit: {
          type: 'plain_text',
          text: 'Send'
        },
        close: {
          type: 'plain_text',
          text: 'Cancel'
        },
        blocks: [
          {
            type: 'input',
            block_id: COMMENT_BLOCK_ID,
            label: {
              type: 'plain_text',
              text: 'Comment'
            },
            element: {
              type: 'plain_text_input',
              action_id: COMMENT_INPUT_ID,
              multiline: true
            }
          }
        ]
      }
    });
  }

  private async handleViewSubmission(body: any): Promise<void> {
    if (body?.view?.callback_id !== COMMENT_CALLBACK_ID) return;

    const value = parseActionValue(body.view.private_metadata);
    const comment = findCommentValue(body.view.state?.values);
    const reviewer = reviewerFromBody(body);

    const metadata = JSON.parse(body.view.private_metadata) as { channel?: unknown; messageTs?: unknown };
    let actionUpdate: Promise<void> = Promise.resolve();
    if (typeof metadata.channel === 'string' && typeof metadata.messageTs === 'string') {
      actionUpdate = this.updateMessage(metadata.channel, metadata.messageTs, 'AgentUse approval comment received', resolvedBlocks('comment', reviewer, comment)).catch((err) => {
        logger.warn(`Slack approval action message update failed: ${(err as Error).message}`);
      });
    }

    const target = this.rootTarget(undefined, value);
    const rootUpdate = target
      ? this.updateRootMessage(target, {
        phase: 'resuming',
        decision: 'comment',
        reviewer
      }).catch((err) => {
        logger.warn(`Slack approval status update failed: ${(err as Error).message}`);
      })
      : Promise.resolve();

    const start = Date.now();
    void this.options.onDecision({
      sessionId: value.sessionId,
      ...(value.projectId && { projectId: value.projectId }),
      resumeToken: value.resumeToken,
      toolResult: {
        status: 'comment',
        comment,
        ...(Object.keys(reviewer).length > 0 && { reviewer })
      }
    }).then(async () => {
      await rootUpdate;
      if (target) {
        void bestEffortClearSlackThreadStatus(this.web, target.channel, target.ts);
        await this.updateRootMessage(target, {
          phase: 'completed',
          decision: 'comment',
          reviewer,
          durationMs: Date.now() - start
        });
      }
    }).catch(async (err) => {
      await rootUpdate;
      if (target) {
        void bestEffortClearSlackThreadStatus(this.web, target.channel, target.ts);
        await this.updateRootMessage(target, {
          phase: 'failed',
          decision: 'comment',
          reviewer,
          durationMs: Date.now() - start,
          error: err
        });
      }
      logger.warn(`Slack approval resume failed: ${(err as Error).message}`);
    });
    void actionUpdate;
  }

  private rootTarget(body: any, value: ReturnType<typeof parseActionValue>): { channel: string; ts: string; prompt: string; sessionId: string } | null {
    const channel = value.rootChannelId
      ?? (typeof body?.channel?.id === 'string' ? body.channel.id : undefined);
    const ts = value.rootMessageTs
      ?? (typeof body?.message?.thread_ts === 'string' ? body.message.thread_ts : undefined)
      ?? (typeof body?.message?.ts === 'string' ? body.message.ts : undefined);
    if (!channel || !ts) return null;
    return {
      channel,
      ts,
      prompt: value.prompt ?? 'Approval request',
      sessionId: value.sessionId
    };
  }

  private async updateRootMessage(
    target: { channel: string; ts: string; prompt: string; sessionId: string },
    options: {
      phase: 'resuming' | 'completed' | 'failed';
      decision: string;
      reviewer?: SlackApprovalDecision['toolResult']['reviewer'];
      durationMs?: number;
      error?: unknown;
    }
  ): Promise<void> {
    if (options.phase === 'resuming') {
      void bestEffortSlackThreadStatus(this.web, target.channel, target.ts, 'is working...');
    }
    await this.updateMessage(
      target.channel,
      target.ts,
      `AgentUse approval ${options.phase}`,
      buildStatusBlocks({
        phase: options.phase,
        prompt: target.prompt,
        sessionId: target.sessionId,
        decision: options.decision,
        ...(options.reviewer && { reviewer: options.reviewer }),
        ...(options.durationMs !== undefined && { durationMs: options.durationMs }),
        ...(options.error !== undefined && { error: options.error })
      })
    );
  }

  private async updateActionMessage(body: any, status: string, reviewer?: SlackApprovalDecision['toolResult']['reviewer']): Promise<void> {
    const channel = typeof body?.channel?.id === 'string' ? body.channel.id : undefined;
    const ts = typeof body?.message?.ts === 'string' ? body.message.ts : undefined;
    if (!channel || !ts) return;

    await this.updateMessage(channel, ts, `AgentUse approval received: ${status}`, resolvedBlocks(status, reviewer));
  }

  private async updateMessage(channel: string, ts: string, text: string, blocks: any[]): Promise<void> {
    await updateSlackRootMessage(this.web, { channel, ts, text, blocks });
  }
}
