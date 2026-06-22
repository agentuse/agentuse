import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createArtifactTool, createListArtifactsTool } from '../src/tools/artifacts.js';
import {
  getManifestPath,
  readArtifactManifest,
  type ArtifactManifestEntry,
} from '../src/tools/artifact-manifest.js';

async function run(tool: { execute?: unknown }, input: unknown): Promise<any> {
  const execute = tool.execute as (i: unknown, o: unknown) => Promise<{ output: string }>;
  const res = await execute(input, {});
  return JSON.parse(res.output);
}

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentuse-artifact-tool-'));
}

async function readManifest(projectRoot: string): Promise<ArtifactManifestEntry[]> {
  const manifest = await readArtifactManifest(getManifestPath(projectRoot));
  return manifest.artifacts;
}

describe('tools__artifact_save', () => {
  it('writes the file under .agentuse/artifacts/<group>/ and records a session-linked manifest entry', async () => {
    const projectRoot = await makeProject();
    try {
      const tool = createArtifactTool({ projectRoot, sessionId: 'sess-1', agentId: 'agents/report' });
      const out = await run(tool, {
        name: 'index.md',
        content: '# Hello\n\nbody',
        group: 'Client Report',
        title: 'Client Report',
        tags: ['ops', 'finance'],
      });

      expect(out.success).toBe(true);
      expect(out.path).toBe('.agentuse/artifacts/client-report/index.md');
      expect(out.group).toBe('client-report');

      // File exists on disk with merged frontmatter.
      const fileContent = await readFile(join(projectRoot, out.path), 'utf8');
      expect(fileContent).toContain('title: Client Report');
      expect(fileContent).toContain('ops');
      expect(fileContent).toContain('# Hello');

      // Manifest entry links the artifact to the run.
      const entries = await readManifest(projectRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        name: '.agentuse/artifacts/client-report/index.md',
        group: 'client-report',
        title: 'Client Report',
        type: 'md',
        sessionId: 'sess-1',
        agentId: 'agents/report',
      });
      expect(entries[0].bytes).toBeGreaterThan(0);
      expect(typeof entries[0].createdAt).toBe('string');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not add frontmatter to non-markdown content', async () => {
    const projectRoot = await makeProject();
    try {
      const tool = createArtifactTool({ projectRoot, sessionId: 'sess-1' });
      const html = '<!doctype html><h1>Dashboard</h1>';
      const out = await run(tool, { name: 'dashboard.html', content: html, group: 'dash', title: 'Dash' });
      expect(out.path).toBe('.agentuse/artifacts/dash/dashboard.html');
      const fileContent = await readFile(join(projectRoot, out.path), 'utf8');
      expect(fileContent).toBe(html);
      const entries = await readManifest(projectRoot);
      expect(entries[0].type).toBe('html');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('updates in place on a repeat write instead of duplicating, preserving createdAt', async () => {
    const projectRoot = await makeProject();
    try {
      const tool = createArtifactTool({ projectRoot, sessionId: 'sess-1' });
      const first = await run(tool, { name: 'index.md', content: 'v1', group: 'g' });
      const created = (await readManifest(projectRoot))[0].createdAt;

      const second = await run(tool, { name: 'index.md', content: 'v2 longer content', group: 'g' });
      expect(second.path).toBe(first.path);

      const entries = await readManifest(projectRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0].createdAt).toBe(created);
      const fileContent = await readFile(join(projectRoot, second.path), 'utf8');
      expect(fileContent).toBe('v2 longer content');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps traversal-laden names and groups contained inside the artifacts dir', async () => {
    const projectRoot = await makeProject();
    try {
      const tool = createArtifactTool({ projectRoot, sessionId: 'sess-1' });
      const out = await run(tool, {
        name: '../../evil.md',
        content: 'nope',
        group: '../../../etc',
      });
      expect(out.success).toBe(true);
      // Path is normalized to a safe location strictly inside .agentuse/artifacts/.
      expect(out.path.startsWith('.agentuse/artifacts/')).toBe(true);
      expect(out.path).not.toContain('..');
      // The escape target must not exist.
      let escaped = true;
      try { await stat(join(projectRoot, '..', '..', 'evil.md')); } catch { escaped = false; }
      expect(escaped).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes without losing manifest entries', async () => {
    const projectRoot = await makeProject();
    try {
      const tool = createArtifactTool({ projectRoot, sessionId: 'sess-1' });
      const writes = Array.from({ length: 12 }, (_, i) =>
        run(tool, { name: `report-${i}.md`, content: `body ${i}`, group: 'batch' })
      );
      const results = await Promise.all(writes);
      expect(results.every((r) => r.success)).toBe(true);

      const entries = await readManifest(projectRoot);
      expect(entries).toHaveLength(12);
      const names = new Set(entries.map((e) => e.name));
      expect(names.size).toBe(12);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('tools__artifact_list', () => {
  it('lists all artifacts and filters by session and group', async () => {
    const projectRoot = await makeProject();
    try {
      const toolA = createArtifactTool({ projectRoot, sessionId: 'sess-A' });
      const toolB = createArtifactTool({ projectRoot, sessionId: 'sess-B' });
      await run(toolA, { name: 'a1.md', content: 'a1', group: 'alpha' });
      await run(toolA, { name: 'a2.md', content: 'a2', group: 'beta' });
      await run(toolB, { name: 'b1.md', content: 'b1', group: 'alpha' });

      // Default: all artifacts incl. prior runs.
      const listAll = await run(createListArtifactsTool({ projectRoot, sessionId: 'sess-B' }), {});
      expect(listAll.success).toBe(true);
      expect(listAll.count).toBe(3);

      // session: 'current' scopes to the calling run.
      const listCurrent = await run(createListArtifactsTool({ projectRoot, sessionId: 'sess-A' }), { session: 'current' });
      expect(listCurrent.count).toBe(2);
      expect(listCurrent.artifacts.every((a: any) => a.sessionId === 'sess-A')).toBe(true);

      // group filter.
      const listGroup = await run(createListArtifactsTool({ projectRoot, sessionId: 'sess-A' }), { group: 'alpha' });
      expect(listGroup.count).toBe(2);
      expect(listGroup.artifacts.every((a: any) => a.group === 'alpha')).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty list when there is no manifest', async () => {
    const projectRoot = await makeProject();
    try {
      const out = await run(createListArtifactsTool({ projectRoot, sessionId: 'sess-1' }), {});
      expect(out.success).toBe(true);
      expect(out.count).toBe(0);
      expect(out.artifacts).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
