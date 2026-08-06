import { describe, expect, it } from 'bun:test';
import { isMarkdownPath, parseReadOutput } from '../src/cli/serve/web/lib/read-output';

describe('read output parsing', () => {
  it('strips the read tool line numbering', () => {
    const out = parseReadOutput('  1\t# Title\n  2\t\n  3\tSome prose.');

    expect(out.lineNumbered).toBe(true);
    expect(out.body).toBe('# Title\n\nSome prose.');
    expect(out.header).toBeUndefined();
  });

  it('lifts the partial-read header off the content', () => {
    const out = parseReadOutput('[Reading lines 1-40 of 4971 total]\n\n 1\t{\n 2\t  "a": 1\n');

    expect(out.header).toBe('[Reading lines 1-40 of 4971 total]');
    expect(out.body).toBe('{\n  "a": 1\n');
  });

  it('leaves un-numbered output alone', () => {
    // tools__skill_load returns the SKILL.md body as-is.
    const skill = '## Skill: fastmail\n\n**Base directory**: /repo/.agentuse/skills/fastmail\n\nUse the fm CLI.';
    const out = parseReadOutput(skill);

    expect(out.lineNumbered).toBe(false);
    expect(out.body).toBe(skill);
  });

  it('does not strip a document that merely opens with a numbered line', () => {
    // Only one of five lines looks numbered, so this is real content, not the
    // tool's line numbering - stripping it would delete characters the model saw.
    const doc = '1\tstep one\nSome prose that follows.\nMore prose here.\nAnd more.\nStill more.';
    const out = parseReadOutput(doc);

    expect(out.lineNumbered).toBe(false);
    expect(out.body).toBe(doc);
  });

  it('handles empty content without claiming it was numbered', () => {
    expect(parseReadOutput('')).toMatchObject({ lineNumbered: false, body: '' });
  });

  it('recognises markdown paths only by extension', () => {
    expect(isMarkdownPath('./docs/Reddit-Persona-Tim.md')).toBe(true);
    expect(isMarkdownPath('fastmail/SKILL.md')).toBe(true);
    expect(isMarkdownPath('/repo/notes.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('/repo/store/items.json')).toBe(false);
    expect(isMarkdownPath('/repo/md')).toBe(false);
  });
});
