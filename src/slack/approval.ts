import { SocketModeClient, LogLevel as SlackSocketLogLevel } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger';

export interface SlackApprovalAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

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
  actions?: SlackApprovalAction[];
  resumeToken: string;
  expiresAt: string;
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

const ACTION_ID_PREFIX = 'agentuse_approval_action';
const COMMENT_CALLBACK_ID = 'agentuse_approval_comment';
const COMMENT_BLOCK_ID = 'comment';
const COMMENT_INPUT_ID = 'value';

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 12))}\n...(truncated)`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function fallbackActions(actions?: SlackApprovalAction[]): SlackApprovalAction[] {
  return actions && actions.length > 0
    ? actions
    : [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'danger' },
      { id: 'comment', label: 'Comment' }
    ];
}

function actionIdFor(action: SlackApprovalAction, index: number): string {
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
    elements: fallbackActions(request.actions).map((action, index) => ({
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
        text: `Session \`${request.sessionId ?? 'unknown'}\` expires ${request.expiresAt}`
      }
    ]
  }];
}

function buildApprovalBlocks(request: SlackApprovalRequest): any[] {
  return [
    ...buildStatusBlocks({
      phase: 'waiting',
      prompt: request.prompt,
      ...(request.sessionId && { sessionId: request.sessionId }),
      expiresAt: request.expiresAt
    }),
    ...buildDetailThreadMessages(request).flatMap(message => message.blocks),
    ...buildActionBlocks(request)
  ];
}

export const __testing = {
  buildApprovalBlocks,
  buildActionBlocks,
  buildDetailThreadMessages,
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
  const response = await postSlackApprovalMessage(web, request.channelId, {
    channel: request.channelId,
    text: `AgentUse approval requested: ${request.prompt}`,
    blocks: buildStatusBlocks({
      phase: 'waiting',
      prompt: request.prompt,
      ...(request.sessionId && { sessionId: request.sessionId }),
      expiresAt: request.expiresAt
    })
  });

  const channel = typeof response.channel === 'string' ? response.channel : request.channelId;
  const ts = typeof response.ts === 'string' ? response.ts : undefined;
  if (!ts) {
    throw new Error('Slack approval message was sent but Slack did not return a message timestamp');
  }

  for (const message of buildDetailThreadMessages(request)) {
    await postSlackApprovalMessage(web, channel, {
      channel,
      thread_ts: ts,
      text: message.text,
      blocks: message.blocks
    });
  }

  await postSlackApprovalMessage(web, channel, {
    channel,
    thread_ts: ts,
    text: 'AgentUse approval actions',
    blocks: buildActionBlocks({
      ...request,
      rootChannelId: channel,
      rootMessageTs: ts
    })
  });

  return { channel, ts };
}

async function postSlackApprovalMessage(web: WebClient, channelId: string, payload: any) {
  try {
    return await web.chat.postMessage(payload);
  } catch (err) {
    const message = slackApprovalPostErrorMessage(channelId, err);
    if (message) throw new Error(message);
    throw err;
  }
}

function slackApprovalPostErrorMessage(channelId: string, err: unknown): string | undefined {
  const errorCode = slackApiErrorCode(err);
  if (errorCode !== 'channel_not_found') return undefined;
  return `Slack could not post approval request to channel "${channelId}" (channel_not_found). Check that SLACK_BOT_TOKEN belongs to the same Slack workspace as the channel, the bot is a member of private channels, and no exported shell env var is overriding ~/.agentuse/.env.`;
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
        text: `*Decision recorded*\n${who} submitted \`${status}\`. The channel message is the source of truth for status.${commentText}`
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

  constructor(private readonly options: {
    appToken: string;
    botToken: string;
    onDecision: (decision: SlackApprovalDecision) => Promise<void>;
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
      actionUpdate = this.updateMessage(metadata.channel, metadata.messageTs, 'AgentUse approval received: comment', resolvedBlocks('comment', reviewer, comment)).catch((err) => {
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
    await this.web.chat.update({ channel, ts, text, blocks });
  }
}
