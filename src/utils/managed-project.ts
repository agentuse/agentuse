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
 * Create and register a managed project. This is the single write path shared
 * by terminal setup and the Web UI, so directory layout and config merging
 * cannot drift between onboarding surfaces.
 */
export async function createManagedProject(
  input: unknown,
  options: { configPath?: string } = {},
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
    persistServeProject({ id: slug, path: projectRoot }, configPath);
    return { id: slug, name, root: projectRoot };
  } catch (error) {
    // Roll back only the directory this call created. Existing user data is
    // rejected above and is never removed.
    if (projectCreated) await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ManagedProjectError) throw error;
    throw new ManagedProjectError('CREATE_FAILED', (error as Error).message);
  }
}
