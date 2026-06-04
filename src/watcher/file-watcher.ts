import chokidar, { type FSWatcher } from "chokidar";
import { resolve, relative } from "path";
import { glob } from "glob";
import { logger } from "../utils/logger";
import * as dotenv from "dotenv";

export interface FileWatcherOptions {
  projectRoot: string;
  agentRoot?: string;
  envFile: string;
  onAgentAdded: (relativePath: string) => Promise<void>;
  onAgentChanged: (relativePath: string) => Promise<void>;
  onAgentRemoved: (relativePath: string) => void;
  onEnvReloaded: () => void;
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
    return (
      path.includes("node_modules") ||
      path.includes("/tmp/") ||
      path.includes("/.git/") ||
      path.startsWith("tmp/")
    );
  }

  private startAgentWatcher(): void {
    const { projectRoot, agentRoot, onAgentChanged, onAgentRemoved } = this.options;
    const watchRoot = agentRoot ?? projectRoot;

    // Chokidar v5 does not support glob paths, and watching the entire served
    // tree can exceed file descriptor limits. Watch discovered agent files
    // directly, then reconcile add/remove events with a lightweight scan.
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

        try {
          onAgentRemoved(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to remove agent ${relativePath}: ${(err as Error).message}`);
        }
      })
      .on("error", (error: unknown) => {
        logger.warn(`Hot reload: Watcher error: ${(error as Error).message}`);
      });

    void this.reconcileAgentFiles(true);
    this.agentScanTimer = setInterval(() => {
      void this.reconcileAgentFiles(false);
    }, 2_000);
  }

  private async listAgentFiles(watchRoot: string): Promise<string[]> {
    const files = await glob("**/*.agentuse", {
      cwd: watchRoot,
      ignore: ["node_modules/**", "tmp/**", ".git/**"],
      nodir: true,
    });
    return files.filter((file) => !this.shouldIgnore(file)).sort();
  }

  private async reconcileAgentFiles(initial: boolean): Promise<void> {
    const { projectRoot, agentRoot, onAgentAdded, onAgentRemoved } = this.options;
    const watchRoot = agentRoot ?? projectRoot;

    let files: string[];
    try {
      files = await this.listAgentFiles(watchRoot);
    } catch (err) {
      logger.warn(`Hot reload: Failed to scan agents: ${(err as Error).message}`);
      return;
    }
    if (this.closed) return;

    const current = new Set(files);

    for (const relativePath of files) {
      if (this.watchedAgentPaths.has(relativePath)) continue;
      this.watchedAgentPaths.add(relativePath);
      this.agentWatcher?.add(resolve(watchRoot, relativePath));

      if (!initial) {
        try {
          await onAgentAdded(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to add agent ${relativePath}: ${(err as Error).message}`);
        }
      }
    }

    for (const relativePath of [...this.watchedAgentPaths]) {
      if (current.has(relativePath)) continue;
      this.watchedAgentPaths.delete(relativePath);
      this.agentWatcher?.unwatch(resolve(watchRoot, relativePath));

      if (!initial) {
        try {
          onAgentRemoved(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to remove agent ${relativePath}: ${(err as Error).message}`);
        }
      }
    }
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
        this.reloadEnv(path, envFile, onEnvReloaded);
      })
      .on("change", (path) => {
        if (this.closed) return;
        this.reloadEnv(path, envFile, onEnvReloaded);
      })
      .on("error", (error: unknown) => {
        logger.warn(`Hot reload: Env watcher error: ${(error as Error).message}`);
      });
  }

  private reloadEnv(changedFile: string, envFile: string, callback: () => void): void {
    // Reload environment variables with override to update existing vars
    dotenv.config({ path: envFile, override: true });

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
