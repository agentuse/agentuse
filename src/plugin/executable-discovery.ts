import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Detect a CLI on the server PATH without executing third-party code. */
export async function hasExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) return false;
  const suffixes = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, command + suffix);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return true;
      } catch { /* Missing or not executable. */ }
    }
  }
  return false;
}
