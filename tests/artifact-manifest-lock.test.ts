import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getManifestPath, readArtifactManifest } from '../src/tools/artifact-manifest';

const MODULE = path.resolve(import.meta.dir, '../src/tools/artifact-manifest.ts');
const PER_PROCESS = 60;

describe('artifact manifest across processes', () => {
  let projectRoot = '';

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-manifest-lock-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('keeps every entry when two processes upsert at the same time', async () => {
    const script = path.join(projectRoot, 'upsert.mts');
    await fs.writeFile(script, `
      import { upsertArtifactEntry, getManifestPath } from ${JSON.stringify(MODULE)};
      const [tag, root, count] = process.argv.slice(2);
      const manifestPath = getManifestPath(root);
      const now = new Date().toISOString();
      for (let i = 0; i < Number(count); i++) {
        await upsertArtifactEntry(manifestPath, {
          name: \`.agentuse/artifacts/g/\${tag}-\${i}.md\`, group: 'g', type: 'md', bytes: 1, createdAt: now, updatedAt: now,
        });
      }
    `);

    const run = (tag: string) => Bun.spawn([process.execPath, script, tag, projectRoot, String(PER_PROCESS)], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const children = [run('a'), run('b')];
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0]);

    const manifest = await readArtifactManifest(getManifestPath(projectRoot));
    expect(manifest.artifacts).toHaveLength(PER_PROCESS * 2);
  }, 60_000);
});
