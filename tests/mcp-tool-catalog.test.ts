import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('generated MCP tool catalog', () => {
  it('matches the real server descriptors without contacting a daemon', () => {
    const generatedPath = resolve(import.meta.dir, '..', 'src/generated/mcp-tool-catalog.ts');
    const before = readFileSync(generatedPath, 'utf8');
    const proc = Bun.spawnSync(['bun', 'scripts/build-mcp-catalog.ts'], { cwd: resolve(import.meta.dir, '..') });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(generatedPath, 'utf8')).toBe(before);
  });
});
