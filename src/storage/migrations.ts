import { getStorageState } from './storage';
import path from 'path';
import fs from 'fs/promises';

export interface Migration {
  version: number;
  up: (storageDir: string) => Promise<void>;
}

const CURRENT_VERSION = 1;

const migrations: Migration[] = [
  // Future migrations will be added here
];

/**
 * Run any pending migrations
 */
export async function runMigrations(): Promise<void> {
  const state = await getStorageState();

  for (const migration of migrations) {
    if (migration.version > state.version) {
      await migration.up(state.dir);
    }
  }

  if (state.version < CURRENT_VERSION) {
    const versionFile = path.join(state.dir, '../version.json');
    await fs.mkdir(path.dirname(versionFile), { recursive: true });
    await fs.writeFile(
      versionFile,
      JSON.stringify({ version: CURRENT_VERSION }, null, 2),
      'utf-8'
    );
  }
}
