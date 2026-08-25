import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import {
  getOrCreateAnonymousIdentity,
  isFirstRun,
  markFirstExecutionComplete,
  markFirstRunComplete,
  setTelemetryStaleReclaimHookForTest,
} from '../src/telemetry/id';

describe('telemetry identity lifecycle', () => {
  let root: string;
  let originalXdgDataHome: string | undefined;

  beforeEach(async () => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    root = await mkdtemp(join(tmpdir(), 'agentuse-telemetry-'));
    process.env.XDG_DATA_HOME = root;
  });

  afterEach(async () => {
    setTelemetryStaleReclaimHookForTest(undefined);
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await rm(root, { recursive: true, force: true });
  });

  it('persists one installation identity and first-execution state', async () => {
    const created = await getOrCreateAnonymousIdentity();
    expect(created.created).toBe(true);
    expect(created.persisted).toBe(true);
    expect(created.isFirstExecution).toBe(true);
    expect(created.migrated).toBe(false);

    const existing = await getOrCreateAnonymousIdentity();
    expect(existing.id).toBe(created.id);
    expect(existing.created).toBe(false);
    expect(existing.isFirstExecution).toBe(true);

    const claim = await markFirstExecutionComplete(created.id);
    expect(claim?.firstExecutionAt).toBeTruthy();
    expect(claim?.activationEventId).toBeTruthy();
    const afterExecution = await getOrCreateAnonymousIdentity();
    expect(afterExecution.id).toBe(created.id);
    expect(afterExecution.isFirstExecution).toBe(false);
  });

  it('migrates a legacy identity without relabeling it as a new installation', async () => {
    const telemetryDir = join(root, 'agentuse');
    await mkdir(telemetryDir, { recursive: true });
    await writeFile(join(telemetryDir, 'telemetry.json'), JSON.stringify({
      id: 'legacy-id',
      alertedAt: '2026-01-01T00:00:00.000Z',
    }));

    const migrated = await getOrCreateAnonymousIdentity();
    expect(migrated).toMatchObject({
      id: 'legacy-id',
      created: false,
      persisted: true,
      isFirstExecution: false,
      migrated: true,
      firstExecutionAt: 'legacy',
    });

    const stored = JSON.parse(await readFile(join(telemetryDir, 'telemetry.json'), 'utf8'));
    expect(stored.identitySchemaVersion).toBe(2);
    expect(stored.firstExecutionAt).toBe('legacy');

    const nextRun = await getOrCreateAnonymousIdentity();
    expect(nextRun.migrated).toBe(false);
    expect(nextRun.isFirstExecution).toBe(false);
  });

  it('tracks notice acknowledgement independently from identity creation', async () => {
    await getOrCreateAnonymousIdentity();
    expect(await isFirstRun()).toBe(true);
    await markFirstRunComplete();
    expect(await isFirstRun()).toBe(false);
  });

  it('labels an identity ephemeral when its data directory cannot be written', async () => {
    const blockedPath = join(root, 'not-a-directory');
    await writeFile(blockedPath, 'blocked');
    process.env.XDG_DATA_HOME = blockedPath;

    const identity = await getOrCreateAnonymousIdentity();
    expect(identity.created).toBe(true);
    expect(identity.persisted).toBe(false);
    expect(identity.isFirstExecution).toBe(true);
  });

  it('creates one durable identity under concurrent callers', async () => {
    const identities = await Promise.all(
      Array.from({ length: 40 }, () => getOrCreateAnonymousIdentity()),
    );
    expect(new Set(identities.map(identity => identity.id)).size).toBe(1);
    expect(identities.filter(identity => identity.created)).toHaveLength(1);
    expect(new Set(identities.map(identity => identity.installationEventId)).size).toBe(1);
  });

  it('creates one durable identity across concurrent processes', async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/telemetry/id.ts')).href;
    const script = `import { getOrCreateAnonymousIdentity } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await getOrCreateAnonymousIdentity()));`;
    const processes = Array.from({ length: 12 }, () => Bun.spawn(
      [process.execPath, '-e', script],
      {
        env: { ...process.env, XDG_DATA_HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ));
    const outputs = await Promise.all(processes.map(async child => {
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      return JSON.parse(stdout) as { id: string; created: boolean; installationEventId?: string };
    }));

    expect(new Set(outputs.map(identity => identity.id)).size).toBe(1);
    expect(outputs.filter(identity => identity.created)).toHaveLength(1);
    expect(new Set(outputs.map(identity => identity.installationEventId)).size).toBe(1);
  });

  it('atomically claims one activation and preserves its retry identity', async () => {
    const identity = await getOrCreateAnonymousIdentity();
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => markFirstExecutionComplete(identity.id)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    const persisted = await getOrCreateAnonymousIdentity();
    expect(persisted.firstExecutionAt).toBe(claims.find(Boolean)?.firstExecutionAt);
    expect(persisted.activationEventId).toBe(claims.find(Boolean)?.activationEventId);
    expect(persisted.isFirstExecution).toBe(false);
  });

  it('does not let an ephemeral identity claim a recovered durable installation', async () => {
    const durable = await getOrCreateAnonymousIdentity();

    expect(await markFirstExecutionComplete('ephemeral-fallback-id')).toBeNull();
    expect((await getOrCreateAnonymousIdentity()).isFirstExecution).toBe(true);

    expect(await markFirstExecutionComplete(durable.id)).not.toBeNull();
    expect((await getOrCreateAnonymousIdentity()).isFirstExecution).toBe(false);
  });

  it('reclaims one stale lock without concurrent callers deleting the new owner', async () => {
    const telemetryDir = join(root, 'agentuse');
    const lockPath = join(telemetryDir, 'telemetry.json.lock');
    await mkdir(telemetryDir, { recursive: true });
    await writeFile(lockPath, 'abandoned-owner');
    const stale = new Date(Date.now() - 20_000);
    await utimes(lockPath, stale, stale);

    let releaseReclaimer!: () => void;
    const reclaimerBlocked = new Promise<void>(resolve => { releaseReclaimer = resolve; });
    let reportReclaimerStarted!: () => void;
    const reclaimerStarted = new Promise<void>(resolve => { reportReclaimerStarted = resolve; });
    let hookCalls = 0;
    setTelemetryStaleReclaimHookForTest(async () => {
      hookCalls += 1;
      reportReclaimerStarted();
      await reclaimerBlocked;
    });

    const first = getOrCreateAnonymousIdentity();
    await reclaimerStarted;
    const second = getOrCreateAnonymousIdentity();
    await Bun.sleep(40);
    expect(hookCalls).toBe(1);
    releaseReclaimer();

    const identities = await Promise.all([first, second]);
    expect(new Set(identities.map(identity => identity.id)).size).toBe(1);
    expect(identities.filter(identity => identity.created)).toHaveLength(1);
  });
});
