import { describe, expect, it } from 'bun:test';
import { processAgentStream } from '../src/runner/stream';
import type { AgentChunk } from '../src/runner/types';

async function* makeStream(chunks: AgentChunk[]): AsyncGenerator<AgentChunk> {
  for (const chunk of chunks) yield chunk;
}

const outcome = (details?: string): AgentChunk => ({
  type: 'tool-call',
  toolName: 'report_outcome',
  toolCallId: 'call_outcome',
  toolInput: { status: 'complete', headline: 'Listed the 5 largest downloads', ...(details && { details }) },
});

describe('report text without tool-call narration', () => {
  it('drops the one-line notes that only announced a tool call', async () => {
    const result = await processAgentStream(makeStream([
      { type: 'text', text: "I'll get the 5 largest files from your Downloads folder." },
      { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'call_1', toolInput: { command: 'du -sh ~/Downloads/*' } },
      { type: 'tool-result', toolCallId: 'call_1', toolResult: '174M a.zip' },
      { type: 'text', text: "Now I'll parse and sort these results to display them properly:" },
      { type: 'tool-call', toolName: 'code_exec', toolCallId: 'call_2', toolInput: { code: 'return 1' } },
      { type: 'tool-result', toolCallId: 'call_2', toolResult: '1' },
      outcome('1. 174M a.zip'),
    ]));

    expect(result.reportText).toBe('');
    expect(result.text).toContain("I'll get the 5 largest files");
    const delivered = result.parts.filter((part) => part.type === 'text').at(-1) as { text: string };
    expect(delivered.text).toBe('✅ Complete: Listed the 5 largest downloads\n\n1. 174M a.zip');
  });

  it('keeps a document streamed before a tool call and prose after the last one', async () => {
    const document = '# Report\n\n| File | Size |\n|---|---|\n| a.zip | 174M |\n';
    const result = await processAgentStream(makeStream([
      { type: 'text', text: document },
      { type: 'tool-call', toolName: 'tools__filesystem_write', toolCallId: 'call_1', toolInput: { file_path: '/tmp/r.md', content: document } },
      { type: 'tool-result', toolCallId: 'call_1', toolResult: 'ok' },
      { type: 'text', text: 'Saved the report.' },
      outcome(),
    ]));

    expect(result.reportText).toBe(`${document}Saved the report.`);
  });
});
