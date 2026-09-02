import type { ApprovalLogEntry, ApprovalLogDetails, ApprovalPageInfo } from "../../types";
import type { StoreItem } from "../../../../store/types";
import {
  isExecutingSessionStatus,
  isLiveSessionStatus,
  isProjectedTerminalSessionStatus,
  sessionOutcome,
} from "../../../../session/status";

export function formatApprovalTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'Unknown';
}

/** Prefer the configured human name; otherwise show the agent filename rather
 * than an opaque normalized id. */
export function displayAgentName(name: string | undefined, filePath: string | undefined, id: string): string {
  const human = name?.trim();
  if (human && human !== id && !human.includes('/') && !human.endsWith('.agentuse')) return human;
  return filePath?.split(/[\\/]/).pop()?.replace(/\.agentuse$/, '') || human || id;
}

export function formatLogTime(value?: number): string {
  return value ? new Date(value).toLocaleTimeString() : '';
}

/**
 * Token counts at reading size: "8.0k", "19k", "1M". One decimal below ten
 * thousand, where the difference between 8.0k and 8.9k is worth seeing, and
 * none above it. A trailing `.0` is dropped at million scale, since a window
 * limit reads worse as "1.0M" than as "1M".
 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString();
}

/**
 * Compact relative time ("3m ago", "2h ago", "5d ago") for list rows; falls back
 * to a localized date past a week. Pair with `title={formatApprovalTime(value)}`
 * so the exact timestamp stays available on hover.
 */
export function formatRelativeTime(value?: number, now: number = Date.now()): string {
  if (!value) return 'Unknown';
  const diff = now - value;
  if (diff < 0) return formatApprovalTime(value);
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(value).toLocaleDateString();
}

/**
 * Coerce a possibly-non-string error field to displayable text. Guards against an
 * object slipping through the API and rendering as the useless "[object Object]".
 */
export function errorText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

export function isJsonLikeContent(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function looksLikeMarkdown(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /(^|\n)(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|```|\|.+\|)/.test(trimmed) ||
    /\[[^\]]+\]\([^)]+\)/.test(trimmed) ||
    /\*\*[^*]+\*\*/.test(trimmed) ||
    /https?:\/\/[^\s)]+/.test(trimmed) ||
    /`[^`]+`/.test(trimmed);
}

export function valueAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function storeItemTitle(item: StoreItem): string {
  if (item.title) return item.title;
  const data = valueAsRecord(item.data);
  const candidates = ['title', 'name', 'headline', 'subject', 'url'];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return item.id;
}

/**
 * One-line, human-readable summary of an arbitrary store value for a lede.
 * Strings pass through (whitespace-collapsed and truncated); objects and arrays
 * become a shape summary ("object · 4 keys: createdBy, publish, …", "array · 3
 * items") rather than a wall of raw JSON, naming a couple of short scalar keys
 * first since those read as real content. Raw JSON stays available elsewhere.
 */
export function humanizeStoreValue(value: unknown, max = 180): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const compact = value.trim().replace(/\s+/g, ' ');
    return compact.length > max ? `${compact.slice(0, max)}…` : compact;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array · ${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 0) return 'object · empty';
    const isShortScalar = (k: string): boolean => {
      const v = rec[k];
      return (typeof v === 'string' && v.length <= 40) || typeof v === 'number' || typeof v === 'boolean';
    };
    const ordered = [...keys].sort((a, b) => Number(isShortScalar(b)) - Number(isShortScalar(a)));
    const shown = ordered.slice(0, 2);
    const suffix = keys.length > shown.length ? ', …' : '';
    return `object · ${keys.length} key${keys.length === 1 ? '' : 's'}: ${shown.join(', ')}${suffix}`;
  }
  return String(value);
}

export function storeItemPreview(item: StoreItem, max = 180): string {
  const data = valueAsRecord(item.data);
  const candidates = ['summary', 'description', 'note_excerpt', 'excerpt', 'draft', 'body', 'content', 'why_engage'];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.trim().replace(/\s+/g, ' ');
      return compact.length > max ? `${compact.slice(0, max)}…` : compact;
    }
  }
  if (Object.keys(data).length === 0) return '';
  return humanizeStoreValue(item.data, max);
}

/**
 * Serializing an entry is pure, and both entries and their details are replaced
 * wholesale on update rather than mutated in place, so object identity is a
 * sound cache key. Without this the memo comparator in log-entry.tsx
 * re-stringifies every entry's full payload on each render pass.
 */
const detailsKeyCache = new WeakMap<ApprovalLogDetails, string>();
const entrySignatureCache = new WeakMap<ApprovalLogEntry, string>();

export function detailsKey(details: ApprovalLogDetails | undefined): string {
  if (!details) return '';
  const cached = detailsKeyCache.get(details);
  if (cached !== undefined) return cached;
  const key = JSON.stringify(details);
  detailsKeyCache.set(details, key);
  return key;
}

/** A `type: 'log'` operational entry at debug severity, hidden by default in the session view. */
export function isDebugLog(entry: ApprovalLogEntry): boolean {
  return entry.type === 'log' && entry.level === 'debug';
}

/** Render-identity for a log entry: when unchanged, the entry needs no re-render. */
export function logEntrySignature(entry: ApprovalLogEntry): string {
  const cached = entrySignatureCache.get(entry);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify([
    entry.status ?? null,
    entry.level ?? null,
    entry.message ?? null,
    entry.title,
    detailsKey(entry.details),
    entry.subagentSession ?? null,
  ]);
  entrySignatureCache.set(entry, signature);
  return signature;
}

export function latestReviewerComment(logs: ApprovalLogEntry[]): { comment: string; reviewer?: string; status?: string } | undefined {
  for (const entry of [...logs].reverse()) {
    const details = entry.details;
    if (!details?.decisionComment) continue;
    return {
      comment: details.decisionComment,
      ...(details.decisionReviewer && { reviewer: details.decisionReviewer }),
      ...(details.decisionStatus && { status: details.decisionStatus })
    };
  }
  return undefined;
}

/**
 * error + a self-describing errorCode (USER_STOPPED / TIMEOUT / INCOMPLETE)
 * surface as their own label, matching the server's child-session rendering.
 */
export function displayStatusLabel(status: string, errorCode?: string | undefined): string {
  const outcome = sessionOutcome(status, errorCode);
  if (outcome && outcome !== 'completed' && outcome !== 'error') return outcome;
  if (outcome === 'error') {
    // Ended by the reconcile sweep, not by anything the run itself did: it was
    // parked on a delegated sub-agent that had already ended. Naming that beats
    // a bare "error" — the failure is one level down, not here.
    if (errorCode === 'CASCADE_ORPHANED') return 'subagent ended';
  }
  return status;
}

/** Color/tone bucket for a session's raw status, shared by every run-health
 *  visual (last-run cells, sparklines): running beats waiting beats outcome.
 *  Unknown statuses read as failures rather than silently passing as ok. */
export type RunTone = 'running' | 'waiting' | 'ok' | 'failed';
export function runTone(status: string): RunTone {
  if (isExecutingSessionStatus(status)) return 'running';
  if (status === 'completed') return 'ok';
  if (status === 'suspended' || status === 'waiting') return 'waiting';
  return 'failed';
}

/** Is this run in flight right now? The single source of truth behind every
 *  "running now" affordance (live dots, project live counts, sort order), so
 *  they can't drift apart. Kept in lockstep with runTone's 'running' bucket. */
export function isRunningStatus(status: string | undefined): boolean {
  return status !== undefined && runTone(status) === 'running';
}

export function isEndedStatus(status: string | undefined): boolean {
  return isProjectedTerminalSessionStatus(status);
}

export function isLiveStatus(status: string, logs: ApprovalLogEntry[]): boolean {
  if (isProjectedTerminalSessionStatus(status)) return false;
  if (isLiveSessionStatus(status)) return true;
  return logs.some((entry) => entry.status === 'streaming' || entry.status === 'running');
}

export function sessionErrorText(approval: Pick<ApprovalPageInfo, 'sessionStatus' | 'errorCode' | 'errorMessage'> | undefined): string {
  if (!approval || approval.sessionStatus !== 'error') return '';
  if (approval.errorCode === 'INCOMPLETE') {
    return `Agent reported the run incomplete${approval.errorMessage ? `: ${approval.errorMessage}` : '.'}`;
  }
  if (!approval.errorCode && !approval.errorMessage) {
    return 'Session finished with an error. Check the session log for details.';
  }
  return `Session finished with an error: ${[
    approval.errorCode,
    approval.errorMessage
  ].filter(Boolean).join(': ')}`;
}

/** "substack_notes_published" -> "Substack notes published". Shared by the
 *  Home metric tiles and the session result card's recorded-metric chips. */
export function humanizeMetric(name: string): string {
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Split a run's final response into its verdict headline and the report body.
 *
 * An agent that declares its outcome through `report_complete` delivers
 * "Complete: <headline>" followed by an optional Markdown body. Rendered as one
 * blob the headline reads as an ordinary paragraph, smaller than the headings
 * beneath it and repeating the status pill's own icon. Split here so the card
 * can lead with the headline and let the body be the body.
 *
 * Browser-safe on purpose: this repeats one line of the runtime's composition
 * rather than importing tools/report-outcome, which would drag `ai` and `zod`
 * into the web bundle. Runs that predate the outcome tools carry no such line
 * and fall through with their whole text as `body`.
 */
export function splitOutcomeHeadline(text: string): { headline?: string; body: string } {
  const match = /^\s*(?:✅\s*Complete|⚠️?\s*Incomplete)\s*:\s*(.+?)\s*(?:\n|$)/.exec(text);
  if (!match) return { body: text };
  const headline = match[1]!.trim();
  if (!headline) return { body: text };
  return { headline, body: text.slice(match[0].length).trim() };
}
