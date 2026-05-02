import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';
import { sendSlackApprovalRequest } from '../slack/approval';
import { findServerForProject } from '../utils/server-registry';

const DEFAULT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

function parseTimeout(value?: string): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const match = value.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return DEFAULT_TIMEOUT_MS;
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

function getResumeUrl(sessionId?: string, projectRoot?: string): string | undefined {
  if (!sessionId) return undefined;
  const base = getApprovalBaseUrl(projectRoot);
  return `${base.replace(/\/$/, '')}/resume/${sessionId}`;
}

export function getApprovalUrl(sessionId: string | undefined, resumeToken: string, projectId?: string, projectRoot?: string): string | undefined {
  if (!sessionId) return undefined;
  const base = getApprovalBaseUrl(projectRoot);
  const url = new URL(`${base.replace(/\/$/, '')}/approvals/${encodeURIComponent(sessionId)}`);
  url.searchParams.set('token', resumeToken);
  if (projectId) url.searchParams.set('project', projectId);
  return url.toString();
}

function resolveEnvVariables(value: string): string {
  return value.replace(/\$\{env:(\w+)\}/g, (match, varName) => process.env[varName] ?? match);
}

export interface AwaitHumanDefaults {
  channel?: 'slack' | 'webhook';
  url?: string;
  channelId?: string;
  timeout?: string;
  actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
  projectRoot?: string;
}

export function createAwaitHumanTool(sessionId?: string, defaults?: AwaitHumanDefaults): Tool {
  return {
    description: 'Suspend the current run while waiting for a reviewer decision or comment. The run resumes when a result is posted to the resume endpoint.',
    inputSchema: z.object({
      prompt: z.string().describe('Review prompt shown to the human'),
      summary: z.string().optional().describe('Short summary of what was prepared and what the reviewer is approving'),
      draft: z.string().optional().describe('Draft content to review'),
      draft_url: z.string().url().optional().describe('URL to a draft artifact'),
      artifact_url: z.string().url().optional().describe('URL to the primary review artifact, such as a PR, document, preview, or generated artifact'),
      context: z.string().optional().describe('Relevant background, constraints, or work completed so far'),
      risk: z.string().optional().describe('Known risks, unresolved questions, or special reviewer attention areas'),
      actions: z.array(z.object({
        id: z.string(),
        label: z.string(),
        style: z.enum(['primary', 'danger']).optional()
      })).optional().describe('Optional structured actions such as approve, reject, or comment'),
      channel: z.enum(['slack', 'webhook']).optional().describe('Notifier channel. Slack uses Socket Mode; webhook posts a notification payload to approval.url.'),
      channel_id: z.string().optional().describe('Slack channel id for approval messages'),
      timeout: z.string().optional().describe('Suspension timeout like 24h or 7d')
    }),
    execute: async ({ prompt, summary, draft, draft_url, artifact_url, context, risk, actions, channel, channel_id, timeout }: {
      prompt: string;
      summary?: string;
      draft?: string;
      draft_url?: string;
      artifact_url?: string;
      context?: string;
      risk?: string;
      actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
      channel?: 'slack' | 'webhook';
      channel_id?: string;
      timeout?: string;
    }) => {
      const configuredUrl = defaults?.url ? resolveEnvVariables(defaults.url) : undefined;
      const notifyUrl = configuredUrl ?? process.env.AGENTUSE_AWAIT_HUMAN_WEBHOOK_URL;
      const effectiveTimeout = timeout ?? defaults?.timeout;
      const effectiveChannel = channel ?? defaults?.channel ?? (notifyUrl ? 'webhook' : 'slack');
      const effectiveActions = actions ?? defaults?.actions;
      const slackChannelId = channel_id ?? defaults?.channelId ?? process.env.SLACK_APPROVAL_CHANNEL;
      const expiresAt = Date.now() + parseTimeout(effectiveTimeout);
      const resumeToken = randomBytes(24).toString('base64url');
      const projectId = process.env.AGENTUSE_PROJECT_ID;
      const resumeUrl = getResumeUrl(sessionId, defaults?.projectRoot);
      const approvalUrl = getApprovalUrl(sessionId, resumeToken, projectId, defaults?.projectRoot);

      if (effectiveChannel === 'webhook' && !notifyUrl) {
        throw new Error('approval.channel is "webhook", but no approval.url or AGENTUSE_AWAIT_HUMAN_WEBHOOK_URL is configured');
      }

      if (notifyUrl) {
        const response = await fetch(notifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'agentuse.await_human',
            sessionId,
            prompt,
            summary,
            draft,
            draft_url,
            artifact_url,
            context,
            risk,
            actions: effectiveActions,
            resumeUrl,
            approvalUrl,
            resumeToken,
            expiresAt: new Date(expiresAt).toISOString()
          })
        });

        if (!response.ok) {
          throw new Error(`await_human notifier failed: ${response.status} ${response.statusText}`);
        }
      }

      let slackNotification: { type: 'slack-message'; channel: string; ts: string; url: string } | undefined;
      if (effectiveChannel === 'slack') {
        const botToken = process.env.SLACK_BOT_TOKEN;
        if (!botToken || !slackChannelId || !approvalUrl) {
          throw new Error('approval.channel is "slack", but SLACK_BOT_TOKEN, approval.channel_id or SLACK_APPROVAL_CHANNEL, and a session id are required');
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
          expiresAt: new Date(expiresAt).toISOString()
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
        channel: effectiveChannel,
        expiresAt,
        resumeToken,
        ...(approvalUrl && { approvalUrl }),
        ...(slackNotification
          ? { notification: slackNotification }
          : notifyUrl
            ? { notification: {
              type: 'webhook',
              url: notifyUrl
            } }
            : {})
      });
    }
  };
}
