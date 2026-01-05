import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { glob } from "glob";
import chalk from "chalk";
import { parseAgent } from "../parser";
import { runAgent, executeAgentCore, prepareAgentExecution, type AgentChunk } from "../runner";
import { connectMCP, type MCPConnection } from "../mcp";
import { resolveProjectContext } from "../utils/project";
import { logger, LogLevel, executionLog } from "../utils/logger";
import { printLogo } from "../utils/branding";
import { SessionManager } from "../session";
import { initStorage } from "../storage/index.js";
import { Scheduler, type Schedule } from "../scheduler";
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
        dotenv.config({ path: projectContext.envFile });
        logger.debug(`Loaded env from: ${projectContext.envFile}`);
      }

      // Initialize storage
      try {
        await initStorage(projectContext.projectRoot);
        logger.debug("Session storage initialized");
      } catch (err) {
        logger.warn(`Failed to initialize session storage: ${(err as Error).message}`);
      }

      // Helper function to execute an agent (used by both API and scheduler)
      const executeScheduledAgent = async (
        schedule: Schedule
      ): Promise<{ success: boolean; duration: number; error?: string; sessionId?: string }> => {
        const startTime = Date.now();
        const agentPath = resolve(projectContext.projectRoot, schedule.agentPath);
        let mcp: MCPConnection[] = [];

        try {
          const agent = await parseAgent(agentPath);
          const mcpBasePath = dirname(agentPath);
          mcp = await connectMCP(agent.config.mcpServers, options.debug ?? false, mcpBasePath);

          const sessionManager = new SessionManager();

          await runAgent(
            agent,
            mcp,
            options.debug ?? false,
            undefined, // no abort signal for scheduled runs
            startTime,
            false, // not verbose for scheduled runs
            agentPath,
            undefined,
            sessionManager,
            { projectRoot: projectContext.projectRoot, cwd: workDir },
            undefined, // userPrompt
            undefined, // preparedExecution
            true // quiet mode for serve
          );

          return {
            success: true,
            duration: Date.now() - startTime,
          };
        } catch (error) {
          return {
            success: false,
            duration: Date.now() - startTime,
            error: (error as Error).message,
          };
        } finally {
          for (const conn of mcp) {
            try {
              await conn.client.close();
            } catch {
              // Ignore cleanup errors
            }
          }
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
        let mcp: MCPConnection[] = [];

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

          // Parse agent
          const agent = await parseAgent(agentPath);

          // Override model if specified
          if (body.model) {
            agent.config.model = body.model;
          }

          // Connect MCP servers
          const mcpBasePath = dirname(agentPath);
          mcp = await connectMCP(agent.config.mcpServers, options.debug ?? false, mcpBasePath);

          // Create abort controller for timeout
          const timeoutSeconds = body.timeout ?? agent.config.timeout ?? 300;
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);

          // Initialize session manager
          const sessionManager = new SessionManager();

          if (wantsStream) {
            // NDJSON streaming response
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson",
              "Transfer-Encoding": "chunked",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            });

            // Handle client disconnect
            req.on("close", () => {
              abortController.abort();
            });

            try {
              // Use shared preparation logic
              const {
                tools,
                systemMessages,
                userMessage,
                maxSteps,
                subAgentNames
              } = await prepareAgentExecution({
                agent,
                mcpClients: mcp,
                agentFilePath: agentPath,
                cliMaxSteps: body.maxSteps,
                sessionManager,
                projectContext: { projectRoot: projectContext.projectRoot, cwd: workDir },
                userPrompt: body.prompt,
                abortSignal: abortController.signal,
                verbose: options.debug
              });

              // Execute agent and stream chunks
              const generator = executeAgentCore(agent, tools, {
                userMessage,
                systemMessages,
                maxSteps,
                abortSignal: abortController.signal,
                subAgentNames,
              });

              for await (const chunk of generator) {
                const line = JSON.stringify(chunk) + "\n";
                res.write(line);
              }

              // Write final finish chunk with duration
              const streamDuration = Date.now() - startTime;
              const finishChunk: AgentChunk = {
                type: "finish",
                finishReason: "end-turn",
              };
              res.write(JSON.stringify({ ...finishChunk, duration: streamDuration }) + "\n");
              executionLog.complete(body.agent, streamDuration);
            } catch (err) {
              const errorDuration = Date.now() - startTime;
              const errorChunk: AgentChunk = {
                type: "error",
                error: (err as Error).message,
              };
              res.write(JSON.stringify(errorChunk) + "\n");
              executionLog.failed(body.agent, errorDuration, (err as Error).message);
            } finally {
              clearTimeout(timeoutId);
              res.end();
            }
          } else {
            // Non-streaming JSON response
            try {
              const result = await runAgent(
                agent,
                mcp,
                options.debug ?? false,
                abortController.signal,
                startTime,
                options.debug ?? false,
                agentPath,
                body.maxSteps,
                sessionManager,
                { projectRoot: projectContext.projectRoot, cwd: workDir },
                body.prompt,
                undefined, // preparedExecution
                true // quiet mode for serve
              );

              clearTimeout(timeoutId);

              const nonStreamDuration = Date.now() - startTime;
              const response: RunResponse = {
                success: true,
                result: {
                  text: result.text,
                  ...(result.finishReason && { finishReason: result.finishReason }),
                  duration: nonStreamDuration,
                  ...(result.usage && { tokens: { input: result.usage.inputTokens || 0, output: result.usage.outputTokens || 0 } }),
                  toolCalls: result.toolCallCount,
                },
              };

              sendJSON(res, 200, response);
              executionLog.complete(body.agent, nonStreamDuration);
            } catch (err) {
              clearTimeout(timeoutId);

              const errorDuration = Date.now() - startTime;
              if (abortController.signal.aborted) {
                sendError(res, 504, "TIMEOUT", `Agent execution timed out after ${timeoutSeconds}s`);
                executionLog.timeout(body.agent, errorDuration);
              } else {
                sendError(res, 500, "EXECUTION_ERROR", (err as Error).message);
                executionLog.failed(body.agent, errorDuration, (err as Error).message);
              }
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
        } finally {
          // Cleanup MCP connections
          for (const conn of mcp) {
            try {
              await conn.client.close();
            } catch {
              // Ignore cleanup errors
            }
          }
        }
      });

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down...");
        scheduler.shutdown();
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

        // Loaded agents
        if (agentFiles.length > 0) {
          console.log(`\n  ${chalk.dim(`Agents (${agentFiles.length})`)}`);
          for (const agent of agentFiles) {
            console.log(`    ${agent}`);
          }
        }

        // Webhooks
        console.log(`\n  ${chalk.dim("Webhooks")}`);
        const authHeader = apiKey ? ` -H "Authorization: Bearer $AGENTUSE_API_KEY"` : "";
        console.log(`    curl -X POST ${serverUrl}/run${authHeader} -H "Content-Type: application/json" -d '{"agent": "${firstAgent}"}'`);
        console.log(`    ${chalk.dim(`curl -N ... -H "Accept: application/x-ndjson" -d '{"agent": "..."}' (streaming)`)}`);

        // Scheduled agents
        const schedules = scheduler.list();
        if (schedules.length > 0) {
          console.log(`\n  ${chalk.dim(`Scheduled (${schedules.length})`)}`);
          console.log(scheduler.formatScheduleTable());
        }

        console.log();
      });
    });

  return serveCmd;
}
