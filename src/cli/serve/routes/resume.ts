import { toErrorMessage } from "../../../utils/error-message.js";
import { logger } from "../../../utils/logger";
import { parseJSONBody, sendError, sendRequestParseError } from "../http";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The legacy POST /resume/:token entry point.
 */
export async function resumeRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, routePath } = rq;
  const {
    options,
    workers,
    wakeListHubs,
    findSessionStatusInfo,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    const resumeMatch = req.method === "POST" ? routePath.match(/^\/resume\/([^/?#]+)/) : null;
    if (resumeMatch) {
      try {
        const body = await parseJSONBody(req);
        const sessionId = decodeURIComponent(resumeMatch[1]);
        const projectId = typeof body.project === 'string' ? body.project : undefined;
        const located = await findSessionStatusInfo(sessionId, projectId);

        if (!located.success) {
          sendError(res, located.status, located.code, located.message);
          return;
        }

        const project = located.project;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }

        projectWorker.execute({
          projectRoot: project.root,
          sessionId,
          toolResult: body.toolResult,
          resumeToken: typeof body.resumeToken === 'string'
            ? body.resumeToken
            : req.headers.authorization?.startsWith('Bearer ')
              ? req.headers.authorization.slice(7)
              : undefined,
          debug: options.debug,
        }).then(result => {
          if (!result.success) {
            logger.warn(`Resume ${sessionId} failed: ${result.error.message}`);
          }
          wakeListHubs();
        });

        wakeListHubs();
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId, status: "running" }));
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
