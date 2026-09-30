import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter } from '../src/utils/frontmatter';
import { parseAgentContent } from '../src/parser';
import { renderMarkdownArtifact } from '../src/cli/serve/ui';

const g = globalThis as { __frontmatterEvalRan?: boolean };

function executableDoc(language: string): string {
  return `---${language}\n(function(){ globalThis.__frontmatterEvalRan = true; return { title: 'x' }; })()\n---\nbody\n`;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('front matter parsing', () => {
  it('parses YAML front matter', () => {
    const parsed = parseFrontmatter('---\ntitle: Hello\n---\nbody\n');
    expect(parsed.data).toEqual({ title: 'Hello' });
    expect(parsed.content.trim()).toBe('body');
  });

  it('refuses JavaScript front matter without running it', () => {
    for (const language of ['js', 'javascript', 'JS', 'JavaScript']) {
      g.__frontmatterEvalRan = false;
      expect(() => parseFrontmatter(executableDoc(language))).toThrow();
      expect(g.__frontmatterEvalRan).toBe(false);
    }
  });

  it('does not run JavaScript front matter in agent files or Markdown previews', () => {
    g.__frontmatterEvalRan = false;
    expect(() => parseAgentContent(executableDoc('js'), 'evil')).toThrow();
    renderMarkdownArtifact(executableDoc('js'));
    expect(g.__frontmatterEvalRan).toBe(false);
  });

  it('is the only module that imports gray-matter', () => {
    const root = join(import.meta.dir, '..');
    const offenders = sourceFiles(join(root, 'src'))
      .filter((file) => /from ['"]gray-matter['"]|require\(['"]gray-matter['"]\)/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual(['src/utils/frontmatter.ts']);
  });
});
