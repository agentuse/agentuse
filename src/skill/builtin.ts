import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = join(moduleDir, '..', '..');
  if (existsSync(join(sourceRoot, 'package.json'))) return sourceRoot;
  return join(moduleDir, '..');
}

/** Load authoritative instructions shipped with this exact AgentUse build.
 * Builtin names are deliberately closed to a single path segment so callers
 * cannot turn skill loading into arbitrary filesystem access. */
export async function loadBuiltinSkillSource(name: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error(`Invalid builtin skill name: ${name}`);
  }
  return readFile(join(packageRoot(), 'skill-data', name, 'SKILL.md'), 'utf8');
}
