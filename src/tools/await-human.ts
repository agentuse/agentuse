import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';
import { findServerForProject } from '../utils/server-registry';
import { sessionViewToken } from '../utils/session-token';
import { loadGlobalConfig } from '../utils/global-config';
import { isHttpUrl } from '../utils/url';

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

function getConfigPublicUrl(): string | undefined {
  // Best-effort: a malformed config.json should not crash an in-flight run at
  // approval time, so fall through to the next source instead of throwing.
  try {
    return loadGlobalConfig()?.serve?.publicUrl;
  } catch {
    return undefined;
  }
}

function getApprovalBaseUrl(projectRoot?: string): string {
  // Precedence: explicit env override > running serve daemon's registered URL >
  // serve.publicUrl from global config.json (so standalone `agentuse run`
  // honors it without a daemon) > local host:port fallback.
  const explicit = process.env.AGENTUSE_RESUME_PUBLIC_URL ?? process.env.AGENTUSE_SERVE_URL;
  const server = findServerForProject(projectRoot);
  return explicit
    ?? server?.publicUrl
    ?? getConfigPublicUrl()
    ?? `http://${server?.host ?? '127.0.0.1'}:${server?.port ?? 12233}`;
}

/**
 * Build the clickable link to a session's unified page `/sessions/<id>`. Carries
 * the SESSION token (HMAC(AGENTUSE_API_KEY, sessionId)): one token that grants
 * both view and approve for the whole session. When no api key is set (local
 * bind) there is no token to mint, so the link omits it and the page is fully
 * open. The worker inherits AGENTUSE_API_KEY from the serve process env. Used
 * for both approval gates and run cards — every session has this page.
 */
export function getSessionUrl(sessionId: string | undefined, projectRoot?: string): string | undefined {
  if (!sessionId) return undefined;
  const baseUrl = getApprovalBaseUrl(projectRoot);
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}`);
  const token = sessionViewToken(sessionId, process.env.AGENTUSE_API_KEY);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Build a deep link to a single rendered artifact: `/sessions/<id>/artifacts/<rel>`.
 * Reuses the SESSION token, so a viewer authorized for the session can open the
 * file. The `:id` segment only scopes auth — the server resolves `projectRelPath`
 * against the project root, so any project artifact is reachable with the current
 * session's token. `projectRelPath` must be project-root-relative and POSIX-style.
 */
export function getArtifactUrl(
  sessionId: string | undefined,
  projectRelPath: string,
  projectRoot?: string
): string | undefined {
  if (!sessionId) return undefined;
  const baseUrl = getApprovalBaseUrl(projectRoot);
  const encodedPath = projectRelPath
    .split('/')
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join('/');
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodedPath}`);
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
      prompt: z.string().describe('One short line: a direct yes/no question for the reviewer. Do not put the content, headings, or lists here; use draft for that.'),
      summary: z.string().optional().describe('A few sentences on what changed and what is being approved. Rendered as Markdown under "Why this request".'),
      draft: z.string().optional().describe('The full reviewable work itself, written in Markdown (headings, bullet lists, tables, fenced code). This is the primary artifact the reviewer reads, so make it complete, not a one-line summary.'),
      draft_url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('URL to a non-primary draft artifact'),
      artifact_url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('External URL to the primary review artifact, such as a PR, hosted preview, or document'),
      artifact_path: z.string().optional().describe('Path, relative to the project root, to a local file artifact you created (e.g. .agentuse/artifacts/report.html). The reviewer can open it in a popup viewer. Prefer this over inlining long or HTML content into draft. For more than one file, use artifact_paths.'),
      artifact_paths: z.array(z.string()).optional().describe('Multiple local file artifacts to review, each a path relative to the project root. Each renders as its own openable tile in the popup viewer.'),
      context: z.string().optional().describe('Real background, constraints, inputs used, and work completed so far. Rendered as Markdown.'),
      risk: z.string().optional().describe('Concrete risks, unresolved questions, or areas needing reviewer attention. Rendered as Markdown.')
    }),
    execute: async ({ prompt }: {
      prompt: string;
      summary?: string;
      draft?: string;
      draft_url?: string;
      artifact_url?: string;
      artifact_path?: string;
      artifact_paths?: string[];
      context?: string;
      risk?: string;
    }) => {
      const timeoutMs = parseTimeout(defaults?.timeout);
      const expiresAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
      const resumeToken = randomBytes(24).toString('base64url');
      const approvalUrl = getSessionUrl(sessionId, defaults?.projectRoot);

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
