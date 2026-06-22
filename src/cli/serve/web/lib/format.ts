import type { ApprovalLogEntry, ApprovalLogDetails, ApprovalPageInfo } from "../../types";
import type { StoreItem } from "../../../../store/types";

export function formatApprovalTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'Unknown';
}

export function formatLogTime(value?: number): string {
  return value ? new Date(value).toLocaleTimeString() : '';
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
  const json = JSON.stringify(data);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

export function detailsKey(details: ApprovalLogDetails | undefined): string {
  return details ? JSON.stringify(details) : '';
}

/** A `type: 'log'` operational entry at debug severity, hidden by default in the session view. */
export function isDebugLog(entry: ApprovalLogEntry): boolean {
  return entry.type === 'log' && entry.level === 'debug';
}

/** Render-identity for a log entry: when unchanged, the entry needs no re-render. */
export function logEntrySignature(entry: ApprovalLogEntry): string {
  return JSON.stringify([
    entry.status ?? null,
    entry.level ?? null,
    entry.message ?? null,
    entry.title,
    detailsKey(entry.details),
    entry.subagentSession ?? null,
  ]);
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

export function isEndedStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'error' || status === 'stopped' || status === 'timeout';
}

export function isLiveStatus(status: string, logs: ApprovalLogEntry[]): boolean {
  if (status === 'completed' || status === 'error' || status === 'expired' || status === 'failed' || status === 'stopped' || status === 'timeout') return false;
  if (status === 'run' || status === 'running' || status === 'resuming' || status === 'continuing') return true;
  return logs.some((entry) => entry.status === 'streaming' || entry.status === 'running');
}

export function sessionErrorText(approval: Pick<ApprovalPageInfo, 'sessionStatus' | 'errorCode' | 'errorMessage'> | undefined): string {
  if (!approval || approval.sessionStatus !== 'error') return '';
  if (!approval.errorCode && !approval.errorMessage) {
    return 'Session finished with an error. Check the session log for details.';
  }
  return `Session finished with an error: ${[
    approval.errorCode,
    approval.errorMessage
  ].filter(Boolean).join(': ')}`;
}
