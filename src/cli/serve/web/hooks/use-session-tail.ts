import { useEffect, useState } from 'preact/hooks';
import type { ApprovalLogEntry } from '../../types';

/** Latest displayable moment of a live session, for one-line tickers. */
export interface SessionTail {
  text: string;
  /** Set when the tail is a tool call (styled distinctly from prose). */
  tool?: string;
}

/** Compact "tools · web_search"-style label, mirroring the session view's chip. */
function toolLabel(tool: string): string {
  const segments = tool.split('__').filter(Boolean);
  if (segments.length > 1 && segments[0] === 'tools') segments.shift();
  return segments.join(' · ');
}

/**
 * The one line of a log entry worth showing in a ticker: streaming prose keeps
 * its last non-empty line, tool calls show the tool name, operational logs show
 * their title. Debug noise and structural entries yield nothing.
 */
function tailFrom(entry: ApprovalLogEntry): SessionTail | null {
  if (entry.type === 'log' && entry.level === 'debug') return null;
  if (entry.type === 'tool') {
    return entry.tool ? { text: toolLabel(entry.tool), tool: entry.tool } : null;
  }
  if (entry.type === 'text' || entry.type === 'reasoning') {
    const lines = (entry.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    return last ? { text: last } : null;
  }
  if (entry.type === 'log') return entry.title ? { text: entry.title } : null;
  return null;
}

/**
 * Follow a session's live log over SSE and keep only its latest displayable
 * line. Deliberately minimal next to useApprovalStream: no polling fallback and
 * no error surface — if the stream can't open (token-gated daemon, session not
 * yet on disk) the ticker just stays empty and the caller shows its static
 * fallback. `enabled: false` opens nothing, so callers can cap how many
 * concurrent EventSources a page holds.
 */
export function useSessionTail(sessionId: string, project: string, enabled: boolean): SessionTail | null {
  const [tail, setTail] = useState<SessionTail | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const url = new URL(`/sessions/${encodeURIComponent(sessionId)}/events`, location.origin);
    url.searchParams.set('project', project);
    const source = new EventSource(url);
    source.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse((event as MessageEvent).data) as ApprovalLogEntry;
        const next = tailFrom(entry);
        if (next) setTail(next);
      } catch {
        /* malformed frame; keep the last good tail */
      }
    });
    source.addEventListener('error', () => {
      // CLOSED means the browser won't retry (401/404); give up quietly.
      if (source.readyState === EventSource.CLOSED) source.close();
    });
    return () => {
      source.close();
      setTail(null);
    };
  }, [sessionId, project, enabled]);

  return enabled ? tail : null;
}
