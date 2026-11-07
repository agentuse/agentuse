import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GET_STARTED_HTML } from '../src/generated/mcp-get-started';

describe('generated MCP get_started card', () => {
  it('matches its sources (run `bun run mcp-card:build` after changing src/mcp-server/card)', () => {
    const generatedPath = resolve(import.meta.dir, '..', 'src/generated/mcp-get-started.ts');
    const before = readFileSync(generatedPath, 'utf8');
    const proc = Bun.spawnSync(['bun', 'scripts/build-mcp-card.ts'], { cwd: resolve(import.meta.dir, '..') });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(generatedPath, 'utf8')).toBe(before);
  });

  it('carries the setup copy and avoids em dashes and "computer" in its own words', () => {
    const sources = ['get-started.ts', 'get-started.html'].map((name) => readFileSync(resolve(import.meta.dir, '..', 'src/mcp-server/card', name), 'utf8')).join('\n');
    expect(sources).not.toContain('—');
    expect(sources.toLowerCase()).not.toContain('computer');
    for (const text of ['Set up AgentUse', 'Sign in to AgentUse Cloud', 'Download for Mac', 'Waiting for your machine', 'AgentUse is ready', 'Continue my request', 'Waiting on you']) {
      expect(GET_STARTED_HTML).toContain(text);
    }
    expect(GET_STARTED_HTML).not.toContain('Free account · 1 person · 1 machine');
  });
});
