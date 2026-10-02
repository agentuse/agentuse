import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getManifestPath,
  readArtifactManifest,
  upsertArtifactEntry,
  type ArtifactManifestEntry,
} from '../src/tools/artifact-manifest';

function entry(name: string): ArtifactManifestEntry {
  const now = new Date().toISOString();
  return { name, group: 'g', type: 'md', bytes: 1, createdAt: now, updatedAt: now };
}

describe('artifact manifest upsert on an unusable manifest', () => {
  let projectRoot = '';
  let manifestPath = '';

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-manifest-strict-'));
    manifestPath = getManifestPath(projectRoot);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  });

  afterEach(async () => {
    await fs.chmod(manifestPath, 0o600).catch(() => {});
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('rejects malformed JSON and leaves the file untouched', async () => {
    const original = '{"version":1,"artifacts":[{"name":"a.md"}';
    await fs.writeFile(manifestPath, original);

    await expect(upsertArtifactEntry(manifestPath, entry('b.md'))).rejects.toThrow(
      `Artifact manifest ${manifestPath} is not valid JSON`
    );
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(original);
  });

  it('rejects a root without an artifacts array and leaves the file untouched', async () => {
    const original = JSON.stringify({ version: 1, entries: [{ name: 'a.md' }] });
    await fs.writeFile(manifestPath, original);

    await expect(upsertArtifactEntry(manifestPath, entry('b.md'))).rejects.toThrow(manifestPath);
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(original);
  });

  it.skipIf(process.getuid?.() === 0)('rejects an unreadable file and leaves it untouched', async () => {
    const original = JSON.stringify({ version: 1, artifacts: [entry('a.md')] });
    await fs.writeFile(manifestPath, original);
    await fs.chmod(manifestPath, 0o000);

    await expect(upsertArtifactEntry(manifestPath, entry('b.md'))).rejects.toThrow(
      `Artifact manifest ${manifestPath} could not be read`
    );
    await fs.chmod(manifestPath, 0o600);
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(original);
  });

  it('still lists a corrupt manifest as empty', async () => {
    await fs.writeFile(manifestPath, 'not json');
    expect((await readArtifactManifest(manifestPath)).artifacts).toEqual([]);
  });

  it('creates the manifest when it is missing', async () => {
    await fs.rm(manifestPath, { force: true });
    await upsertArtifactEntry(manifestPath, entry('a.md'));
    expect((await readArtifactManifest(manifestPath)).artifacts.map((a) => a.name)).toEqual(['a.md']);
  });
});
