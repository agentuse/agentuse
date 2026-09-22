import { sessionStopReason } from '../../../runner/failure';
import { parseModel } from "../../../telemetry";
import { parseAgent } from "../../../parser";
import type { AgentChunk } from "../../../runner";
import { classifyExecution, configuredFeatureUsage, emptyToolCallMetrics, telemetry } from "../../../telemetry";
import { toErrorMessage } from "../../../utils/error-message.js";
import { executionLog, logger } from "../../../utils/logger";
import { isPathInside } from "../../../utils/path-policy";
import { sessionViewToken } from "../../../utils/session-token";
import { sendError, sendJSON, sendRequestParseError } from "../http";
import { resolveScopedAgentPath, toProjectRelativeAgentPath } from "../project";
import { RunResponse, parseRequestBody, reportedSurfaceForRun, webUIClientSurface, workerExecutionErrorResponse } from "../run-request";
import { existsSync } from "fs";
import { ulid } from "ulid";
import type { ServeContext, ServeRequest } from "../context";

/**
 * POST /run: the daemon's agent execution endpoint, and the 404 fallback for
 * every path no earlier group claimed.
 */
export async function runRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, routePath } = rq;
  const {
    options,
    state: serveState,
    apiKey,
    resolveRequestProject,
    workers,
    wakeListHubs,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    if (req.method !== "POST" || routePath !== "/run") {
      sendError(res, 404, "NOT_FOUND", "Endpoint not found. Use POST /api/run or GET /api");
      return;
    }

    const startTime = Date.now();

    try {
      // Parse request
      const body = await parseRequestBody(req);
      const reportedSurface = reportedSurfaceForRun(
        body,
        webUIClientSurface(req.headers['x-agentuse-client']),
      );
      const wantsStream = req.headers.accept?.includes("application/x-ndjson");

      // Resolve project
      const resolved = resolveRequestProject(body);
      if ('error' in resolved) {
        const { status, code, message, extra } = resolved.error;
        if (extra) {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: { code, message }, ...extra }));
        } else {
          sendError(res, status, code, message);
        }
        return;
      }
      const project = resolved.project;

      // Resolve agent path
      const agentPath = resolveScopedAgentPath(project, body.agent);
      if (!existsSync(agentPath)) {
        sendError(res, 404, "AGENT_NOT_FOUND", `Agent file not found: ${body.agent}`);
        return;
      }

      // Security: ensure API agent paths stay within the served scope.
      if (!isPathInside(project.scopeRoot, agentPath)) {
        sendError(res, 400, "INVALID_PATH", "Agent path must be within served directory");
        return;
      }

      executionLog.start(serveState.multiProject ? `${project.id}/${body.agent}` : body.agent);

      // Parse agent for telemetry (env validation happens in the worker,
      // which loads the project's .env before checking process.env)
      const agent = await parseAgent(agentPath);

      // Detached mode: pre-assign the session id, kick the run off in the
      // background, and return the id immediately so the caller (the web
      // "Run" button) can navigate straight to the live session view.
      // Deliberately NOT wired to req close: we 202 right away, which closes
      // the request, and that must not abort the run.
      if (body.detach) {
        const detachWorker = workers.get(project.id);
        if (!detachWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }
        const preassignedId = ulid();
        const detachTimeout = body.timeout ?? agent.config.timeout ?? 300;
        void detachWorker.execute({
          agentPath: toProjectRelativeAgentPath(project, body.agent),
          projectRoot: project.root,
          prompt: body.prompt,
          model: body.model,
          timeout: detachTimeout,
          maxSteps: body.maxSteps,
          debug: options.debug,
          newSessionId: preassignedId,
          trigger: 'api',
        }).then((result) => {
          const duration = Date.now() - startTime;
          serveState.totalExecutions++;
          if (result.success) {
            serveState.successfulExecutions++;
            if (result.result.finishReason !== 'suspended') {
              executionLog.complete(body.agent, Date.now() - startTime);
            }
          } else {
            serveState.failedExecutions++;
            logger.warn(`Detached run ${preassignedId} failed: ${result.error.message}`);
          }
          telemetry.captureExecution({
            ...parseModel(body.model || agent.config.model),
            durationMs: duration,
            inputTokens: result.success ? result.result.tokens?.input ?? 0 : 0,
            outputTokens: result.success ? result.result.tokens?.output ?? 0 : 0,
            success: result.success,
            classification: classifyExecution({
              agentSource: 'local',
              trigger: 'api',
              isMock: false,
            }),
            executionOrigin: 'serve',
            reportedSurface,
            toolCalls: result.telemetry?.toolCalls ?? emptyToolCallMetrics(),
            ...(result.telemetry && { steps: result.telemetry.steps }),
            ...(!result.success && {
              errorType: result.error.code === 'TIMEOUT'
                ? 'timeout' as const
                : result.error.code === 'INCOMPLETE'
                  ? 'incomplete' as const
                  : 'unknown' as const,
            }),
            features: configuredFeatureUsage(agent.config, 'webhook'),
            config: {
              timeoutCustom: body.timeout !== undefined || agent.config.timeout !== undefined,
              maxStepsCustom: body.maxSteps !== undefined || agent.config.maxSteps !== undefined,
              quietMode: true,
              debugMode: options.debug ?? false,
            },
          });
        }).catch((err) => {
          serveState.totalExecutions++;
          serveState.failedExecutions++;
          logger.warn(`Detached run ${preassignedId} errored: ${toErrorMessage(err)}`);
          telemetry.captureExecution({
            ...parseModel(body.model || agent.config.model),
            durationMs: Date.now() - startTime,
            inputTokens: 0,
            outputTokens: 0,
            success: false,
            errorType: 'unknown',
            classification: classifyExecution({
              agentSource: 'local',
              trigger: 'api',
              isMock: false,
            }),
            executionOrigin: 'serve',
            reportedSurface,
            toolCalls: emptyToolCallMetrics(),
            features: configuredFeatureUsage(agent.config, 'webhook'),
          });
        }).finally(wakeListHubs);

        wakeListHubs();
        const sessionToken = apiKey ? sessionViewToken(preassignedId, apiKey) : undefined;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          sessionId: preassignedId,
          status: "running",
          ...(sessionToken && { token: sessionToken }),
        }));
        return;
      }

      const projectWorker = workers.get(project.id);
      if (!projectWorker) {
        sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
        return;
      }

      // Fresh executions are preassigned an id so a client disconnect can
      // stop the worker run instead of letting side effects continue until
      // the worker-side timeout.
      const timeoutSeconds = body.timeout ?? agent.config.timeout ?? 300;
      const abortController = new AbortController();
      const requestSessionId = body.sessionId ?? ulid();
      let responseFinished = false;
      let stopRequested = false;
      const requestStop = () => {
        if (stopRequested) return;
        stopRequested = true;
        void projectWorker.stopSession({
          projectRoot: project.root,
          sessionId: requestSessionId,
          reason: "client-disconnect",
          stopCause: "client_disconnect",
        }).catch(() => {});
      };
      res.on("finish", () => {
        responseFinished = true;
      });
      res.on("close", () => {
        if (!responseFinished) abortController.abort(sessionStopReason(undefined, 'client_disconnect'));
      });
      abortController.signal.addEventListener("abort", requestStop, { once: true });

      // Execute via worker process to work around EBADF issue in async callbacks
      // MCP server spawning fails in HTTP handlers due to bundler/Node.js fd issues
      wakeListHubs();
      const spawnResult = await projectWorker.execute({
        agentPath: toProjectRelativeAgentPath(project, body.agent),
        projectRoot: project.root,
        prompt: body.prompt,
        model: body.model,
        timeout: timeoutSeconds,
        maxSteps: body.maxSteps,
        debug: options.debug,
        sessionId: body.sessionId,
        ...(!body.sessionId && { newSessionId: requestSessionId }),
        trigger: 'api',
        signal: abortController.signal,
      });
      wakeListHubs();

      const duration = Date.now() - startTime;

      if (spawnResult.success) {
        serveState.totalExecutions++;
        serveState.successfulExecutions++;

        // Capture telemetry
        telemetry.captureExecution({
          ...parseModel(body.model || agent.config.model),
          durationMs: duration,
          inputTokens: spawnResult.result.tokens?.input ?? 0,
          outputTokens: spawnResult.result.tokens?.output ?? 0,
          success: true,
          classification: classifyExecution({
            agentSource: 'local',
            trigger: 'api',
            isMock: false,
          }),
          executionOrigin: 'serve',
          reportedSurface,
          toolCalls: spawnResult.telemetry?.toolCalls ?? emptyToolCallMetrics(),
          ...(spawnResult.telemetry && { steps: spawnResult.telemetry.steps }),
          features: configuredFeatureUsage(agent.config, 'webhook'),
          config: {
            timeoutCustom: body.timeout !== undefined || agent.config.timeout !== undefined,
            maxStepsCustom: body.maxSteps !== undefined || agent.config.maxSteps !== undefined,
            quietMode: true,
            debugMode: options.debug ?? false,
          },
        });

        if (spawnResult.result.finishReason !== 'suspended') {
          executionLog.complete(body.agent, duration);
        }

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
        serveState.totalExecutions++;
        serveState.failedExecutions++;

        const errorCode = spawnResult.error.code;
        const errorMessage = spawnResult.error.message;

        if (errorCode === 'ABORTED' && res.destroyed) {
          return;
        }

        // Capture telemetry
        telemetry.captureExecution({
          ...parseModel(body.model || agent.config.model),
          durationMs: duration,
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          classification: classifyExecution({
            agentSource: 'local',
            trigger: 'api',
            isMock: false,
          }),
          executionOrigin: 'serve',
          reportedSurface,
          toolCalls: spawnResult.telemetry?.toolCalls ?? emptyToolCallMetrics(),
          ...(spawnResult.telemetry && { steps: spawnResult.telemetry.steps }),
          errorType: errorCode === 'TIMEOUT'
            ? 'timeout'
            : errorCode === 'INCOMPLETE'
              ? 'incomplete'
              : 'unknown',
          features: configuredFeatureUsage(agent.config, 'webhook'),
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
          if (spawnResult.result?.text) {
            const textChunk: AgentChunk = {
              type: "text",
              text: spawnResult.result.text,
            };
            res.write(JSON.stringify(textChunk) + "\n");
          }

          const errorChunk: AgentChunk = {
            type: "error",
            error: spawnResult.error,
          };
          res.write(JSON.stringify(errorChunk) + "\n");
          res.end();
        } else {
          // JSON error response
          const response = workerExecutionErrorResponse(spawnResult);
          sendJSON(res, response.status, response.body);
        }
      }
    } catch (err) {
      if (sendRequestParseError(res, err)) return;
      const message = toErrorMessage(err);

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
    matched = false;
  };
  await run();
  return matched;
}
