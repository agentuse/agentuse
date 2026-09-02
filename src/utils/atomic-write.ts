import { access, chmod, open, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface AtomicWriteOptions {
  /** Mode used for a newly-created destination. Existing modes are preserved. */
  mode?: number;
}

/**
 * Replace a file without ever exposing a partially-written destination.
 *
 * The temporary file lives beside the target so the final rename is atomic on
 * the same filesystem. A unique name keeps independent AgentUse processes from
 * sharing a temp file, and fsync makes the bytes durable before they become the
 * authoritative path.
 */
export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const priorMode = await stat(target).then((info) => info.mode & 0o777).catch(() => undefined);
  if (priorMode !== undefined) await access(target, constants.W_OK);
  const handle = await open(temporary, 'wx', options.mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    // `writeFile` used to preserve an existing agent file's mode. A temp-file
    // replacement must do so explicitly or graduation can silently change a
    // read-only/group-shared source file to the process umask defaults.
    if (priorMode !== undefined) await chmod(temporary, priorMode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
