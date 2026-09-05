import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as models from '../src/models';
import { loadAgentTools } from '../src/runner/tools-loader';
import type { ParsedAgent } from '../src/parser';

let root: string;
let media: ReturnType<typeof spyOn>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentuse-tool-loading-')));
  media = spyOn(models, 'resolveMediaToolResultSupport').mockImplementation(async (model: string) => {
    if (model.startsWith('anthropic:')) throw new Error('Claude Code OAuth refresh failed (HTTP 400)');
    return { image: true, pdf: true };
  });
});

afterEach(() => {
  media.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function load() {
  return loadAgentTools({
    agent: {
      name: 'email-alerts',
      instructions: 'Read email.',
      config: {
        model: 'openai:gpt-5.6-terra',
        modelCandidates: ['openai:gpt-5.6-terra', 'anthropic:claude-sonnet-5'],
        intent: false,
        skills: { auto: false, trusted: false, explicit: {} },
        tools: {
          bash: { commands: ['date *'] },
          filesystem: [{ path: root, permissions: ['read'] }],
        },
      },
    } as ParsedAgent,
    projectContext: { projectRoot: root, stateRoot: root, cwd: root },
    mcpConnections: [],
  });
}

describe('tool loading with unavailable fallback media support', () => {
  it('keeps Bash and text reads when fallback authentication fails', async () => {
    const loaded = await load();
    expect(loaded.all.tools__bash).toBeDefined();
    const file = join(root, 'message.txt');
    writeFileSync(file, 'Email preview');
    const result = await (loaded.all.tools__filesystem_read as any).execute({ file_path: file });
    expect(JSON.stringify(result)).toContain('Email preview');
    expect(media).toHaveBeenCalledTimes(2);
  });

  it('does not advertise binary media when fallback support is unknown', async () => {
    const loaded = await load();
    const file = join(root, 'image.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = await (loaded.all.tools__filesystem_read as any).execute({ file_path: file });
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('transport');
  });
});
