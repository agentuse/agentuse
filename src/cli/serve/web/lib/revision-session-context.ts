import { buildRunTranscript } from '../../../../session/run-transcript';
import { fetchSessionStatus } from './api';

/** Older daemons omit the context from a changeset but still serve its session. */
export async function loadRevisionSessionContext(projectId: string, sessionId: string, originHref?: string): Promise<string> {
  // A reviser's token cannot authorize its source session. Only use the token
  // belonging to the source link supplied by the server.
  const token = originHref ? new URL(originHref, 'http://localhost').searchParams.get('token') ?? undefined : undefined;
  const payload = await fetchSessionStatus(sessionId, token, projectId, 5000);
  return buildRunTranscript(payload.logs ?? payload.approval.logs, 80_000, {
    focus: 'latest-attempt',
    terminal: {
      status: payload.approval.sessionStatus ?? payload.status,
      ...(payload.approval.errorCode && { errorCode: payload.approval.errorCode }),
      ...(payload.approval.errorMessage && { errorMessage: payload.approval.errorMessage }),
    },
  });
}

/** Show the recorded outcome; the original session link provides full details. */
export function revisionSessionSummary(transcript: string): { label: string; message: string } {
  const terminal = transcript.match(/(?:^|\n\n)Current terminal error(?: \([^\n]+\))?:\n([\s\S]+)$/);
  if (terminal) return { label: 'Why this session stopped', message: terminal[1]!.trim() };

  const blocks = transcript.split(/\n\n(?=Agent output:|User continuation:|Tool |Error |Reviewed work:|Current terminal error|Transcript scope:)/).reverse();
  const response = blocks.find((block) => block.startsWith('Agent output:\n'));
  if (response) return { label: 'Last response', message: response.slice('Agent output:\n'.length).trim() };
  const error = blocks.find((block) => block.startsWith('Error '));
  if (error) return { label: 'Last recorded error', message: error.replace(/^Error /, '').trim() };
  return { label: 'Session activity', message: 'No final response was recorded. Open the original session for details.' };
}

export function revisionContextLoadError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 404) return 'The original session could not be found. You can retry or check the session link above.';
  if (status === 401 || status === 403) return 'Access to this session was denied. Open the session link above to check your access, then retry.';
  return 'The original session could not be loaded. Try again, or open the session link above.';
}
