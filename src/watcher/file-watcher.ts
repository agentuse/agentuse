import chokidar, { type FSWatcher } from "chokidar";
import { resolve, relative } from "path";
import { logger } from "../utils/logger";
import * as dotenv from "dotenv";

export interface FileWatcherOptions {
  projectRoot: string;
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

  private isAgentFile(path: string): boolean {
    return path.endsWith(".agentuse");
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
    const { projectRoot, onAgentAdded, onAgentChanged, onAgentRemoved } = this.options;

    // Watch the project root directory for all changes
    // and filter for .agentuse files manually
    this.agentWatcher = chokidar.watch(projectRoot, {
      ignored: [
        "**/node_modules/**",
        "**/tmp/**",
        "**/.git/**",
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.agentWatcher
      .on("add", async (absolutePath) => {
        if (this.closed) return;
        if (!this.isAgentFile(absolutePath)) return;

        const relativePath = relative(projectRoot, absolutePath);
        if (this.shouldIgnore(relativePath)) return;

        try {
          await onAgentAdded(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to add agent ${relativePath}: ${(err as Error).message}`);
        }
      })
      .on("change", async (absolutePath) => {
        if (this.closed) return;
        if (!this.isAgentFile(absolutePath)) return;

        const relativePath = relative(projectRoot, absolutePath);
        if (this.shouldIgnore(relativePath)) return;

        try {
          await onAgentChanged(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to reload agent ${relativePath}: ${(err as Error).message}`);
        }
      })
      .on("unlink", (absolutePath) => {
        if (this.closed) return;
        if (!this.isAgentFile(absolutePath)) return;

        const relativePath = relative(projectRoot, absolutePath);
        if (this.shouldIgnore(relativePath)) return;

        try {
          onAgentRemoved(relativePath);
        } catch (err) {
          logger.warn(`Hot reload: Failed to remove agent ${relativePath}: ${(err as Error).message}`);
        }
      })
      .on("error", (error: unknown) => {
        logger.warn(`Hot reload: Watcher error: ${(error as Error).message}`);
      });
  }

  private startEnvWatcher(): void {
    const { projectRoot, envFile, onEnvReloaded } = this.options;

    // Watch for env files
    const envPath = resolve(projectRoot, ".env");
    const envLocalPath = resolve(projectRoot, ".env.local");

    this.envWatcher = chokidar.watch([envPath, envLocalPath], {
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
