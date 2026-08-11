import { describe, expect, it } from 'bun:test';
import { InvalidToolInputError, NoSuchToolError } from 'ai';
import {
  findXmlToolMarkup,
  repairSmuggledXmlToolCall,
  unsmuggleXmlParams,
  unsmuggleXmlStructure
} from '../src/runner/tool-call-repair';

// The verbatim raw input from session 01KZPV8JYM3B (substack-engage-reply,
// 2026-08-10): the `reference` object's opening `{"label": "` was emitted as
// `<parameter name="label">`, so the payload is not JSON at all and the outer
// brace is never closed. Trimmed in the excerpt only, structure untouched.
const STRUCTURAL_DRIFT =
  '{"prompt": "Approve this reply to Ilya\'s automation note? It posts and likes directly.", ' +
  '"summary": "Ilya (@ilyanobsai), 10h old, 7 likes / 4 replies. formula: operator-receipt - his claim is abstract ' +
  '(\\"a machine can only copy a job you can describe the same way twice\\") and Leon has hit it in production.", ' +
  '"reference": \n<parameter name="label">Replying to, ' +
  '"author": "Ilya (No BS AI, @ilyanobsai)", ' +
  '"url": "https://substack.com/@ilyanobsai/note/c-311102730", ' +
  '"excerpt": "Most people think automation fails because the tools are too hard.\\n\\nWhile in reality the tool is the easy part."}';

// The verbatim drift shape from session 01KXXQZC34J7 (substack-connect):
// `changes` smuggled into `summary`, `risk` smuggled into `context`, closed
// with a stray </invoke>.
const DRIFTED_INPUT = {
  prompt: 'Approve this batch of 7 replies?',
  summary:
    'Batch of 7 visibility-thread replies. Batch size was 10; top-ups were tiny, ' +
    'so I ran the 7 strong threads instead of padding with junk.</parameter>\n' +
    '<parameter name="changes">[\n' +
    '{"label": "1. Reply on Wes Pearce", "content": "Mine is about AI agents. https://example.com/"},\n' +
    '{"label": "Then: like each thread", "content": "Like the main note on all 7 threads."}\n' +
    ']',
  context:
    'Threads and canonical URLs:\n1. https://example.com/note/1\n\n' +
    'Browser identity verified before drafting.</parameter>\n' +
    '<parameter name="risk">Posting is irreversible-ish. You can approve all or drop by number.</parameter>\n</invoke>\n'
};

describe('findXmlToolMarkup', () => {
  it('detects leaked tool-call markup anywhere in the input', () => {
    expect(findXmlToolMarkup(DRIFTED_INPUT)).toBe(true);
    expect(findXmlToolMarkup({ a: [{ b: 'x</parameter>' }] })).toBe(true);
    expect(findXmlToolMarkup('plain <invoke name="x">')).toBe(true);
  });

  it('ignores ordinary angle-bracket content', () => {
    expect(findXmlToolMarkup({
      summary: 'Generics like Array<string>, <div> tags, a <placeholder>, and a < b comparisons.',
      changes: [{ content: 'if (a < b && b > c) { ... }' }]
    })).toBe(false);
  });
});

describe('unsmuggleXmlParams', () => {
  it('re-splits smuggled fields back into JSON properties (real-world shape)', () => {
    const repaired = unsmuggleXmlParams(DRIFTED_INPUT);

    expect(repaired).not.toBeNull();
    expect(repaired!.prompt).toBe('Approve this batch of 7 replies?');
    expect(repaired!.summary).toBe(
      'Batch of 7 visibility-thread replies. Batch size was 10; top-ups were tiny, ' +
      'so I ran the 7 strong threads instead of padding with junk.'
    );
    expect(repaired!.changes).toEqual([
      { label: '1. Reply on Wes Pearce', content: 'Mine is about AI agents. https://example.com/' },
      { label: 'Then: like each thread', content: 'Like the main note on all 7 threads.' }
    ]);
    expect(repaired!.context).toBe(
      'Threads and canonical URLs:\n1. https://example.com/note/1\n\n' +
      'Browser identity verified before drafting.'
    );
    expect(repaired!.risk).toBe('Posting is irreversible-ish. You can approve all or drop by number.');
    expect(findXmlToolMarkup(repaired)).toBe(false);
  });

  it('never clobbers a field the model sent properly', () => {
    const repaired = unsmuggleXmlParams({
      summary: 'Real summary.</parameter>\n<parameter name="context">smuggled context',
      context: 'the real context'
    });

    expect(repaired!.summary).toBe('Real summary.');
    expect(repaired!.context).toBe('the real context');
  });

  it('returns null when there is no markup to repair', () => {
    expect(unsmuggleXmlParams({ prompt: 'Approve?', summary: 'All clean.' })).toBeNull();
  });

  it('bails on markup buried below the top level (unknown drift shape)', () => {
    expect(unsmuggleXmlParams({
      prompt: 'Approve?',
      changes: [{ content: 'x</parameter><parameter name="risk">y' }]
    })).toBeNull();
  });
});

describe('repairSmuggledXmlToolCall', () => {
  const toolCall = (input: unknown) => ({
    type: 'tool-call' as const,
    toolCallId: 'call-1',
    toolName: 'await_human',
    input: typeof input === 'string' ? input : JSON.stringify(input)
  });
  const invalidInput = (input: string) =>
    new InvalidToolInputError({ toolName: 'await_human', toolInput: input, cause: new Error('validation failed') });

  it('repairs an InvalidToolInputError call carrying smuggled markup', async () => {
    const call = toolCall(DRIFTED_INPUT);
    const repaired = await repairSmuggledXmlToolCall({ toolCall: call, error: invalidInput(call.input) });

    expect(repaired).not.toBeNull();
    expect(repaired!.toolCallId).toBe('call-1');
    const input = JSON.parse(repaired!.input);
    expect(Array.isArray(input.changes)).toBe(true);
    expect(input.risk).toContain('irreversible');
    expect(findXmlToolMarkup(input)).toBe(false);
  });

  it('does not touch unknown-tool errors', async () => {
    const call = toolCall(DRIFTED_INPUT);
    const error = new NoSuchToolError({ toolName: 'nope', availableTools: ['await_human'] });
    expect(await repairSmuggledXmlToolCall({ toolCall: call, error })).toBeNull();
  });

  it('returns null for invalid input without markup (normal retry path)', async () => {
    const call = toolCall({ summary: 'missing required prompt' });
    expect(await repairSmuggledXmlToolCall({ toolCall: call, error: invalidInput(call.input) })).toBeNull();
  });

  it('returns null for unparseable input carrying no markup', async () => {
    const call = toolCall('{"prompt": "truncated');
    expect(await repairSmuggledXmlToolCall({ toolCall: call, error: invalidInput(call.input) })).toBeNull();
  });

  it('repairs the structural drift that breaks JSON outright (real payload)', async () => {
    const call = toolCall(STRUCTURAL_DRIFT);
    const repaired = await repairSmuggledXmlToolCall({ toolCall: call, error: invalidInput(call.input) });

    expect(repaired).not.toBeNull();
    const input = JSON.parse(repaired!.input);
    expect(input.prompt).toBe("Approve this reply to Ilya's automation note? It posts and likes directly.");
    expect(input.reference).toEqual({
      label: 'Replying to',
      author: 'Ilya (No BS AI, @ilyanobsai)',
      url: 'https://substack.com/@ilyanobsai/note/c-311102730',
      excerpt: 'Most people think automation fails because the tools are too hard.\n\nWhile in reality the tool is the easy part.'
    });
    expect(findXmlToolMarkup(input)).toBe(false);
  });
});

describe('unsmuggleXmlStructure', () => {
  it('rebuilds the nested object and closes the outer brace', () => {
    const rebuilt = unsmuggleXmlStructure(STRUCTURAL_DRIFT);
    expect(rebuilt).not.toBeNull();
    expect(JSON.parse(rebuilt!).reference.label).toBe('Replying to');
  });

  it('preserves the excerpt verbatim - an approval card must not be paraphrased', () => {
    const rebuilt = unsmuggleXmlStructure(STRUCTURAL_DRIFT);
    const excerpt = JSON.parse(rebuilt!).reference.excerpt;
    expect(excerpt).toContain('Most people think automation fails because the tools are too hard.');
    expect(excerpt).toContain('While in reality the tool is the easy part.');
  });

  it('leaves clean JSON alone', () => {
    expect(unsmuggleXmlStructure('{"prompt": "fine", "summary": "also fine"}')).toBeNull();
  });

  it('does not fire when the markup is inside a string (the other shape owns it)', () => {
    expect(unsmuggleXmlStructure(JSON.stringify(DRIFTED_INPUT))).toBeNull();
  });

  it('refuses a smuggled scalar whose value carries a quote or newline', () => {
    expect(unsmuggleXmlStructure(
      '{"reference": <parameter name="label">say "hi", "author": "x"}'
    )).toBeNull();
  });

  it('will not silently drop content it cannot rebuild', () => {
    // No `, "key":` boundary after the smuggled scalar: nothing to anchor on.
    expect(unsmuggleXmlStructure('{"reference": <parameter name="label">dangling tail')).toBeNull();
  });
});
