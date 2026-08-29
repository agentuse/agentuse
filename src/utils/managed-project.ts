import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { managedProjectAbout, validateManagedProjectName } from '../onboarding';
import { getGlobalConfigPath, getManagedProjectsRoot, persistServeProject } from './global-config';

export class ManagedProjectError extends Error {
  constructor(public code: 'PROJECT_EXISTS' | 'PROJECT_CONFIGURED' | 'CREATE_FAILED', message: string) {
    super(message);
  }
}

export interface ManagedProjectResult {
  id: string;
  name: string;
  root: string;
}

/**
 * Create a managed project and, by default, register it. The live server can
 * stage it with register:false so runtime attachment completes first. This is
 * the single filesystem write path shared by terminal setup and the Web UI.
 */
export async function createManagedProject(
  input: unknown,
  options: { configPath?: string; register?: boolean } = {},
): Promise<ManagedProjectResult> {
  const { name, slug } = validateManagedProjectName(input);
  const configPath = options.configPath ?? getGlobalConfigPath();
  const managedRoot = getManagedProjectsRoot(configPath);
  const projectRoot = resolve(managedRoot, slug);

  if (existsSync(projectRoot)) {
    throw new ManagedProjectError(
      'PROJECT_EXISTS',
      `A managed project named "${name}" already exists at ${projectRoot}`,
    );
  }

  let projectCreated = false;
  try {
    await mkdir(managedRoot, { recursive: true });
    await mkdir(projectRoot);
    projectCreated = true;
    await Promise.all([
      mkdir(resolve(projectRoot, 'agents')),
      mkdir(resolve(projectRoot, '.agentuse')),
      writeFile(resolve(projectRoot, 'ABOUT.md'), managedProjectAbout(name), { mode: 0o600 }),
    ]);
    if (options.register !== false) {
      persistServeProject({ id: slug, path: projectRoot }, configPath);
    }
    return { id: slug, name, root: projectRoot };
  } catch (error) {
    // Roll back only the directory this call created. Existing user data is
    // rejected above and is never removed.
    if (projectCreated) await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ManagedProjectError) throw error;
    throw new ManagedProjectError('CREATE_FAILED', (error as Error).message);
  }
}

/** Remove only a directory created by createManagedProject after a later
 * startup phase fails. Existing directories are never accepted by creation,
 * so this rollback cannot target pre-existing user data. */
export async function rollbackManagedProject(project: ManagedProjectResult): Promise<void> {
  await rm(project.root, { recursive: true, force: true });
}

/** Two-phase creation used by the live server: stage files, attach runtime
 * resources, then publish the config entry. Any failure before registration
 * unwinds both runtime state and the newly-created directory. */
export async function createManagedProjectTransaction<T>(
  input: unknown,
  attach: (project: ManagedProjectResult) => Promise<{ value: T; rollback: () => Promise<void> }>,
  options: { configPath?: string } = {},
): Promise<{ managed: ManagedProjectResult; value: T }> {
  const configPath = options.configPath ?? getGlobalConfigPath();
  const managed = await createManagedProject(input, { configPath, register: false });
  let attached: { value: T; rollback: () => Promise<void> } | undefined;
  try {
    attached = await attach(managed);
    persistServeProject({ id: managed.id, path: managed.root }, configPath);
    return { managed, value: attached.value };
  } catch (error) {
    if (attached) await attached.rollback().catch(() => {});
    await rollbackManagedProject(managed).catch(() => {});
    throw error;
  }
}
