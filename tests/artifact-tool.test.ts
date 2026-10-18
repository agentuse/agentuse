import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises';
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

describe('artifact directory containment', () => {
  it.each(['../outside', '/absolute', 'C:\\outside', 'C:outside', '${root}/outside', '.', ''])('rejects invalid configured directory %s before writing or listing', async (dir) => {
    const projectRoot = await makeProject();
    try {
      const context = { projectRoot, dir };
      const saved = await run(createArtifactTool(context), { name: 'report.md', content: 'body', group: 'g' });
      expect(saved.success).toBe(false);
      expect(saved.error).toContain('project-relative');
      expect((await run(createListArtifactsTool(context), {})).success).toBe(false);
      expect(await readdir(projectRoot)).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps safe custom directories and project-root aliases working', async () => {
    const projectRoot = await makeProject();
    const aliasRoot = `${projectRoot}-alias`;
    try {
      await symlink(projectRoot, aliasRoot);
      await mkdir(join(projectRoot, 'reports'));
      const context = { projectRoot: aliasRoot, dir: 'reports' };
      const saved = await run(createArtifactTool(context), { name: 'report.md', content: 'body', group: 'g' });
      expect(saved.success).toBe(true);
      expect(await readFile(join(projectRoot, 'reports/g/report.md'), 'utf8')).toBe('body');
      expect((await run(createListArtifactsTool(context), {})).count).toBe(1);
    } finally {
      await rm(aliasRoot, { force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each(['root', 'group', 'manifest', 'lock', 'dangling-root'])('rejects a symlink escape through %s without touching outside files', async (location) => {
    const projectRoot = await makeProject();
    const outside = await makeProject();
    const dir = 'reports';
    try {
      const outsideManifest = join(outside, 'manifest.json');
      const manifestContent = JSON.stringify({ version: 1, artifacts: [{ name: 'private.md' }] });
      await writeFile(outsideManifest, manifestContent);
      if (location === 'root' || location === 'dangling-root') {
        await symlink(location === 'root' ? outside : join(outside, 'missing'), join(projectRoot, dir));
      } else {
        await mkdir(join(projectRoot, dir));
        const linkName = location === 'group' ? 'g' : location === 'lock' ? 'manifest.json.lock' : 'manifest.json';
        await symlink(location === 'manifest' ? outsideManifest : outside, join(projectRoot, dir, linkName));
      }
      const context = { projectRoot, dir };
      const saved = await run(createArtifactTool(context), { name: 'report.md', content: 'body', group: 'g' });
      expect(saved.success).toBe(false);
      // Listing only resolves the manifest, so a group-only alias is irrelevant.
      if (location !== 'group') expect((await run(createListArtifactsTool(context), {})).success).toBe(false);
      expect(await readdir(outside)).toEqual(['manifest.json']);
      expect(await readFile(outsideManifest, 'utf8')).toBe(manifestContent);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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

describe('late session binding (delegated sub-agents)', () => {
  // Regression: a delegated sub-agent loads its tools before its child session
  // exists, so the tool context carries sessionId=undefined at construction and
  // the id is bound afterwards (LoadedAgentTools.bindSessionId, called from
  // subagent.ts). Snapshotting sessionId at construction orphaned every
  // sub-agent artifact: no manifest sessionId, so the session artifacts list
  // filtered it out and the model got no viewable URL back.
  it('picks up a sessionId bound after the tool was constructed', async () => {
    const projectRoot = await makeProject();
    try {
      // Mirrors the shape getTools() builds: a live view over a mutable context.
      const shared: { sessionId?: string | undefined } = {};
      const ctx = {
        projectRoot,
        get sessionId() { return shared.sessionId; },
        agentId: 'agents/blog/blog-write',
      };
      const save = createArtifactTool(ctx);

      // Session bound only after construction, as subagent.ts does.
      shared.sessionId = 'sess-late';

      const out = await run(save, { name: 'draft.md', content: 'body', group: 'post' });
      expect(out.success).toBe(true);

      const entries = await readManifest(projectRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sessionId).toBe('sess-late');

      // The same live context makes session-scoped listing work too.
      const listed = await run(createListArtifactsTool(ctx), { session: 'current' });
      expect(listed.count).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('still records no sessionId when none is ever bound', async () => {
    const projectRoot = await makeProject();
    try {
      const shared: { sessionId?: string | undefined } = {};
      const save = createArtifactTool({
        projectRoot,
        get sessionId() { return shared.sessionId; },
      });
      const out = await run(save, { name: 'draft.md', content: 'body', group: 'post' });

      expect(out.success).toBe(true);
      expect(out.url).toBeUndefined();
      const entries = await readManifest(projectRoot);
      expect(entries[0]?.sessionId).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
