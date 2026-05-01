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
  resumeToken: string;
  action: string;
}): string {
  return JSON.stringify({
    ...(options.sessionId && { sessionId: options.sessionId }),
    ...(options.projectId && { projectId: options.projectId }),
    resumeToken: options.resumeToken,
    action: options.action
  });
}

function parseActionValue(value: unknown): {
  sessionId: string;
  projectId?: string;
  resumeToken: string;
  action: string;
} {
  if (typeof value !== 'string') {
    throw new Error('Slack approval action is missing a value');
  }
  const parsed = JSON.parse(value) as {
    sessionId?: unknown;
    projectId?: unknown;
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
    resumeToken: parsed.resumeToken,
    action: parsed.action
  };
}

function buildApprovalBlocks(request: SlackApprovalRequest): any[] {
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*AgentUse approval requested*\n${truncate(request.prompt, 2500)}`
      }
    }
  ];

  if (request.summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Summary*\n${truncate(request.summary, 2800)}`
      }
    });
  }

  if (request.artifactUrl) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Review artifact*\n${request.artifactUrl}`
      }
    });
  }

  if (request.draft) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft*\n${truncate(request.draft, 2800)}`
      }
    });
  }

  if (request.draftUrl) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft URL*\n${request.draftUrl}`
      }
    });
  }

  if (request.context) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Context*\n${truncate(request.context, 2000)}`
      }
    });
  }

  if (request.risk) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Risk / notes*\n${truncate(request.risk, 2000)}`
      }
    });
  }

  blocks.push({
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
        resumeToken: request.resumeToken,
        action: action.id
      }),
      ...(action.style && { style: action.style })
    }))
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Session \`${request.sessionId ?? 'unknown'}\` expires ${request.expiresAt}`
      }
    ]
  });

  return blocks;
}

export const __testing = {
  buildApprovalBlocks,
  resolvedBlocks,
  resumeFailedBlocks
};

export async function sendSlackApprovalRequest(request: SlackApprovalRequest): Promise<SlackApprovalMessage> {
  if (!request.sessionId) {
    throw new Error('Slack approval requires a session id');
  }

  const web = new WebClient(request.botToken);
  const response = await web.chat.postMessage({
    channel: request.channelId,
    text: `AgentUse approval requested: ${request.prompt}`,
    blocks: buildApprovalBlocks(request)
  });

  const channel = typeof response.channel === 'string' ? response.channel : request.channelId;
  const ts = typeof response.ts === 'string' ? response.ts : undefined;
  if (!ts) {
    throw new Error('Slack approval message was sent but Slack did not return a message timestamp');
  }

  return { channel, ts };
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

function originalReviewBlocks(blocks: unknown): any[] {
  if (!Array.isArray(blocks)) return [];

  return blocks
    .filter((block: any) => block?.type !== 'actions')
    .map((block: any, index) => {
      if (
        index === 0 &&
        block?.type === 'section' &&
        block?.text?.type === 'mrkdwn' &&
        typeof block.text.text === 'string'
      ) {
        return {
          ...block,
          text: {
            ...block.text,
            text: block.text.text.replace('*AgentUse approval requested*', '*Approved request*')
          }
        };
      }
      return block;
    });
}

function resolvedBlocks(status: string, reviewer?: SlackApprovalDecision['toolResult']['reviewer'], comment?: string, originalBlocks?: unknown): any[] {
  const who = reviewer?.id ? `<@${reviewer.id}>` : 'A reviewer';
  const commentText = comment ? `\n>${truncate(comment, 1500)}` : '';
  const details = originalReviewBlocks(originalBlocks);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*AgentUse approval ${statusLabel(status)}*\n${who} submitted \`${status}\`. AgentUse is resuming the session.${commentText}`
      }
    },
    ...(details.length > 0 ? [{ type: 'divider' }, ...details] : [])
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
        await this.handleBlockAction(body);
        return;
      }

      if (body?.type === 'view_submission') {
        await this.handleViewSubmission(body);
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
    await this.updateOriginalMessage(body, value.action, reviewer);

    void this.options.onDecision({
      sessionId: value.sessionId,
      ...(value.projectId && { projectId: value.projectId }),
      resumeToken: value.resumeToken,
      toolResult: {
        status: value.action,
        ...(Object.keys(reviewer).length > 0 && { reviewer })
      }
    }).catch(async (err) => {
      await this.updateOriginalMessageFailure(body, value.action, value.sessionId, err, reviewer);
      logger.warn(`Slack approval resume failed: ${(err as Error).message}`);
    });
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
    if (typeof metadata.channel === 'string' && typeof metadata.messageTs === 'string') {
      await this.updateMessage(metadata.channel, metadata.messageTs, 'AgentUse approval received: comment', resolvedBlocks('comment', reviewer, comment));
    }

    void this.options.onDecision({
      sessionId: value.sessionId,
      ...(value.projectId && { projectId: value.projectId }),
      resumeToken: value.resumeToken,
      toolResult: {
        status: 'comment',
        comment,
        ...(Object.keys(reviewer).length > 0 && { reviewer })
      }
    }).catch(async (err) => {
      if (typeof metadata.channel === 'string' && typeof metadata.messageTs === 'string') {
        await this.updateMessage(
          metadata.channel,
          metadata.messageTs,
          'AgentUse approval resume failed',
          resumeFailedBlocks({ status: 'comment', sessionId: value.sessionId, error: err, reviewer })
        );
      }
      logger.warn(`Slack approval resume failed: ${(err as Error).message}`);
    });
  }

  private async updateOriginalMessage(body: any, status: string, reviewer?: SlackApprovalDecision['toolResult']['reviewer']): Promise<void> {
    const channel = typeof body?.channel?.id === 'string' ? body.channel.id : undefined;
    const ts = typeof body?.message?.ts === 'string' ? body.message.ts : undefined;
    if (!channel || !ts) return;

    await this.updateMessage(channel, ts, `AgentUse approval received: ${status}`, resolvedBlocks(status, reviewer, undefined, body?.message?.blocks));
  }

  private async updateOriginalMessageFailure(
    body: any,
    status: string,
    sessionId: string,
    error: unknown,
    reviewer?: SlackApprovalDecision['toolResult']['reviewer']
  ): Promise<void> {
    const channel = typeof body?.channel?.id === 'string' ? body.channel.id : undefined;
    const ts = typeof body?.message?.ts === 'string' ? body.message.ts : undefined;
    if (!channel || !ts) return;

    await this.updateMessage(
      channel,
      ts,
      'AgentUse approval resume failed',
      resumeFailedBlocks({ status, sessionId, error, reviewer })
    );
  }

  private async updateMessage(channel: string, ts: string, text: string, blocks: any[]): Promise<void> {
    await this.web.chat.update({ channel, ts, text, blocks });
  }
}
