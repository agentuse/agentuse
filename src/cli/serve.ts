import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";
import { glob } from "glob";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import chalk from "chalk";
import { parseAgent } from "../parser";
import { type AgentChunk } from "../runner";
import { resolveProjectContext } from "../utils/project";
import { logger, LogLevel, executionLog } from "../utils/logger";
import { printLogo } from "../utils/branding";
import { initStorage } from "../storage/index.js";
import { Scheduler, type Schedule } from "../scheduler";
import { FileWatcher } from "../watcher";
import { telemetry, parseModel } from "../telemetry";
import { version as packageVersion } from "../../package.json";
import { validateAgentEnvVars, formatEnvValidationError } from "../utils/env-validation";
import { registerServer, unregisterServer, updateServer, listServers, formatUptime, type ServerEntry } from "../utils/server-registry";
import { homedir } from "os";
import * as dotenv from "dotenv";

interface RunRequest {
  agent: string;
  prompt?: string;
  model?: string;
  timeout?: number;
  maxSteps?: number;
}

interface RunResponse {
  success: true;
  sessionId?: string;
  result: {
    text: string;
    finishReason?: string;
    duration: number;
    tokens?: { input: number; output: number };
    toolCalls: number;
  };
}

interface RunErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

interface WorkerExecuteOptions {
  agentPath: string;
  projectRoot: string;
  prompt?: string | undefined;
  model?: string | undefined;
  timeout?: number | undefined;
  maxSteps?: number | undefined;
  debug?: boolean | undefined;
}

interface WorkerExecuteResult {
  success: true;
  result: {
    text: string;
    finishReason?: string;
    duration: number;
    tokens?: { input: number; output: number };
    toolCalls: number;
  };
}

interface WorkerExecuteError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

/**
 * Agent Worker Manager
 *
 * Spawns and manages a worker process for agent execution.
 * The worker is spawned at serve startup (sync context) where spawn works,
 * and stays alive to handle execution requests via stdin/stdout IPC.
 *
 * This works around the EBADF issue where spawn() fails in async callback
 * contexts (HTTP handlers, scheduler callbacks) in bundled Node.js code.
 */
class AgentWorker {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pendingRequests: Map<string, {
    resolve: (value: WorkerExecuteResult | WorkerExecuteError) => void;
    timeoutId?: NodeJS.Timeout;
  }> = new Map();
  private requestCounter = 0;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  /**
   * Spawn the worker process. Must be called during server startup (sync context).
   */
  spawn(): Promise<void> {
    // Fork the same CLI with --internal-worker flag
    // This avoids needing a separate worker bundle - more elegant for npm package
    const cliPath = process.argv[1];

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;

      // Timeout if worker doesn't become ready within 10 seconds
      const startupTimeout = setTimeout(() => {
        if (!this.ready) {
          reject(new Error("Worker failed to start within 10 seconds"));
          this.shutdown();
        }
      }, 10000);

      // Clear timeout when ready
      const originalResolve = this.readyResolve;
      this.readyResolve = () => {
        clearTimeout(startupTimeout);
        originalResolve?.();
      };
    });

    this.process = spawn(process.execPath, [cliPath, "--internal-worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.readline = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.readline.on("line", (line) => {
      this.handleWorkerMessage(line);
    });

    this.process.stderr?.on("data", (data) => {
      logger.debug(`[Worker stderr] ${data.toString().trim()}`);
    });

    this.process.on("error", (err) => {
      logger.error(`Worker process error: ${err.message}`);
      this.handleWorkerDeath();
    });

    this.process.on("exit", (code) => {
      logger.warn(`Worker process exited with code ${code}`);
      this.handleWorkerDeath();
    });

    return this.readyPromise;
  }

  private handleWorkerMessage(line: string) {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);

      // Handle ready signal
      if (message.type === "ready") {
        this.ready = true;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        return;
      }

      // Handle response
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        this.pendingRequests.delete(message.id);
        pending.resolve(message);
      }
    } catch (err) {
      logger.debug(`Failed to parse worker message: ${line}`);
    }
  }

  private handleWorkerDeath() {
    this.ready = false;
    this.process = null;
    this.readline = null;

    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.resolve({
        success: false,
        error: { code: "WORKER_DIED", message: "Worker process died unexpectedly" },
      });
    }
    this.pendingRequests.clear();
  }

  /**
   * Execute an agent via the worker process.
   */
  execute(options: WorkerExecuteOptions): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return new Promise((resolve) => {
      if (!this.process || !this.ready) {
        resolve({
          success: false,
          error: { code: "WORKER_NOT_READY", message: "Worker process not ready" },
        });
        return;
      }

      const id = `req-${++this.requestCounter}`;
      const timeoutMs = (options.timeout ?? 300) * 1000 + 5000; // Add 5s buffer

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.resolve({
            success: false,
            error: { code: "TIMEOUT", message: `Request timed out after ${options.timeout ?? 300}s` },
          });
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, timeoutId });

      const request = {
        id,
        type: "execute",
        agentPath: options.agentPath,
        projectRoot: options.projectRoot,
        prompt: options.prompt,
        model: options.model,
        timeout: options.timeout,
        maxSteps: options.maxSteps,
        debug: options.debug,
      };

      this.process.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * Shutdown the worker process.
   */
  shutdown() {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}

function parseRequestBody(req: IncomingMessage): Promise<RunRequest> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.agent || typeof parsed.agent !== "string") {
          reject(new Error("Missing required field: agent"));
          return;
        }
        resolve(parsed as RunRequest);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: RunResponse | RunErrorResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJSON(res, status, { success: false, error: { code, message } });
}

function isExposedHost(host: string): boolean {
  return host !== "127.0.0.1" && host !== "localhost";
}

function validateApiKey(req: IncomingMessage, expectedKey: string | undefined): boolean {
  if (!expectedKey) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;

  const providedKey = authHeader.slice(7);
  if (!providedKey) return false;

  // Constant-time comparison to prevent timing attacks
  try {
    const expected = Buffer.from(expectedKey);
    const provided = Buffer.from(providedKey);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export function createServeCommand(): Command {
  const serveCmd = new Command("serve")
    .description("Start an HTTP server to run agents via API")
    .option("-p, --port <number>", "Port to listen on", "12233")
    .option("-H, --host <string>", "Host to bind to", "127.0.0.1")
    .option("-C, --directory <path>", "Working directory for agent resolution")
    .option("-d, --debug", "Enable debug mode")
    .option("--no-auth", "Disable API key requirement for exposed hosts (dangerous)")
    .action(async (options: { port: string; host: string; directory?: string; debug?: boolean; auth: boolean }) => {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        console.error("Invalid port number");
        process.exit(1);
      }

      // Check API key requirement for exposed hosts
      const apiKey = process.env.AGENTUSE_API_KEY;
      const authDisabled = options.auth === false;

      if (isExposedHost(options.host) && !apiKey && !authDisabled) {
        console.error(chalk.red("Error: API key required when binding to exposed host"));
        console.error(chalk.dim("Set AGENTUSE_API_KEY environment variable or use --no-auth to bypass (dangerous)"));
        process.exit(1);
      }

      // Configure logging
      if (options.debug) {
        logger.configure({ level: LogLevel.DEBUG, enableDebug: true });
        process.env.AGENTUSE_DEBUG = "true";
      }

      // Resolve working directory
      const workDir = options.directory ? resolve(options.directory) : process.cwd();
      if (!existsSync(workDir)) {
        console.error(`Directory not found: ${workDir}`);
        process.exit(1);
      }

      // Resolve project context
      // If --directory is explicitly specified, use it directly as project root
      // Otherwise, search upward for project markers
      const projectContext = options.directory
        ? {
            projectRoot: workDir,
            envFile: existsSync(resolve(workDir, '.env.local'))
              ? resolve(workDir, '.env.local')
              : resolve(workDir, '.env'),
            pluginDirs: [],
          }
        : resolveProjectContext(workDir);
      logger.info(`Project root: ${projectContext.projectRoot}`);

      // Load environment
      if (existsSync(projectContext.envFile)) {
        dotenv.config({ path: projectContext.envFile, quiet: true });
        logger.debug(`Loaded env from: ${projectContext.envFile}`);
      }

      // Initialize storage
      try {
        await initStorage(projectContext.projectRoot);
        logger.debug("Session storage initialized");
      } catch (err) {
        logger.warn(`Failed to initialize session storage: ${(err as Error).message}`);
      }

      // Initialize telemetry
      await telemetry.init(packageVersion);

      // Spawn agent worker at startup (sync context where spawn works)
      // This worker handles agent execution to work around EBADF in async callbacks
      const worker = new AgentWorker();
      try {
        await worker.spawn();
        logger.debug("Agent worker spawned successfully");
      } catch (err) {
        console.error(chalk.red(`Failed to spawn agent worker: ${(err as Error).message}`));
        process.exit(1);
      }

      // Execution stats tracking
      const serverStartTime = Date.now();
      let totalExecutions = 0;
      let successfulExecutions = 0;
      let failedExecutions = 0;

      // Helper function to execute an agent (used by scheduler)
      // Uses subprocess to work around EBADF issue when spawning from async callbacks
      const executeScheduledAgent = async (
        schedule: Schedule
      ): Promise<{ success: boolean; duration: number; error?: string; sessionId?: string }> => {
        const startTime = Date.now();
        const agentPath = resolve(projectContext.projectRoot, schedule.agentPath);

        // Parse agent for telemetry and validation
        let agent: Awaited<ReturnType<typeof parseAgent>> | undefined;
        try {
          agent = await parseAgent(agentPath);

          // Pre-flight environment variable validation
          const envValidation = validateAgentEnvVars(agent.config);
          if (!envValidation.valid) {
            throw new Error(formatEnvValidationError(envValidation));
          }
        } catch (parseError) {
          const duration = Date.now() - startTime;
          totalExecutions++;
          failedExecutions++;
          return {
            success: false,
            duration,
            error: (parseError as Error).message,
          };
        }

        // Execute via worker process to work around EBADF issue in async callbacks
        const spawnResult = await worker.execute({
          agentPath: schedule.agentPath, // Use relative path
          projectRoot: projectContext.projectRoot,
          timeout: agent.config.timeout,
          maxSteps: agent.config.maxSteps,
          debug: options.debug,
        });

        const duration = Date.now() - startTime;

        if (spawnResult.success) {
          totalExecutions++;
          successfulExecutions++;

          // Capture telemetry for scheduled execution
          telemetry.captureExecution({
            ...parseModel(agent.config.model),
            durationMs: duration,
            inputTokens: spawnResult.result.tokens?.input ?? 0,
            outputTokens: spawnResult.result.tokens?.output ?? 0,
            success: true,
            features: {
              mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
              subagentsConfigured: agent.config.subagents?.length ?? 0,
              skillsUsed: false,
              mode: 'schedule',
            },
            config: {
              timeoutCustom: agent.config.timeout !== undefined,
              maxStepsCustom: agent.config.maxSteps !== undefined,
              quietMode: true,
              debugMode: options.debug ?? false,
            },
          });

          return {
            success: true,
            duration,
          };
        } else {
          totalExecutions++;
          failedExecutions++;

          // Capture telemetry for failed scheduled execution
          telemetry.captureExecution({
            ...parseModel(agent.config.model),
            durationMs: duration,
            inputTokens: 0,
            outputTokens: 0,
            success: false,
            errorType: spawnResult.error.code === 'TIMEOUT' ? 'timeout' : 'unknown',
            features: {
              mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
              subagentsConfigured: agent.config.subagents?.length ?? 0,
              skillsUsed: false,
              mode: 'schedule',
            },
          });

          return {
            success: false,
            duration,
            error: spawnResult.error.message,
          };
        }
      };

      // Initialize scheduler
      const scheduler = new Scheduler({
        onExecute: executeScheduledAgent,
      });

      // Scan for agents with schedule config
      const agentFiles = await glob("**/*.agentuse", {
        cwd: projectContext.projectRoot,
        ignore: ["node_modules/**", "tmp/**", ".git/**"],
      });

      // Track agent count for registry updates (mutable for hot reload)
      let currentAgentCount = agentFiles.length;

      // Helper to update the server registry after hot reload changes
      const updateRegistryCounts = () => {
        updateServer({
          agentCount: currentAgentCount,
          scheduleCount: scheduler.list().length,
        });
      };

      for (const agentFile of agentFiles) {
        try {
          const agentPath = resolve(projectContext.projectRoot, agentFile);
          const agent = await parseAgent(agentPath);

          if (agent.config.schedule) {
            scheduler.add(agentFile, agent.config.schedule);
            logger.debug(`Loaded schedule for: ${agentFile}`);
          }
        } catch (err) {
          logger.warn(`Failed to load agent ${agentFile}: ${(err as Error).message}`);
        }
      }

      // Helper to print hot reload messages
      const printHotReload = (action: "added" | "changed" | "removed", path: string, schedule?: Schedule) => {
        const actionColor = action === "added" ? chalk.green : action === "removed" ? chalk.red : chalk.yellow;
        console.log(`  ${chalk.cyan("Hot reload")} Agent ${actionColor(action)}: ${chalk.dim(path)}`);
        if (schedule) {
          const nextRun = schedule.nextRun?.toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }) || "N/A";
          console.log(`             Schedule: ${chalk.dim(schedule.expression)} ${chalk.dim(`(next: ${nextRun})`)}`);
        }
      };

      // Initialize file watcher for hot reload
      const fileWatcher = new FileWatcher({
        projectRoot: projectContext.projectRoot,
        envFile: projectContext.envFile,

        onAgentAdded: async (relativePath: string) => {
          try {
            const agentPath = resolve(projectContext.projectRoot, relativePath);
            const agent = await parseAgent(agentPath);

            const schedule = agent.config.schedule ? scheduler.add(relativePath, agent.config.schedule) : undefined;
            printHotReload("added", relativePath, schedule);

            // Update registry
            currentAgentCount++;
            updateRegistryCounts();
          } catch (err) {
            logger.warn(`Hot reload: Failed to parse new agent ${relativePath}: ${(err as Error).message}`);
          }
        },

        onAgentChanged: async (relativePath: string) => {
          try {
            const agentPath = resolve(projectContext.projectRoot, relativePath);
            const agent = await parseAgent(agentPath);

            const schedule = scheduler.update(relativePath, agent.config.schedule);
            printHotReload("changed", relativePath, schedule);

            // Update registry (schedule count may have changed)
            updateRegistryCounts();
          } catch (err) {
            logger.warn(`Hot reload: Failed to parse changed agent ${relativePath}: ${(err as Error).message}`);
          }
        },

        onAgentRemoved: (relativePath: string) => {
          const hadSchedule = scheduler.removeByAgentPath(relativePath);
          printHotReload("removed", relativePath);
          if (hadSchedule) {
            logger.debug(`Hot reload: Unregistered schedule for ${relativePath}`);
          }

          // Update registry
          currentAgentCount--;
          updateRegistryCounts();
        },

        onEnvReloaded: () => {
          // Environment variables are reloaded in process.env
          // New requests will pick up the changes automatically
        },
      });

      // Start watching for file changes
      fileWatcher.start();

      const server = createServer(async (req, res) => {
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Auth check
        if (apiKey && !validateApiKey(req, apiKey)) {
          sendError(res, 401, "UNAUTHORIZED", "Invalid or missing Authorization header. Use: Authorization: Bearer <key>");
          return;
        }

        if (req.method !== "POST" || req.url !== "/run") {
          sendError(res, 404, "NOT_FOUND", "Endpoint not found. Use POST /run");
          return;
        }

        const startTime = Date.now();

        try {
          // Parse request
          const body = await parseRequestBody(req);
          const wantsStream = req.headers.accept?.includes("application/x-ndjson");

          // Resolve agent path
          const agentPath = resolve(projectContext.projectRoot, body.agent);
          if (!existsSync(agentPath)) {
            sendError(res, 404, "AGENT_NOT_FOUND", `Agent file not found: ${body.agent}`);
            return;
          }

          // Security: ensure agent is within project root
          if (!agentPath.startsWith(projectContext.projectRoot)) {
            sendError(res, 400, "INVALID_PATH", "Agent path must be within project root");
            return;
          }

          executionLog.start(body.agent);

          // Parse agent for validation and telemetry
          const agent = await parseAgent(agentPath);

          // Pre-flight environment variable validation
          const envValidation = validateAgentEnvVars(agent.config);
          if (!envValidation.valid) {
            sendError(res, 500, "ENV_MISSING", formatEnvValidationError(envValidation));
            return;
          }

          // Create abort controller for timeout
          const timeoutSeconds = body.timeout ?? agent.config.timeout ?? 300;
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);

          // Handle client disconnect
          req.on("close", () => {
            abortController.abort();
          });

          // Execute via worker process to work around EBADF issue in async callbacks
          // MCP server spawning fails in HTTP handlers due to bundler/Node.js fd issues
          const spawnResult = await worker.execute({
            agentPath: body.agent, // Use relative path, worker resolves from projectRoot
            projectRoot: projectContext.projectRoot,
            prompt: body.prompt,
            model: body.model,
            timeout: timeoutSeconds,
            maxSteps: body.maxSteps,
            debug: options.debug,
          });

          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;

          if (spawnResult.success) {
            totalExecutions++;
            successfulExecutions++;

            // Capture telemetry
            telemetry.captureExecution({
              ...parseModel(body.model || agent.config.model),
              durationMs: duration,
              inputTokens: spawnResult.result.tokens?.input ?? 0,
              outputTokens: spawnResult.result.tokens?.output ?? 0,
              success: true,
              features: {
                mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
                subagentsConfigured: agent.config.subagents?.length ?? 0,
                skillsUsed: false,
                mode: 'webhook',
              },
              config: {
                timeoutCustom: body.timeout !== undefined || agent.config.timeout !== undefined,
                maxStepsCustom: body.maxSteps !== undefined || agent.config.maxSteps !== undefined,
                quietMode: true,
                debugMode: options.debug ?? false,
              },
            });

            executionLog.complete(body.agent, duration);

            if (wantsStream) {
              // NDJSON streaming response - send result as text chunk then finish
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });

              // Send text chunk
              const textChunk: AgentChunk = {
                type: "text",
                text: spawnResult.result.text,
              };
              res.write(JSON.stringify(textChunk) + "\n");

              // Send finish chunk
              const finishChunk: AgentChunk = {
                type: "finish",
                finishReason: spawnResult.result.finishReason || "end-turn",
              };
              res.write(JSON.stringify({ ...finishChunk, duration }) + "\n");
              res.end();
            } else {
              // JSON response
              const response: RunResponse = {
                success: true,
                result: {
                  text: spawnResult.result.text,
                  ...(spawnResult.result.finishReason && { finishReason: spawnResult.result.finishReason }),
                  duration,
                  ...(spawnResult.result.tokens && { tokens: spawnResult.result.tokens }),
                  toolCalls: spawnResult.result.toolCalls,
                },
              };
              sendJSON(res, 200, response);
            }
          } else {
            totalExecutions++;
            failedExecutions++;

            const errorCode = spawnResult.error.code;
            const errorMessage = spawnResult.error.message;

            // Capture telemetry
            telemetry.captureExecution({
              ...parseModel(body.model || agent.config.model),
              durationMs: duration,
              inputTokens: 0,
              outputTokens: 0,
              success: false,
              errorType: errorCode === 'TIMEOUT' ? 'timeout' : 'unknown',
              features: {
                mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
                subagentsConfigured: agent.config.subagents?.length ?? 0,
                skillsUsed: false,
                mode: 'webhook',
              },
            });

            if (errorCode === 'TIMEOUT') {
              executionLog.timeout(body.agent, duration);
            } else {
              executionLog.failed(body.agent, duration, errorMessage);
            }

            if (wantsStream) {
              // NDJSON streaming response - send error chunk
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });

              const errorChunk: AgentChunk = {
                type: "error",
                error: errorMessage,
              };
              res.write(JSON.stringify(errorChunk) + "\n");
              res.end();
            } else {
              // JSON error response
              const httpStatus = errorCode === 'TIMEOUT' ? 504 : 500;
              sendError(res, httpStatus, errorCode, errorMessage);
            }
          }
        } catch (err) {
          const message = (err as Error).message;

          if (message.includes("Invalid JSON")) {
            sendError(res, 400, "INVALID_REQUEST", message);
          } else if (message.includes("Missing required")) {
            sendError(res, 400, "MISSING_FIELD", message);
          } else if (message.includes("not found")) {
            sendError(res, 404, "AGENT_NOT_FOUND", message);
          } else {
            sendError(res, 500, "INTERNAL_ERROR", message);
          }
        }
      });

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down...");

        // Unregister from process registry
        unregisterServer();

        scheduler.shutdown();
        worker.shutdown();

        // Capture server shutdown telemetry
        telemetry.captureServerShutdown({
          uptimeMs: Date.now() - serverStartTime,
          totalExecutions,
          successfulExecutions,
          failedExecutions,
        });
        await telemetry.shutdown();

        server.close(() => {
          console.log("Server closed");
          process.exit(0);
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      server.listen(port, options.host, () => {
        const serverUrl = `http://${options.host}:${port}`;
        const firstAgent = agentFiles[0] || "path/to/agent.agentuse";
        const schedules = scheduler.list();

        // Register server in the process registry
        registerServer({
          port,
          host: options.host,
          projectRoot: projectContext.projectRoot,
          startTime: serverStartTime,
          agentCount: agentFiles.length,
          scheduleCount: schedules.length,
          version: packageVersion,
        });

        printLogo();

        // Server info
        console.log(`  ${chalk.dim("Server")}    ${chalk.cyan(serverUrl)}`);
        console.log(`  ${chalk.dim("Directory")} ${projectContext.projectRoot}`);
        if (apiKey) {
          console.log(`  ${chalk.dim("Auth")}      ${chalk.green("API key required")}`);
        } else if (isExposedHost(options.host)) {
          console.log(`  ${chalk.dim("Auth")}      ${chalk.yellow("No API key (--no-auth)")}`);
        } else {
          console.log(`  ${chalk.dim("Auth")}      ${chalk.dim("None (localhost)")}`);
        }
        console.log(`  ${chalk.dim("Hot reload")} ${chalk.green("enabled")}`);

        // Webhooks
        console.log(`\n  ${chalk.dim("Webhooks")}`);
        const authHeader = apiKey ? ` -H "Authorization: Bearer $AGENTUSE_API_KEY"` : "";
        console.log(`    curl -X POST ${serverUrl}/run${authHeader} -H "Content-Type: application/json" -d '{"agent": "${firstAgent}"}'`);
        console.log(`    ${chalk.dim(`curl -N ... -H "Accept: application/x-ndjson" -d '{"agent": "..."}' (streaming)`)}`);

        // Available agents for webhooks
        if (agentFiles.length > 0) {
          console.log(`\n    ${chalk.dim(`Agents (${agentFiles.length})`)}`);
          for (const agent of agentFiles) {
            console.log(`      ${agent}`);
          }
        }
        // Scheduled agents
        if (schedules.length > 0) {
          console.log(`\n  ${chalk.dim(`Scheduled (${schedules.length})`)}`);
          console.log(scheduler.formatScheduleTable());
        }

        console.log();

        // Capture server start telemetry
        telemetry.captureServerStart({
          port,
          host: options.host,
          scheduledAgents: schedules.length,
          totalAgents: agentFiles.length,
          authEnabled: !!apiKey,
        });
      });
    });

  // Add ps subcommand
  serveCmd.addCommand(createPsSubcommand());

  return serveCmd;
}

// Helper functions for ps subcommand
function truncatePath(path: string, maxLen: number): string {
  const homeDir = homedir();
  let displayPath = path.startsWith(homeDir) ? "~" + path.slice(homeDir.length) : path;
  if (displayPath.length <= maxLen) {
    return displayPath;
  }
  return "..." + displayPath.slice(-(maxLen - 3));
}

function formatPsTable(servers: ServerEntry[]): string {
  if (servers.length === 0) return "";

  const headers = ["PID", "PORT", "PROJECT", "AGENTS", "SCHEDULES", "UPTIME"];
  const widths = [7, 7, 40, 7, 10, 10];

  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("──");

  const rows = servers.map((s) => [
    String(s.pid).padEnd(widths[0]),
    String(s.port).padEnd(widths[1]),
    truncatePath(s.projectRoot, widths[2]).padEnd(widths[2]),
    String(s.agentCount).padEnd(widths[3]),
    String(s.scheduleCount).padEnd(widths[4]),
    formatUptime(s.startTime).padEnd(widths[5]),
  ].join("  "));

  return [chalk.dim(headerRow), chalk.dim(separator), ...rows].join("\n");
}

function createPsSubcommand(): Command {
  return new Command("ps")
    .description("List running agentuse serve instances")
    .option("--json", "Output as JSON")
    .action((options: { json?: boolean }) => {
      const servers = listServers();

      if (options.json) {
        console.log(JSON.stringify(servers, null, 2));
        return;
      }

      if (servers.length === 0) {
        console.log(chalk.dim("No running agentuse serve instances found."));
        console.log(chalk.dim("\nStart a server with: agentuse serve"));
        return;
      }

      console.log(formatPsTable(servers));
      console.log();
      console.log(chalk.dim(`${servers.length} server${servers.length === 1 ? "" : "s"} running`));
    });
}
