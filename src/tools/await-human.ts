import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';
import { sendSlackApprovalRequest } from '../slack/approval';
import { findServerForProject } from '../utils/server-registry';

function parseTimeout(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return amount * multipliers[unit];
}

function getApprovalBaseUrl(projectRoot?: string): string {
  const explicit = process.env.AGENTUSE_RESUME_PUBLIC_URL ?? process.env.AGENTUSE_SERVE_URL;
  if (explicit) return explicit;
  const server = findServerForProject(projectRoot);
  return server?.publicUrl ?? `http://${server?.host ?? '127.0.0.1'}:${server?.port ?? 12233}`;
}

export function getApprovalUrl(sessionId: string | undefined, resumeToken: string, projectId?: string, projectRoot?: string): string | undefined {
  if (!sessionId) return undefined;
  const base = getApprovalBaseUrl(projectRoot);
  const url = new URL(`${base.replace(/\/$/, '')}/approvals/${encodeURIComponent(sessionId)}`);
  url.searchParams.set('token', resumeToken);
  if (projectId) url.searchParams.set('project', projectId);
  return url.toString();
}

export interface AwaitHumanDefaults {
  timeout?: string;
  actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
  slack?: { channelId?: string };
  projectRoot?: string;
}

export function createAwaitHumanTool(sessionId?: string, defaults?: AwaitHumanDefaults): Tool {
  return {
    description: 'Suspend the current run while waiting for a reviewer decision or comment. The run resumes when a decision is submitted from the approval page or Approval API.',
    inputSchema: z.object({
      prompt: z.string().describe('Review prompt shown to the human'),
      summary: z.string().optional().describe('Short summary of what was prepared and what the reviewer is approving'),
      draft: z.string().optional().describe('Draft content to review'),
      draft_url: z.string().url().optional().describe('URL to a draft artifact'),
      artifact_url: z.string().url().optional().describe('URL to the primary review artifact, such as a PR, document, preview, or generated artifact'),
      context: z.string().optional().describe('Relevant background, constraints, or work completed so far'),
      risk: z.string().optional().describe('Known risks, unresolved questions, or special reviewer attention areas')
    }),
    execute: async ({ prompt, summary, draft, draft_url, artifact_url, context, risk }: {
      prompt: string;
      summary?: string;
      draft?: string;
      draft_url?: string;
      artifact_url?: string;
      context?: string;
      risk?: string;
    }) => {
      const effectiveActions = defaults?.actions;
      const timeoutMs = parseTimeout(defaults?.timeout);
      const expiresAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
      const resumeToken = randomBytes(24).toString('base64url');
      const projectId = process.env.AGENTUSE_PROJECT_ID;
      const approvalUrl = getApprovalUrl(sessionId, resumeToken, projectId, defaults?.projectRoot);

      let slackNotification: { type: 'slack-message'; channel: string; ts: string; url: string } | undefined;
      if (defaults?.slack) {
        const botToken = process.env.SLACK_BOT_TOKEN;
        const slackChannelId = defaults.slack.channelId ?? process.env.SLACK_APPROVAL_CHANNEL;
        if (!botToken || !slackChannelId || !approvalUrl) {
          throw new Error('Slack approval notifications require SLACK_BOT_TOKEN, notifications.channels.slack.channel_id or SLACK_APPROVAL_CHANNEL, and a session id');
        }

        const message = await sendSlackApprovalRequest({
          botToken,
          channelId: slackChannelId,
          ...(sessionId && { sessionId }),
          ...(projectId && { projectId }),
          prompt,
          ...(summary && { summary }),
          ...(draft && { draft }),
          ...(draft_url && { draftUrl: draft_url }),
          ...(artifact_url && { artifactUrl: artifact_url }),
          ...(context && { context }),
          ...(risk && { risk }),
          ...(effectiveActions && { actions: effectiveActions }),
          resumeToken,
          approvalUrl,
          ...(expiresAt !== undefined && { expiresAt: new Date(expiresAt).toISOString() })
        });
        slackNotification = {
          type: 'slack-message',
          channel: message.channel,
          ts: message.ts,
          url: approvalUrl
        };
      }

      throw new SuspendSignal({
        kind: 'await_human',
        prompt,
        channel: 'web',
        ...(expiresAt !== undefined && { expiresAt }),
        resumeToken,
        ...(approvalUrl && { approvalUrl }),
        ...(slackNotification ? { notification: slackNotification } : {})
      });
    }
  };
}
