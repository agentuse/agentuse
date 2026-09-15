/** The common log fields available in both worker and browser payloads. */
export interface RunTranscriptEntry {
  type: string;
  title: string;
  tool?: string | undefined;
  message?: string | undefined;
  status?: string | undefined;
  level?: string | undefined;
  details?: {
    input?: string | undefined;
    output?: string | undefined;
    errorMessage?: string | undefined;
    draft?: string | undefined;
  } | undefined;
}

// Compact transcript of what the agent did in a run — its text output, tool
// calls (name + truncated input/output), and any reviewed draft — pulled from
// the session log the daemon already holds in-process. Used to ground a manual
// instruction in the run the reviewer was looking at.
export function buildRunTranscript(
  logs: readonly RunTranscriptEntry[] | undefined,
  maxChars = 6000,
  options: {
    focus?: 'earliest' | 'latest' | 'latest-attempt';
    terminal?: { status?: string; errorCode?: string; errorMessage?: string };
  } = {},
): string {
  const clip = (s: string | undefined, n: number): string => {
    if (!s) return '';
    const t = s.trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const blocks: string[] = [];
  const allLogs = logs ?? [];
  let latestContinuationIndex = -1;
  if (options.focus === 'latest-attempt') {
    for (let index = allLogs.length - 1; index >= 0; index -= 1) {
      const entry = allLogs[index]!;
      if (entry.type === 'text' && entry.title === 'User response') {
        latestContinuationIndex = index;
        break;
      }
    }
  }
  const scopedLogs = latestContinuationIndex >= 0 ? allLogs.slice(latestContinuationIndex) : allLogs;
  if (options.focus === 'latest-attempt') {
    blocks.push(latestContinuationIndex >= 0
      ? 'Transcript scope: latest execution attempt after the most recent user continuation.'
      : 'Transcript scope: latest execution attempt.');
  }
  for (const e of scopedLogs) {
    if (e.type === 'text' && e.message?.trim()) {
      const label = e.title === 'User response' ? 'User continuation' : 'Agent output';
      blocks.push(`${label}:\n${clip(e.message, 4000)}`);
    } else if (e.type === 'tool') {
      const io = [
        e.details?.input ? `input ${clip(e.details.input, 300)}` : '',
        e.details?.output ? `output ${clip(e.details.output, 500)}` : '',
        e.details?.errorMessage ? `error ${clip(e.details.errorMessage, 500)}` : '',
        !e.details && e.status === 'error' && e.message ? `error ${clip(e.message, 500)}` : '',
      ].filter(Boolean).join(' → ');
      blocks.push(`Tool ${e.tool ?? e.title}${io ? `: ${io}` : ''}`);
    } else if (e.type === 'error' || (e.type === 'log' && e.level === 'error')) {
      blocks.push(`Error ${e.title}${e.message?.trim() ? `:\n${clip(e.message, 1000)}` : ''}`);
    } else if (e.details?.draft?.trim()) {
      blocks.push(`Reviewed work:\n${clip(e.details.draft, 1500)}`);
    }
  }

  const terminal = options.terminal;
  if (terminal?.status === 'error' && terminal.errorMessage) {
    const code = terminal.errorCode ? ` (${terminal.errorCode})` : '';
    blocks.push(`Current terminal error${code}:\n${clip(terminal.errorMessage, 4000)}`);
  }

  const out = blocks.join('\n\n');
  if (out.length <= maxChars) return out;
  if (options.focus !== 'latest' && options.focus !== 'latest-attempt') {
    return out.slice(0, maxChars) + '\n…(truncated)';
  }

  const marker = '…(earlier activity omitted; showing the latest session activity)';
  const budget = Math.max(0, maxChars - marker.length - 2);
  const selected: string[] = [];
  let selectedLength = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const separatorLength = selected.length > 0 ? 2 : 0;
    if (selectedLength + separatorLength + block.length > budget) continue;
    selected.unshift(block);
    selectedLength += separatorLength + block.length;
  }
  return `${marker}\n\n${selected.join('\n\n')}`;
}
