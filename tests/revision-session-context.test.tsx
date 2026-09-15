import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import renderToString from 'preact-render-to-string';
import { buildRunTranscript } from '../src/session/run-transcript';
import { RevisionSessionContext } from '../src/cli/serve/web/components/revision-session-context';
import { loadRevisionSessionContext, revisionContextLoadError, revisionSessionSummary } from '../src/cli/serve/web/lib/revision-session-context';

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
});

describe('revision session context', () => {
  it('loads older changesets from the source session and preserves errors without text logs', async () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://localhost' } });
    let requested: URL | undefined;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requested = new URL(String(input));
      return Response.json({ success: true, status: 'error', logs: [], approval: {
        sessionStatus: 'error', errorCode: 'INCOMPLETE', errorMessage: 'Another run is waiting for review.',
      } });
    });
    const transcript = await loadRevisionSessionContext('my project', 'origin-session', '/sessions/origin-session?token=source-token');
    expect(requested!.pathname).toBe('/sessions/origin-session/status');
    expect(requested!.searchParams.get('project')).toBe('my project');
    expect(requested!.searchParams.get('token')).toBe('source-token');
    expect(requested!.searchParams.get('logsLimit')).toBe('5000');
    expect(revisionSessionSummary(transcript)).toEqual({ label: 'Why this session stopped', message: 'Another run is waiting for review.' });
  });

  it('prefers the latest terminal outcome over earlier successful messages', () => {
    const transcript = buildRunTranscript([{ id: '1', type: 'text', title: 'Response', message: 'An earlier response.' }], 80_000, {
      focus: 'latest-attempt', terminal: { status: 'error', errorCode: 'TIMEOUT', errorMessage: 'The run timed out.' },
    });
    expect(revisionSessionSummary(transcript).message).toBe('The run timed out.');
  });

  it('keeps the latest response together, including its paragraphs', () => {
    expect(revisionSessionSummary('Agent output:\nFirst response.\n\nTool check\n\nAgent output:\nFinal response.\n\nSecond paragraph.')).toEqual({
      label: 'Last response', message: 'Final response.\n\nSecond paragraph.',
    });
  });

  it('renders only the outcome and retains the source link for details', () => {
    const html = renderToString(<RevisionSessionContext
      projectId="demo" sessionId="origin-session" originHref="/sessions/origin-session?token=source-token"
      transcript={'Tool inspect: checked the queue\n\nCurrent terminal error (INCOMPLETE):\nAnother run is waiting for review.'}
    />);
    expect(html).toContain('Original session');
    expect(html).toContain('href="/sessions/origin-session?token=source-token"');
    expect(html).toContain('Another run is waiting for review.');
    expect(html).not.toContain('View session activity');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('Tool inspect');
    expect(html).not.toContain('no longer available');
  });

  it('shows a loading message until an older session has been fetched', () => {
    const html = renderToString(<RevisionSessionContext projectId="demo" sessionId="origin-session" />);
    expect(html).toContain('Loading the original session');
    expect(html).not.toContain('could not be found');
  });

  it('distinguishes a missing session from temporary and access failures', () => {
    expect(revisionContextLoadError({ status: 404 })).toContain('could not be found');
    expect(revisionContextLoadError({ status: 503 })).toContain('could not be loaded');
    expect(revisionContextLoadError({ status: 401 })).toContain('Access');
    expect(revisionContextLoadError(new Error('offline'))).not.toContain('no longer');
  });
});
