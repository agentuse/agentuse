import { toErrorMessage } from "../../../utils/error-message.js";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import type { ServeContext, ServeRequest } from "../context";

/**
 * Web Push subscription management (operator surface, behind the header gate).
 * Subscriptions are per browser+device; prefs pick which categories it gets.
 */
export async function pushRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath } = rq;
  const {
    pushService,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {
    // Web Push subscription management, operator surface (behind the
    // header gate above). Subscriptions are per browser+device; prefs
    // pick which event categories that device gets.
    if (isApi && routePath === "/push/public-key" && req.method === "GET") {
      sendJSON(res, 200, { publicKey: pushService.publicKey });
      return;
    }
    if (isApi && routePath === "/push/subscription") {
      if (req.method === "GET") {
        const endpoint = requestUrl.searchParams.get("endpoint");
        if (!endpoint) {
          sendError(res, 400, "INVALID_REQUEST", "Missing endpoint query parameter");
          return;
        }
        const record = pushService.get(endpoint);
        if (!record) {
          sendError(res, 404, "NOT_FOUND", "No subscription for this endpoint");
          return;
        }
        sendJSON(res, 200, { prefs: record.prefs });
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await parseJSONBody(req);
          const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
          if (
            typeof sub?.endpoint !== "string" ||
            !/^https?:\/\//.test(sub.endpoint) ||
            typeof sub.keys?.p256dh !== "string" ||
            typeof sub.keys?.auth !== "string"
          ) {
            sendError(res, 400, "INVALID_REQUEST", "subscription must include endpoint and p256dh/auth keys");
            return;
          }
          const prefs: Partial<{ approvals: boolean; sessions: boolean }> = {};
          if (typeof body.prefs === "object" && body.prefs !== null) {
            const raw = body.prefs as Record<string, unknown>;
            if (typeof raw.approvals === "boolean") prefs.approvals = raw.approvals;
            if (typeof raw.sessions === "boolean") prefs.sessions = raw.sessions;
          }
          const record = pushService.upsert(
            { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
            prefs,
            req.headers["user-agent"]
          );
          // A device with every category off has no reason to stay registered.
          if (!record.prefs.approvals && !record.prefs.sessions) {
            pushService.remove(record.endpoint);
            sendJSON(res, 200, { subscribed: false });
            return;
          }
          sendJSON(res, 200, { subscribed: true, prefs: record.prefs });
        } catch (err) {
          if (sendRequestParseError(res, err)) return;
          sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
        }
        return;
      }
    }
    if (isApi && routePath === "/push/unsubscribe" && req.method === "POST") {
      try {
        const body = await parseJSONBody(req);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
        if (!endpoint) {
          sendError(res, 400, "INVALID_REQUEST", "Missing endpoint");
          return;
        }
        sendJSON(res, 200, { removed: pushService.remove(endpoint) });
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
