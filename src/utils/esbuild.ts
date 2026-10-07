import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type Esbuild = typeof import('esbuild');

// import.meta.url first: Bun's ESM bundle inlines __filename as the build
// machine's source path, so resolving from it fails on every install. The
// desktop CJS bundle has no import.meta.url and falls back to a real __filename.
const requireFromModule = createRequire(
  (import.meta as { url?: string }).url ?? __filename,
);
let esbuildPromise: Promise<Esbuild> | undefined;

function physicalEsbuildEntry(resolvedEntry: string): string {
  const archiveSegment = `${sep}app.asar${sep}`;
  return resolvedEntry.replace(archiveSegment, `${sep}app.asar.unpacked${sep}`);
}

async function importEsbuild(): Promise<Esbuild> {
  let resolvedEntry: string;
  try {
    resolvedEntry = requireFromModule.resolve('esbuild');
  } catch (cause) {
    throw new Error('Unable to resolve the esbuild package required by AgentUse.', { cause });
  }

  const entry = physicalEsbuildEntry(resolvedEntry);
  try {
    await access(entry);
  } catch (cause) {
    throw new Error(`The packaged esbuild module is missing at ${entry}.`, { cause });
  }

  try {
    const loaded = await import(pathToFileURL(entry).href);
    if (typeof loaded.build !== 'function' || typeof loaded.transform !== 'function') {
      throw new Error('the module does not export build() and transform()');
    }
    return loaded;
  } catch (cause) {
    throw new Error(`Unable to load esbuild from ${entry}.`, { cause });
  }
}

export function loadEsbuild(): Promise<Esbuild> {
  // Forget a failed load so a long-lived daemon retries on the next call
  // instead of keeping Code Mode and plugin loading broken until restart.
  esbuildPromise ??= importEsbuild().catch((error: unknown) => {
    esbuildPromise = undefined;
    throw error;
  });
  return esbuildPromise;
}
