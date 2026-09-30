import type { Tool } from 'ai';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { SuspendSignal } from '../runner/suspend';
import { findServerForProject } from '../utils/server-registry';
import { readApiKey, sessionViewToken } from '../utils/session-token';
import { loadGlobalConfig } from '../utils/global-config';
import { isHttpUrl } from '../utils/url';
import { parseDurationMs } from '../utils/duration';
import { findXmlToolMarkup } from '../runner/tool-call-repair';
import { setTransportInputNormalizer } from './tool-contract';
import { snapshotGateArtifacts } from '../session/gate-artifacts';

/**
 * Words that mean "this gate authorizes a response to something someone else
 * wrote". Such a gate is unjudgeable without the original in front of the
 * reviewer, so `reference.excerpt` is mandatory for it (see the superRefine
 * below). Deliberately narrow: "post", "publish", and "send" are excluded
 * because a fresh post or a cold email answers nothing and has no original.
 */
const RESPONSE_INTENT_RE = /\b(?:repl(?:y|ies|ying)|comment(?:ing)?|respond(?:ing)?|response|answer(?:ing)?|rebut(?:tal|ting)?)\b/i;

/**
 * Explicit elision markers only. A real post can legitimately trail off in an
 * ellipsis, so a bare "..." is not evidence of truncation; a bracketed or
 * parenthesized marker is the agent saying out loud that it cut the text.
 */
const TRUNCATION_MARKER_RE = /\[\s*(?:\.{3}|…|truncated|snip|abridged|full text|continues)[^\]]*\]|\(\s*(?:truncated|snipped|abridged|shortened|full text|continues)[^)]*\)/i;

/**
 * A leading executable, optionally behind `$`/`sudo`/env assignments. Matched
 * against the first non-empty line of a change's `content`.
 */
const COMMAND_CONTENT_RE = /^\s*(?:\$\s*)?(?:sudo\s+)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:uv|uvx|python3?|node|npx|bun|pnpm|yarn|npm|deno|bash|sh|zsh|curl|wget|gh|git|docker|make|ruby|php|go|cargo|java|osascript|open)\b/;

/**
 * Above this, a bare command is a wall of shell hiding a payload the reviewer
 * actually needs to read; below it (`git push`, `make deploy`) the command IS
 * the whole story and a displayContent restatement would be noise.
 */
const COMMAND_PAYLOAD_MIN_LENGTH = 200;

/** Every surface that states the gate's intent, minus the bodies being drafted. */
function gateIntentText(val: {
  prompt?: string | undefined;
  changes?: Array<{ label?: string | undefined }> | undefined;
}): string {
  return [val.prompt ?? '', ...(val.changes ?? []).map((change) => change.label ?? '')].join('\n');
}

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
 * open. The serve worker receives AGENTUSE_API_KEY from serve (see readApiKey). Used
 * for both approval gates and run cards — every session has this page.
 */
export function getSessionUrl(sessionId: string | undefined, projectRoot?: string): string | undefined {
  if (!sessionId) return undefined;
  const baseUrl = getApprovalBaseUrl(projectRoot);
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}`);
  const token = sessionViewToken(sessionId, readApiKey());
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
  const token = sessionViewToken(sessionId, readApiKey());
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

export interface AwaitHumanDefaults {
  timeout?: string | number;
  slack?: { channelId?: string };
  projectRoot?: string;
}

const EMPTY_OPTIONAL_STRING_FIELDS = [
  'summary',
  'draft',
  'draft_url',
  'artifact_url',
  'artifact_path',
  'context',
  'risk',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitBlankString(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] === 'string' && !record[key].trim()) delete record[key];
}

/**
 * Some providers fill every optional tool field after a resumed turn, using
 * empty strings, empty objects and empty arrays as placeholders. Those values
 * mean "not supplied" in an approval request, but validating them literally
 * creates misleading errors such as "options needs at least two items". That
 * error can push the model into inventing an Approve/Reject pick gate.
 *
 * Normalize only semantically empty optional values. Non-empty malformed data
 * remains untouched and is rejected by the canonical schema as before.
 */
export function normalizeAwaitHumanInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const normalized: Record<string, unknown> = { ...input };

  for (const field of EMPTY_OPTIONAL_STRING_FIELDS) omitBlankString(normalized, field);
  for (const field of ['options', 'artifact_paths', 'changes'] as const) {
    if (Array.isArray(normalized[field]) && normalized[field].length === 0) delete normalized[field];
  }

  if (Array.isArray(normalized.changes)) {
    normalized.changes = normalized.changes.map((change) => {
      if (!isRecord(change)) return change;
      const next = { ...change };
      // A thread is a list of posts. Keep the list as displayParts for the
      // card and join it into displayContent for every text surface (Slack,
      // the judge, replay), so downstream code only ever sees one string.
      const listed = Array.isArray(next.displayContent) ? next.displayContent : Array.isArray(next.displayParts) ? next.displayParts : undefined;
      if (listed) {
        const parts = listed.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).map((part) => part.trim());
        delete next.displayParts;
        if (parts.length > 1) {
          next.displayParts = parts;
          next.displayContent = parts.join('\n\n');
        } else {
          next.displayContent = parts[0];
        }
      }
      if (Array.isArray(next.media_urls)) {
        const mediaUrls = [...new Set(next.media_urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0).map((url) => url.trim()))];
        if (mediaUrls.length > 0) next.media_urls = mediaUrls;
        else delete next.media_urls;
      }
      for (const field of ['label', 'displayContent', 'optionId']) omitBlankString(next, field);
      return next;
    });
  }

  if (isRecord(normalized.reference)) {
    const reference = { ...normalized.reference };
    for (const field of ['label', 'author', 'title', 'url', 'excerpt']) omitBlankString(reference, field);
    if (Object.keys(reference).length === 0) delete normalized.reference;
    else normalized.reference = reference;
  }

  return normalized;
}

export function createAwaitHumanTool(sessionId?: string, defaults?: AwaitHumanDefaults): Tool {
  return setTransportInputNormalizer({
    description: 'Make the decision complete in the visible review surface: use changes for actions, with exact content, media, destination and timing; use saved artifacts for standalone deliverables. Create artifacts before calling this tool. Draft, context and summary are optional background and must never be the only place essential review information appears. Send arguments as a valid JSON object, never XML tool syntax. Put options and reference in their own top-level JSON fields, never serialized inside context. Use plain language about the outcome and the decision needed; do not make the reviewer choose routine implementation details. Suspend the current run while waiting for a reviewer decision or comment. The run resumes when a decision is submitted from the approval page or Approval API. Decide the SHAPE of the request first: a plain yes/no on one proposed action, or a pick among alternatives. A pick MUST carry its alternatives in `options` - that field is what renders the selector, so without it the reviewer gets an approve/reject card and no way to choose. Never present alternatives as prose, numbered blocks, or several `changes` entries and ask the reviewer to name their pick in a comment; that is a defect, not a formatting preference. The tool result carries the decision: `status` (approved/rejected/commented), optional `comment`, and (when you supplied `options`) `choice`, the id of the option the reviewer selected. Always branch on `choice` when present instead of parsing the comment. A human Comment is the revise-and-re-gate branch and takes precedence over missing-choice ambiguity: when its text supplies an actionable edit or replacement, apply it even if it names no option, then request approval again. Only an explicit request to cancel, abandon, or stop is terminal. A result with `source: "pre-review"` or `source: "gate-preflight"` is machine feedback, not a human rejection: revise the request and call await_human again. When the action responds to something someone else wrote - a reply, comment, answer, or response - `reference` is mandatory and its `excerpt` must hold the COMPLETE verbatim original, because the reviewer judges the response against it and must never have to open the link to read it.',
    inputSchema: z.preprocess(normalizeAwaitHumanInput, z.object({
      prompt: z.string().max(300, 'prompt must be one short line (max 300 characters); put the content in draft and the alternatives in options').describe('One short line: a direct yes/no question for the reviewer, or on a pick gate the single question the options answer. Do not put the content, headings, or lists here; use changes or saved artifacts for the work, and options for alternatives - never spell the choices out here.'),
      summary: z.string().max(600, 'summary must be one sentence (max 600 characters); the card already shows the candidates, the reference and the reviewer actions').optional().describe('Optional background only; omit by default and never put essential review information only here. ONE sentence: what is being decided, or on a pick gate what separates the alternatives. Rendered under "Why this request". Do NOT restate the candidate content, the reference, or the actions available to the reviewer - the card already shows all three, so repeating them just adds reading. Do not open with praise for the reviewer\'s earlier feedback. Omit entirely when the options and their descriptions already make the choice clear.'),
      draft: z.string().optional().describe('Legacy inline Markdown, retained for compatibility. Omit in new requests. Put actions in changes; for standalone deliverables, create and save an artifact before calling this tool and pass artifact_path, artifact_paths, or artifact_url.'),
      changes: z.array(z.object({
        label: z.string().optional().describe('Visible action heading. Include destination account/platform and timing when applicable, e.g. "Publish to Instagram @example immediately". Mention material revisions here or in prompt without changing the exact submitted text.'),
        content: z.string().describe('The exact, final content or action, verbatim: what will literally be submitted on approval'),
        displayContent: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe('Human-facing business content to feature above `content` when `content` must be an executable command. REQUIRED (validation rejects the call without it) once such a command carries an embedded payload. For a post, reply, email, or message, use the exact body without the CLI wrapper. For a thread or any multi-post submission, pass a LIST of strings, one per post in order; never join posts with a made-up separator. The review body supports Markdown (headings, lists, emphasis, links, and fenced code). Preserve the exact body; do not add formatting that is absent from the submitted payload. The UI keeps the command visible but visually secondary.'),
        displayParts: z.array(z.string()).optional().describe('Set automatically when displayContent is a list. Do not set it yourself.'),
        media_urls: z.array(z.string().url().refine(isHttpUrl, 'must be an http(s) URL')).min(1).optional().describe('External image, video, or audio URLs that are part of this exact action and should render inline under "On approval" for review. Include the public MP4 URL when the action publishes a video.'),
        optionId: z.string().min(1).optional().describe('For a pick gate, the options[].id that authorizes this action. Omit for an action that should run regardless of the selected option.')
      })).optional().describe('The exact actions executed on approval, one entry per discrete action, in order. Rendered as highlighted "On approval" content. When `content` is an executable command, also provide `displayContent` so the reviewer sees the business content first and the exact command de-emphasized beneath it. Rationale belongs in summary or context.'),
      reference: z.object({
        label: z.string().optional().describe('Relationship of the original to this action, e.g. "Replying to" or "In response to"'),
        author: z.string().optional().describe('Who created the original, e.g. "Alexandra Griffon (CEO, BlueCargo)"'),
        title: z.string().optional().describe('Title or one-line descriptor of the original'),
        url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('Link to the original'),
        excerpt: z.string().optional().describe('The COMPLETE verbatim text of the original, copied as-is. Not a summary, not a paraphrase, not the first few lines: the reviewer judges the response against this text and must never have to open the URL to read what is being answered. Copy the whole post, message, or comment body. Existing Markdown is rendered in the review card; preserve it as-is. Never elide with "..." or "[truncated]"; if the original is genuinely long, include all of it anyway.')
      }).optional().describe('The original item this action responds to (the post being commented on, the message being replied to, the document being amended). Rendered as a quoted card beside the changes. REQUIRED whenever the approved action is a response to something someone else wrote, and `excerpt` is required with it.'),
      draft_url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('URL to a non-primary draft artifact'),
      artifact_url: z.string().url().refine(isHttpUrl, 'must be an http(s) URL').optional().describe('External URL to the primary review artifact, such as a PR, hosted preview, or document'),
      artifact_path: z.string().optional().describe('Primary review surface for a standalone deliverable. FIRST create and save the file using tools__artifact_save when available or another suitable creation tool; wait for success, then pass its returned project-relative path here. Existing files can be referenced directly. Never invent a path. The reviewer sees an expanded preview and can open the artifact. For multiple files use artifact_paths.'),
      artifact_paths: z.array(z.string()).optional().describe('Multiple local file artifacts to review, each a path relative to the project root. Each renders as its own openable tile in the popup viewer.'),
      options: z.array(z.object({
        id: z.string().min(1).describe('Stable key you will branch on when the decision comes back, e.g. "candidate-1". Unique within this request.'),
        label: z.string().min(1).describe('Short human-readable name of this alternative, shown on the option card and on the approve button'),
        description: z.string().max(500, 'an option description is the skim line (max 500 characters); the full detail belongs in the artifact or in the option\'s changes entry').optional().describe('One or two sentences on what picking this option means. Rendered as Markdown on the option card. Keep the complete action in the option\'s changes entry or the standalone deliverable in an artifact; this is the skim line.'),
        recommended: z.boolean().optional().describe('Mark exactly one option as your recommendation; it is preselected for the reviewer')
      })).min(2).optional().describe('When the decision is a pick among alternatives (candidates, variants, strategies) rather than a plain yes/no, list them here: the reviewer gets a single-select menu instead of having to type the pick into a comment. On approval the tool result carries the selected id as `choice`. Reject and comment stay available as escape hatches, so do not add "reject all" or "other" as options.'),
      context: z.string().max(4000, 'context must stay background (max 4000 characters); the work under review belongs in artifacts or changes').optional().describe('Optional background only; omit by default and never put essential review information only here. Only background the other fields do not already carry: constraints, inputs used, process notes. Never repeat the reference, changes, or summary content (no restating the target, URL, or revision story). In particular, the original being responded to does NOT go here - it belongs in `reference.excerpt`, where the card renders it beside the response. Omit entirely when nothing extra remains. Rendered as Markdown.'),
      risk: z.string().max(300, 'risk must be one line (max 300 characters) naming the real-world consequence').optional().describe('ONE line, and only when approving causes something genuinely hard to undo: a public post, a payment, an email, a deletion. Name the real-world consequence ("this posts publicly and cannot be edited"), never AgentUse\'s internal gate, lease, or approval machinery - you cannot observe it and describing it misleads the reviewer. Do not restate UI state such as which option is preselected. Omit when the action is reversible.')
    }).superRefine((val, ctx) => {
      const optionIds = new Set<string>();
      for (const [index, option] of (val.options ?? []).entries()) {
        if (optionIds.has(option.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['options', index, 'id'],
            message: `duplicate option id "${option.id}"`,
          });
        }
        optionIds.add(option.id);
      }
      for (const [index, change] of (val.changes ?? []).entries()) {
        if (change.optionId && !optionIds.has(change.optionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['changes', index, 'optionId'],
            message: `optionId "${change.optionId}" does not reference an options[].id in this request`,
          });
        }
      }

      // An executable `content` carrying an embedded payload (a post body, an
      // email, a JSON blob) renders as a wall of shell: the reviewer approves a
      // public action without ever reading it. displayContent is the only field
      // that surfaces the business content, so require it here rather than
      // hoping the field description is honoured.
      for (const [index, change] of (val.changes ?? []).entries()) {
        const content = change.content ?? '';
        const firstLine = content.split('\n').find((line) => line.trim()) ?? '';
        const hasDisplay = typeof change.displayContent === 'string'
          ? Boolean(change.displayContent.trim())
          : Boolean(change.displayContent?.some((part) => part.trim()));
        if (!hasDisplay && content.length > COMMAND_PAYLOAD_MIN_LENGTH && COMMAND_CONTENT_RE.test(firstLine)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['changes', index, 'displayContent'],
            message:
              'this change\'s content is an executable command carrying a payload, so displayContent is required: set it to ' +
              'the exact human-facing content the command submits (the post, reply, email, or message body, verbatim, ' +
              'without the CLI wrapper). The card shows displayContent first and keeps the command visible but secondary; ' +
              'without it the reviewer approves a wall of shell they cannot read.',
          });
        }
      }

      // A reviewer cannot judge a response without the thing being responded
      // to. Agents routinely bury the original in `context` prose, elide it to
      // a line, or ship a bare URL — each of which forces the human to leave
      // the card, open the source, and rebuild the context the agent already
      // had. These three rules make that unrepresentable.
      const excerpt = val.reference?.excerpt?.trim() ?? '';
      if (val.reference && !excerpt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reference', 'excerpt'],
          message:
            'reference.excerpt is required whenever reference is present: paste the COMPLETE verbatim text of the original ' +
            '(post, message, comment, ticket) here. A reference carrying only an author, title, or url makes the reviewer ' +
            'open the link to read what is being answered, which is the exact work the gate exists to save.',
        });
      } else if (!val.reference && RESPONSE_INTENT_RE.test(gateIntentText(val))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reference'],
          message:
            'this gate approves a response to something, so it must carry reference: { author, url, excerpt } with the ' +
            'COMPLETE verbatim text of the original in excerpt. Do not put the original in context or summary - the card ' +
            'renders reference beside the response so the reviewer can judge both without opening the source. If you no ' +
            'longer hold the original text, re-fetch it before requesting approval.',
        });
      }
      if (excerpt && TRUNCATION_MARKER_RE.test(excerpt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reference', 'excerpt'],
          message:
            'reference.excerpt is truncated (it contains an elision marker). Include the original in full, however long it ' +
            'is - a reviewer who has to open the link for the rest of the text is back to doing the reading by hand.',
        });
      }

      // Approval cards are the one surface where XML-drifted input fails
      // silently (a human sees a garbled card instead of the model seeing an
      // error), so reject it at validation time. The runner's repairToolCall
      // (tool-call-repair.ts) then un-smuggles the fields deterministically;
      // only an unrepairable call surfaces this message to the model.
      if (findXmlToolMarkup(val) || [val.prompt, val.summary, val.context, val.risk].some(
        // The model can also copy the prompt's field tags directly, without
        // <parameter> wrappers. Keep literal source/draft content unrestricted.
        (text) => text !== undefined && /<\/(?:context|summary|prompt|risk)>\s*<(?:options|reference|changes|draft)\b|<options>\s*\[/.test(text),
      )) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'input contains XML tool-call markup (e.g. </parameter>, <parameter name="...">, or </context><options>). ' +
            'Re-issue await_human as a pure JSON tool call: each field (summary, changes, context, risk, ...) ' +
            'must be its own JSON property, with no XML tags inside string values. Put choices in the top-level options array, not in context.'
        });
      }
    })),
    execute: async (input: {
      prompt: string;
      summary?: string;
      draft?: string;
      changes?: Array<{ label?: string; content: string; displayContent?: string | string[]; displayParts?: string[]; media_urls?: string[]; optionId?: string }>;
      reference?: { label?: string; author?: string; title?: string; url?: string; excerpt?: string };
      draft_url?: string;
      artifact_url?: string;
      artifact_path?: string;
      artifact_paths?: string[];
      options?: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
      context?: string;
      risk?: string;
    }) => {
      const { prompt } = input;
      const timeoutMs = parseTimeout(defaults?.timeout);
      const expiresAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
      const resumeToken = randomBytes(24).toString('base64url');
      const approvalUrl = getSessionUrl(sessionId, defaults?.projectRoot);

      // Freeze every declared artifact before suspending. Failure is
      // intentionally fatal to this tool call: opening an approval with a live
      // mutable fallback would misrepresent the bytes the human approved.
      let artifactSnapshots: Awaited<ReturnType<typeof snapshotGateArtifacts>> = [];
      if (sessionId && defaults?.projectRoot) {
        artifactSnapshots = await snapshotGateArtifacts(
          defaults.projectRoot,
          sessionId,
          input as Record<string, unknown>
        );
      }

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
        ...(channelRequest ? { channelRequest } : {}),
        ...(artifactSnapshots.length > 0 && { artifactSnapshots })
      });
    }
  }, normalizeAwaitHumanInput);
}
