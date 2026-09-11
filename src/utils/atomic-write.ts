import { access, chmod, link, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicWriteOptions {
  /**
   * Mode for the destination. When given it is applied unconditionally, which
   * is what secret files (auth.json, telemetry config, global config) need: a
   * file that was somehow created world-readable is repaired on the next write.
   * When omitted an existing file's mode is preserved.
   */
  mode?: number;
  /**
   * Flush the bytes to disk before the rename. On by default. Callers that
   * write many small files on a hot path (session parts) turn it off and accept
   * the weaker durability the platform gives a plain write + rename.
   */
  fsync?: boolean;
  /** Create the parent directory first. */
  mkdir?: boolean;
}

/** Temp name is unique per writer: two processes writing the same target must
 * never share a temp file, or a shorter write fails to truncate a longer one
 * and the rename publishes valid JSON with trailing garbage. */
function temporaryPathFor(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
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
  if (options.mkdir) await mkdir(dirname(target), { recursive: true });
  const temporary = temporaryPathFor(target);
  const priorMode = await stat(target).then((info) => info.mode & 0o777).catch(() => undefined);
  if (priorMode !== undefined) await access(target, constants.W_OK);
  const handle = await open(temporary, 'wx', options.mode);
  try {
    await handle.writeFile(content);
    if (options.fsync !== false) await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    // `writeFile` used to preserve an existing agent file's mode. A temp-file
    // replacement must do so explicitly or graduation can silently change a
    // read-only/group-shared source file to the process umask defaults. An
    // explicit `mode` wins, so a secret file is re-tightened on every write.
    const finalMode = options.mode ?? priorMode;
    if (finalMode !== undefined) await chmod(temporary, finalMode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Synchronous twin of {@link atomicWriteFile}, for callers already on a sync
 * path (process-exit hooks, the effect WAL, the global config writer). */
export function atomicWriteFileSync(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  if (options.mkdir) mkdirSync(dirname(target), { recursive: true });
  const temporary = temporaryPathFor(target);
  let priorMode: number | undefined;
  try {
    priorMode = statSync(target).mode & 0o777;
  } catch {
    priorMode = undefined;
  }
  if (priorMode !== undefined) accessSync(target, constants.W_OK);
  const fd = openSync(temporary, 'wx', options.mode);
  try {
    writeFileSync(fd, content);
    if (options.fsync !== false) fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* best-effort */ }
    try { unlinkSync(temporary); } catch { /* best-effort */ }
    throw error;
  }
  closeSync(fd);
  try {
    const finalMode = options.mode ?? priorMode;
    if (finalMode !== undefined) chmodSync(temporary, finalMode);
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * Create a file only if nothing is there, with the content already complete.
 *
 * `open(O_EXCL)` on the destination would publish an empty file that a reader
 * or a concurrent writer can observe. Writing a private temp file and `link`ing
 * it into place keeps the exclusivity (link fails EEXIST) while making the
 * first visible state the finished content. Callers map EEXIST themselves.
 */
export async function createFileExclusive(
  target: string,
  content: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, options.mode ?? 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
