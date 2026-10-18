import { posix, win32 } from 'node:path';

/** Artifact output is always a named directory beneath the project root. */
export function isProjectRelativeArtifactDir(dir: string): boolean {
  const portable = dir.replace(/\\/gu, '/');
  return dir.trim().length > 0
    && !posix.isAbsolute(portable)
    && !win32.isAbsolute(dir)
    && !/^[A-Za-z]:/u.test(dir)
    && !/^[~$]/u.test(dir)
    && !portable.split('/').includes('..')
    && posix.normalize(portable) !== '.';
}
