import { describe, it, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseAbout, readAbout } from '../src/cli/serve/about';

describe('parseAbout', () => {
  it('parses frontmatter fields and body', () => {
    const about = parseAbout([
      '---',
      'name: Customer Success',
      "description: Priya's team. Triage, refunds, churn watch.",
      'owner: Priya Sharma',
      '---',
      '',
      'Charter and links go here.',
    ].join('\n'));
    expect(about.name).toBe('Customer Success');
    expect(about.description).toBe("Priya's team. Triage, refunds, churn watch.");
    expect(about.owner).toBe('Priya Sharma');
    expect(about.body).toBe('Charter and links go here.');
  });

  it('treats a plain markdown file as body only', () => {
    const about = parseAbout('# About this team\n\nJust prose.');
    expect(about.name).toBeUndefined();
    expect(about.body).toBe('# About this team\n\nJust prose.');
  });

  it('lets a leading horizontal rule fall through to the body', () => {
    // A `---` line followed by non-mapping content must not become config.
    const raw = '---\nJust a divider-opening doc\n---\nrest of page';
    const about = parseAbout(raw);
    expect(about.name).toBeUndefined();
    expect(about.body).toBe(raw);
  });

  it('treats an unclosed frontmatter fence as body', () => {
    const raw = '---\nname: Never closed';
    expect(parseAbout(raw)).toEqual({ body: raw });
  });

  it('treats malformed YAML between fences as body', () => {
    const raw = '---\nname: [unclosed\n---\nbody';
    expect(parseAbout(raw).name).toBeUndefined();
    expect(parseAbout(raw).body).toBe(raw);
  });

  it('ignores unknown frontmatter keys and non-string values', () => {
    const about = parseAbout('---\nname: Ops\nschedule: "0 9 * * 1"\nowner: [a, b]\n---\n');
    expect(about).toEqual({ name: 'Ops' });
  });

  it('collapses whitespace and truncates overlong fields', () => {
    const about = parseAbout(`---\nname: "${'x'.repeat(300)}"\ndescription: "a\\n  b"\n---\n`);
    expect(about.name!.length).toBe(120);
    expect(about.name!.endsWith('…')).toBe(true);
    expect(about.description).toBe('a b');
  });

  it('returns an empty object for an empty file', () => {
    expect(parseAbout('')).toEqual({});
    expect(parseAbout('   \n  ')).toEqual({});
  });
});

describe('readAbout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-about-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns null when the file is absent', async () => {
    expect(await readAbout(dir)).toBeNull();
  });

  it('reads and caches by mtime, picking up edits', async () => {
    const file = path.join(dir, 'ABOUT.md');
    fs.writeFileSync(file, '---\nname: First\n---\n');
    expect((await readAbout(dir))?.name).toBe('First');

    fs.writeFileSync(file, '---\nname: Second\n---\n');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    expect((await readAbout(dir))?.name).toBe('Second');
  });

  it('returns null once the file is deleted again', async () => {
    fs.rmSync(path.join(dir, 'ABOUT.md'));
    expect(await readAbout(dir)).toBeNull();
  });
});
