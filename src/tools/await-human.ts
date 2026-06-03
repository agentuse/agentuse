import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';
import { findServerForProject } from '../utils/server-registry';
import { sessionViewToken } from '../utils/session-token';

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
  const server = findServerForProject(projectRoot);
  return explicit ?? server?.publicUrl ?? `http://${server?.host ?? '127.0.0.1'}:${server?.port ?? 12233}`;
}

/**
 * Build the clickable link for an await_human gate. Points at the unified
 * session page `/sessions/<id>` and carries the SESSION token
 * (HMAC(AGENTUSE_API_KEY, sessionId)), not the gate resumeToken: one token that
 * grants both view and approve for the whole session. When no api key is set
 * (local bind) there is no token to mint, so the link omits it and the page is
 * fully open. The worker inherits AGENTUSE_API_KEY from the serve process env.
 */
export function getApprovalUrl(sessionId: string | undefined, _resumeToken: string, _projectId?: string, projectRoot?: string): string | undefined {
  if (!sessionId) return undefined;
  const baseUrl = getApprovalBaseUrl(projectRoot);
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}`);
  const token = sessionViewToken(sessionId, process.env.AGENTUSE_API_KEY);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export interface AwaitHumanDefaults {
  timeout?: string;
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
    execute: async ({ prompt }: {
      prompt: string;
      summary?: string;
      draft?: string;
      draft_url?: string;
      artifact_url?: string;
      context?: string;
      risk?: string;
    }) => {
      const timeoutMs = parseTimeout(defaults?.timeout);
      const expiresAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
      const resumeToken = randomBytes(24).toString('base64url');
      const approvalUrl = getApprovalUrl(sessionId, resumeToken, undefined, defaults?.projectRoot);

      let channelRequest: { type: 'slack-message'; channel: string } | undefined;
      if (defaults?.slack) {
        const botToken = process.env.SLACK_BOT_TOKEN;
        const slackChannelId = defaults.slack.channelId ?? process.env.SLACK_APPROVAL_CHANNEL;
        if (!botToken || !slackChannelId || !approvalUrl) {
          throw new Error('Slack approval channels require SLACK_BOT_TOKEN, channels.slack.channel_id or SLACK_APPROVAL_CHANNEL, and a session id');
        }

        channelRequest = {
          type: 'slack-message',
          channel: slackChannelId
        };
      }

      throw new SuspendSignal({
        kind: 'await_human',
        prompt,
        surface: 'web',
        ...(expiresAt !== undefined && { expiresAt }),
        resumeToken,
        ...(approvalUrl && { approvalUrl }),
        ...(channelRequest ? { channelRequest } : {})
      });
    }
  };
}
