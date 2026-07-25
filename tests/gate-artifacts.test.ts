import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findGateSnapshotFile,
  snapshotGateArtifacts,
} from '../src/session/gate-artifacts';
import { getSessionStorageDir } from '../src/storage/paths';

describe('immutable gate artifacts', () => {
  let dataHome: string;
  let projectRoot: string;
  let originalDataHome: string | undefined;
  const sessionId = '01KIMMUTABLEARTIFACT00000000';

  beforeEach(async () => {
    originalDataHome = process.env.XDG_DATA_HOME;
    dataHome = await mkdtemp(join(tmpdir(), 'agentuse-gate-data-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-gate-project-'));
    process.env.XDG_DATA_HOME = dataHome;
    const storage = await getSessionStorageDir(projectRoot);
    await mkdir(join(storage, `${sessionId}-agents-review`), { recursive: true });
  });

  afterEach(async () => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    await rm(dataHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('snapshots explicitly declared text files and keeps the reviewed bytes', async () => {
    await mkdir(join(projectRoot, 'review'), { recursive: true });
    const livePath = join(projectRoot, 'review', 'plan.md');
    await writeFile(livePath, 'version presented for approval');

    const [snapshot] = await snapshotGateArtifacts(projectRoot, sessionId, {
      artifact_path: 'review/plan.md',
    });
    await writeFile(livePath, 'later mutable workspace version');

    const snapshotPath = await findGateSnapshotFile(projectRoot, sessionId, snapshot!.hash);
    expect(snapshotPath).not.toBeNull();
    expect(await readFile(snapshotPath!, 'utf8')).toBe('version presented for approval');
  });

  test('fails closed when any declared artifact cannot be snapshotted', async () => {
    await expect(snapshotGateArtifacts(projectRoot, sessionId, {
      artifact_paths: ['review/missing.png'],
    })).rejects.toThrow('gate was not opened because review bytes must be immutable');
  });

  test('fails the entire set instead of returning a partial snapshot manifest', async () => {
    await mkdir(join(projectRoot, 'review'), { recursive: true });
    await writeFile(join(projectRoot, 'review', 'present.txt'), 'present');

    await expect(snapshotGateArtifacts(projectRoot, sessionId, {
      artifact_paths: ['review/present.txt', 'review/missing.txt'],
    })).rejects.toThrow('review/missing.txt');
  });

  // Regression: a delegated sub-agent's gate is surfaced and decided on its
  // PARENT's approval page, so the artifact link carries the parent's session
  // id while the snapshot sits in the child's storage. Searching only the
  // session's own gate dir 410'd those ("The immutable approval snapshot is
  // unavailable") even though the bytes were on disk one level down.
  test('finds a delegated sub-agent gate snapshot from the parent session id', async () => {
    const parentId = '01KPARENTGATESESSION00000000';
    const childId = '01KCHILDGATESESSION000000000';
    const storage = await getSessionStorageDir(projectRoot);
    await mkdir(
      join(storage, `${parentId}-agents-manager`, 'subagent', `${childId}-agents-writer`),
      { recursive: true }
    );

    await mkdir(join(projectRoot, 'review'), { recursive: true });
    await writeFile(join(projectRoot, 'review', 'draft.md'), 'child draft bytes');

    // Snapshot is taken by the CHILD, into the child's own storage.
    const [snapshot] = await snapshotGateArtifacts(projectRoot, childId, {
      artifact_paths: ['review/draft.md'],
    });

    // Reviewer opens the PARENT page, so the link carries the parent's id.
    const viaParent = await findGateSnapshotFile(projectRoot, parentId, snapshot!.hash);
    expect(viaParent).not.toBeNull();
    expect(await readFile(viaParent!, 'utf8')).toBe('child draft bytes');

    // The child's own page keeps working.
    expect(await findGateSnapshotFile(projectRoot, childId, snapshot!.hash)).not.toBeNull();
  });

  test('does not resolve a hash that belongs to an unrelated session tree', async () => {
    const otherId = '01KUNRELATEDSESSION000000000';
    const storage = await getSessionStorageDir(projectRoot);
    await mkdir(join(storage, `${otherId}-agents-other`), { recursive: true });

    await mkdir(join(projectRoot, 'review'), { recursive: true });
    await writeFile(join(projectRoot, 'review', 'plan.md'), 'only in the first session');
    const [snapshot] = await snapshotGateArtifacts(projectRoot, sessionId, {
      artifact_paths: ['review/plan.md'],
    });

    expect(await findGateSnapshotFile(projectRoot, otherId, snapshot!.hash)).toBeNull();
  });
});
