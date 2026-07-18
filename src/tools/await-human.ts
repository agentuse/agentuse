import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';
import { findServerForProject } from '../utils/server-registry';
import { sessionViewToken } from '../utils/session-token';
import { loadGlobalConfig } from '../utils/global-config';
import { isHttpUrl } from '../utils/url';
import { parseDurationMs } from '../utils/duration';

function parseTimeout(value?: string | number): number | undefined {
  if (value === undefined || value === '') return undefined;
  // Bare numbers are SECONDS, matching every other timeout field. (Before
  // v0.16 a bare number here meant milliseconds, which expired gates almost
  // instantly - no one can have depended on that on purpose.)
  return parseDurationMs(value, { bareUnit: 'seconds', field: 'approval.timeout' });
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
  timeout?: string | number;
  slack?: { channelId?: string };
  projectRoot?: string;
}

export function createAwaitHumanTool(sessionId?: string, defaults?: AwaitHumanDefaults): Tool {
  return {
    description: 'Suspend the current run while waiting for a reviewer decision or comment. The run resumes when a decision is submitted from the approval page or Approval API. The tool result carries the decision: `status` (approved/rejected/commented), optional `comment`, and (when you supplied `options`) `choice`, the id of the option the reviewer selected. Always branch on `choice` when present instead of parsing the comment.',
    inputSchema: z.object({
      prompt: z.string().describe('One short line: a direct yes/no question for the reviewer. Do not put the content, headings, or lists here; use draft for that.'),
      summary: z.string().optional().describe('A few sentences on what changed and what is being approved. Rendered as Markdown under "Why this request".'),
      draft: z.string().optional().describe('The full reviewable work itself, written in Markdown (headings, bullet lists, tables, fenced code). This is the primary artifact the reviewer reads, so make it complete, not a one-line summary. When the approved action is a short submission (a comment, an email, a post), put the verbatim content in changes instead and use draft for the supporting detail.'),
      changes: z.array(z.object({
        label: z.string().optional().describe('Short name for this action, e.g. "Comment to post", "Then: Like the post", "Email body"'),
        content: z.string().describe('The exact, final content or action, verbatim: what will literally be submitted on approval')
      })).optional().describe('The exact actions executed on approval, one entry per discrete action, in order. Rendered as highlighted "On approval" boxes the reviewer skims first, so put ONLY final verbatim content here; rationale belongs in summary or context.'),
      reference: z.object({
        label: z.string().optional().describe('Relationship of the original to this action, e.g. "Replying to" or "In response to"'),
        author: z.string().optional().describe('Who created the original, e.g. "Alexandra Griffon (CEO, BlueCargo)"'),
        title: z.string().optional().describe('Title or one-line descriptor of the original'),
        url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('Link to the original'),
        excerpt: z.string().optional().describe('The quoted text of the original that the reviewer needs in order to judge the response')
      }).optional().describe('The original item this action responds to (the post being commented on, the message being replied to, the document being amended). Rendered as a quoted card directly above the changes.'),
      draft_url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('URL to a non-primary draft artifact'),
      artifact_url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('External URL to the primary review artifact, such as a PR, hosted preview, or document'),
      artifact_path: z.string().optional().describe('Path, relative to the project root, to a local file artifact you created (e.g. .agentuse/artifacts/report.html). The reviewer can open it in a popup viewer. Prefer this over inlining long or HTML content into draft. For more than one file, use artifact_paths.'),
      artifact_paths: z.array(z.string()).optional().describe('Multiple local file artifacts to review, each a path relative to the project root. Each renders as its own openable tile in the popup viewer.'),
      options: z.array(z.object({
        id: z.string().min(1).describe('Stable key you will branch on when the decision comes back, e.g. "candidate-1". Unique within this request.'),
        label: z.string().min(1).describe('Short human-readable name of this alternative, shown on the option card and on the approve button'),
        description: z.string().optional().describe('One or two sentences on what picking this option means. Rendered as Markdown on the option card. Keep the full detail in draft; this is the skim line.'),
        recommended: z.boolean().optional().describe('Mark exactly one option as your recommendation; it is preselected for the reviewer')
      })).min(2).optional().describe('When the decision is a pick among alternatives (candidates, variants, strategies) rather than a plain yes/no, list them here: the reviewer gets a single-select menu instead of having to type the pick into a comment. On approval the tool result carries the selected id as `choice`. Reject and comment stay available as escape hatches, so do not add "reject all" or "other" as options.'),
      context: z.string().optional().describe('Only background the other fields do not already carry: constraints, inputs used, process notes. Never repeat the reference, changes, or summary content (no restating the target, URL, or revision story). Omit entirely when nothing extra remains. Rendered as Markdown.'),
      risk: z.string().optional().describe('Concrete risks, unresolved questions, or areas needing reviewer attention. Rendered as Markdown.')
    }),
    execute: async ({ prompt }: {
      prompt: string;
      summary?: string;
      draft?: string;
      changes?: Array<{ label?: string; content: string }>;
      reference?: { label?: string; author?: string; title?: string; url?: string; excerpt?: string };
      draft_url?: string;
      artifact_url?: string;
      artifact_path?: string;
      artifact_paths?: string[];
      options?: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
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
