import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('generated MCP draft card', () => {
  it('matches its sources (run `bun run mcp-card:build` after changing src/mcp-server/card)', async () => {
    const generatedPath = resolve(import.meta.dir, '..', 'src/generated/mcp-draft-card.ts');
    const before = readFileSync(generatedPath, 'utf8');
    const proc = Bun.spawnSync(['bun', 'scripts/build-mcp-card.ts'], { cwd: resolve(import.meta.dir, '..') });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(generatedPath, 'utf8')).toBe(before);
  });
});
