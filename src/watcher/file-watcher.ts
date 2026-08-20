import chokidar, { type FSWatcher } from "chokidar";
import { resolve, relative, join } from "path";
import { readdir } from "fs/promises";
import type { Dirent } from "fs";
import { logger } from "../utils/logger";
import { Semaphore } from "../utils/concurrency";
import * as dotenv from "dotenv";

export interface FileWatcherOptions {
  projectRoot: string;
  agentRoot?: string;
  envFile: string;
  agentScanIntervalMs?: number;
  onAgentAdded: (relativePath: string) => Promise<void>;
  onAgentChanged: (relativePath: string) => Promise<void>;
  onAgentRemoved: (relativePath: string) => void;
  onEnvReloaded: () => void;
}

const DEFAULT_AGENT_SCAN_INTERVAL_MS = 15_000;

/**
 * Adaptive scan cadence. Idle daemons were burning ~5% of a core forever
 * re-walking 200k+ file trees that had not changed, so after this many
 * consecutive no-diff scans the interval stretches by the multiplier below.
 * A found diff, or a chokidar change/unlink on a watched agent, drops straight
 * back to the fast cadence (and reschedules the pending timer).
 *
 * Worst case: a brand-new .agentuse file in a tree that has been quiet takes up
 * to 60s (4 x 15s) to be discovered instead of 15s. Edits and deletions of
 * already-known agents are unaffected, since those arrive as watcher events.
 */
const QUIET_SCANS_BEFORE_BACKOFF = 4;
const AGENT_SCAN_BACKOFF_MULTIPLIER = 4;

/**
 * Directories never scanned for agents, at any depth. Matched segment by
 * segment: a substring test would swallow legitimate names like `distribution/`.
 */
const IGNORED_DIR_NAMES = [
  "node_modules",
  "tmp",
  ".git",
  ".agentuse",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
];

const IGNORED_DIR_SET = new Set(IGNORED_DIR_NAMES);

// Shared across every served project: the walk fans out over directories, so a
// per-scan limit would still multiply by the number of watched projects and
// exhaust file descriptors (a known failure mode in this repo).
const scanFsSemaphore = new Semaphore(64);

async function readDirEntries(dir: string): Promise<Dirent[]> {
  try {
    // The permit covers only the syscall. Holding it across the recursion would
    // deadlock: a parent would wait on children that can never get a permit.
    return await scanFsSemaphore.run(() => readdir(dir, { withFileTypes: true }));
  } catch {
    // Unreadable directory (permissions, races with rm -rf): skip it, as glob did.
    return [];
  }
}

/**
 * Recursively list `*.agentuse` files under `watchRoot`, as sorted
 * watchRoot-relative "/"-separated paths.
 *
 * Replaces a `glob("**\/*.agentuse")` call that cost ~800-1000ms of CPU per
 * sweep on a 200k-file tree. Dot-prefixed entries are skipped at every depth
 * (glob's default `dot: false`) and IGNORED_DIR_SET directories are pruned
 * rather than walked, so the result needs no post-filtering.
 */
export async function scanAgentFiles(watchRoot: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    const entries = await readDirEntries(absoluteDir);
    const pending: Promise<void>[] = [];

    for (const entry of entries) {
      const { name } = entry;
      if (name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;

      if (entry.isDirectory()) {
        if (IGNORED_DIR_SET.has(name)) continue;
        pending.push(walk(join(absoluteDir, name), relativePath));
      } else if (entry.isFile() && name.endsWith(".agentuse")) {
        found.push(relativePath);
      }
    }

    await Promise.all(pending);
  };

  await walk(watchRoot, "");
  return found.sort();
}

/**
 * FileWatcher monitors .agentuse files and environment files for changes,
 * enabling hot reload functionality for the serve command.
 */
export class FileWatcher {
  private agentWatcher: FSWatcher | null = null;
  private envWatcher: FSWatcher | null = null;
  private options: FileWatcherOptions;
  private closed = false;
  private agentScanTimer: NodeJS.Timeout | null = null;
  private agentScanRunning = false;
  private quietScans = 0;
  private changeDebounceTimers = new Map<string, NodeJS.Timeout>();
  private watchedAgentPaths = new Set<string>();

  constructor(options: FileWatcherOptions) {
    this.options = options;
  }

  /**
   * Start watching for file changes
   */
  start(): void {
    if (this.closed) {
      throw new Error("FileWatcher has been closed and cannot be restarted");
    }

    this.startAgentWatcher();
    this.startEnvWatcher();

    logger.debug("FileWatcher: Hot reload enabled");
  }

  private shouldIgnore(path: string): boolean {
    // Only the directory segments; the file's own name is never a match.
    return path.split("/").slice(0, -1).some((segment) => IGNORED_DIR_SET.has(segment));
  }

  private startAgentWatcher(): void {
    const { projectRoot, agentRoot, onAgentChanged, onAgentRemoved } = this.options;
    const watchRoot = agentRoot ?? projectRoot;

    // Chokidar v5 does not support glob paths, and watching the entire served
    // tree can exceed file descriptor limits. Watch discovered agent files
    // directly, then reconcile add/remove events with a periodic scan. The scan
    // is intentionally self-scheduled instead of setInterval-based so a slow
    // filesystem walk cannot pile up overlapping glob work.
    this.agentWatcher = chokidar.watch([], {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.agentWatcher
      .on("change", (absolutePath) => {
        if (this.closed || !absolutePath.endsWith(".agentuse")) return;
        const relativePath = relative(watchRoot, absolutePath);
        if (this.shouldIgnore(relativePath)) return;
        // The tree is active again; stop scanning at the backed-off cadence.
        this.resetScanCadence();

        const existing = this.changeDebounceTimers.get(relativePath);
        if (existing) clearTimeout(existing);
        this.changeDebounceTimers.set(
          relativePath,
          setTimeout(async () => {
            this.changeDebounceTimers.delete(relativePath);
            try {
              await onAgentChanged(relativePath);
            } catch (err) {
              logger.warn(`Hot reload: Failed to reload agent ${relativePath}: ${(err as Error).message}`);
            }
          }, 300),
        );
      })
      .on("unlink", (absolutePath) => {
        if (this.closed || !absolutePath.endsWith(".agentuse")) return;
        const relativePath = relative(watchRoot, absolutePath);
        if (this.shouldIgnore(relativePath)) return;
        if (!this.watchedAgentPaths.delete(relativePath)) return;
        this.resetScanCadence();

        try {
          onAgentRemoved(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to remove agent ${relativePath}: ${(err as Error).message}`);
        }
      })
      .on("error", (error: unknown) => {
        logger.warn(`Hot reload: Watcher error: ${(error as Error).message}`);
      });

    void this.runAgentScan(true);
  }

  private listAgentFiles(watchRoot: string): Promise<string[]> {
    return scanAgentFiles(watchRoot);
  }

  /** Fast cadence: the configured interval, or 15s. */
  private fastScanIntervalMs(): number {
    return this.options.agentScanIntervalMs ?? DEFAULT_AGENT_SCAN_INTERVAL_MS;
  }

  private agentScanIntervalMs(): number {
    const fast = this.fastScanIntervalMs();
    return this.isBackedOff() ? fast * AGENT_SCAN_BACKOFF_MULTIPLIER : fast;
  }

  private isBackedOff(): boolean {
    return this.quietScans >= QUIET_SCANS_BEFORE_BACKOFF;
  }

  /**
   * Drop back to the fast cadence. Called on a scan that found a diff and on
   * chokidar change/unlink events; a pending long timer is rescheduled so the
   * next scan lands at the fast interval instead of up to 60s away.
   */
  private resetScanCadence(): void {
    const wasBackedOff = this.isBackedOff();
    this.quietScans = 0;
    if (wasBackedOff && this.agentScanTimer) {
      clearTimeout(this.agentScanTimer);
      this.agentScanTimer = null;
      this.scheduleAgentScan();
    }
  }

  private scheduleAgentScan(): void {
    if (this.closed || this.agentScanTimer) return;
    this.agentScanTimer = setTimeout(() => {
      this.agentScanTimer = null;
      void this.runAgentScan(false);
    }, this.agentScanIntervalMs());
  }

  private async runAgentScan(initial: boolean): Promise<void> {
    if (this.closed) return;
    if (this.agentScanRunning) {
      this.scheduleAgentScan();
      return;
    }

    this.agentScanRunning = true;
    try {
      if (await this.reconcileAgentFiles(initial)) {
        this.quietScans = 0;
      } else {
        this.quietScans++;
      }
    } finally {
      this.agentScanRunning = false;
      if (!this.closed) this.scheduleAgentScan();
    }
  }

  /** Returns true when the scan added or removed at least one agent. */
  private async reconcileAgentFiles(initial: boolean): Promise<boolean> {
    const { projectRoot, agentRoot, onAgentAdded, onAgentRemoved } = this.options;
    const watchRoot = agentRoot ?? projectRoot;

    let files: string[];
    try {
      files = await this.listAgentFiles(watchRoot);
    } catch (err) {
      logger.warn(`Hot reload: Failed to scan agents: ${(err as Error).message}`);
      return false;
    }
    if (this.closed) return false;

    const current = new Set(files);
    let changed = false;

    for (const relativePath of files) {
      // close() may land during the awaited onAgentAdded below; stop firing
      // callbacks once the watcher is closed.
      if (this.closed) return changed;
      if (this.watchedAgentPaths.has(relativePath)) continue;
      this.watchedAgentPaths.add(relativePath);
      this.agentWatcher?.add(resolve(watchRoot, relativePath));
      changed = true;

      if (!initial) {
        try {
          await onAgentAdded(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to add agent ${relativePath}: ${(err as Error).message}`);
        }
      }
    }

    for (const relativePath of [...this.watchedAgentPaths]) {
      if (this.closed) return changed;
      if (current.has(relativePath)) continue;
      this.watchedAgentPaths.delete(relativePath);
      this.agentWatcher?.unwatch(resolve(watchRoot, relativePath));
      changed = true;

      if (!initial) {
        try {
          onAgentRemoved(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to remove agent ${relativePath}: ${(err as Error).message}`);
        }
      }
    }

    return changed;
  }

  private startEnvWatcher(): void {
    const { projectRoot, envFile, onEnvReloaded } = this.options;

    // Watch env files, including a custom envFile when it differs from defaults.
    const envPath = resolve(projectRoot, ".env");
    const envLocalPath = resolve(projectRoot, ".env.local");
    const customEnvPath = resolve(projectRoot, envFile);
    const envPaths = [...new Set([envPath, envLocalPath, customEnvPath])];

    this.envWatcher = chokidar.watch(envPaths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.envWatcher
      .on("add", (path) => {
        if (this.closed) return;
        this.reloadEnv(path, onEnvReloaded);
      })
      .on("change", (path) => {
        if (this.closed) return;
        this.reloadEnv(path, onEnvReloaded);
      })
      .on("error", (error: unknown) => {
        logger.warn(`Hot reload: Env watcher error: ${(error as Error).message}`);
      });
  }

  private reloadEnv(changedFile: string, callback: () => void): void {
    // Reload from the file that actually changed; watching .env, .env.local and a
    // custom envFile means the changed path is the source of truth, not the
    // configured default.
    dotenv.config({ path: changedFile, override: true });

    const fileName = changedFile.split("/").pop() || changedFile;
    console.log(`  Hot reload: Environment reloaded from ${fileName}`);

    callback();
  }

  /**
   * Stop watching and clean up resources
   */
  async close(): Promise<void> {
    this.closed = true;

    if (this.agentScanTimer) {
      clearInterval(this.agentScanTimer);
      this.agentScanTimer = null;
    }

    for (const timer of this.changeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.changeDebounceTimers.clear();
    this.watchedAgentPaths.clear();

    const closeWithTimeout = (watcher: FSWatcher | null): Promise<void> => {
      if (!watcher) return Promise.resolve();
      return Promise.race([
        watcher.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    };

    await Promise.all([
      closeWithTimeout(this.agentWatcher),
      closeWithTimeout(this.envWatcher),
    ]);

    this.agentWatcher = null;
    this.envWatcher = null;
    logger.debug("FileWatcher: Stopped");
  }
}
