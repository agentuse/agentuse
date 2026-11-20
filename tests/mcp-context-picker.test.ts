import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('generated MCP destination picker', () => {
  it('matches its sources (run `bun run mcp-card:build` after changing src/mcp-server/card)', () => {
    const generatedPath = resolve(import.meta.dir, '..', 'src/generated/mcp-context-picker.ts');
    const before = readFileSync(generatedPath, 'utf8');
    const proc = Bun.spawnSync(['bun', 'scripts/build-mcp-card.ts'], { cwd: resolve(import.meta.dir, '..') });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(generatedPath, 'utf8')).toBe(before);
  });

  it('says machine, as the get started card does, and never "computer" in its own words', () => {
    const sources = ['context-picker.ts', 'context-picker.html'].map((name) => readFileSync(resolve(import.meta.dir, '..', 'src/mcp-server/card', name), 'utf8')).join('\n');
    expect(sources.toLowerCase()).not.toContain('computer');
  });
});
