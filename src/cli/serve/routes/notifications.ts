import { sendError } from "../http";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The desktop app's native notification event stream.
 */
export async function notificationRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  const {
    notificationHub,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    if (req.method === "GET" && isApi && routePath === '/notifications/events') {
      if (!notificationHub.subscribe({ req, res })) {
        sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many native notification connections");
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
