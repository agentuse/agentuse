import { toErrorMessage } from "../../../utils/error-message.js";
import { isFollowingKey } from "../following";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The followed-agents list: read it, follow or unfollow one agent, or import
 * a batch (the browser's old local pins, once).
 */
export async function followingRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  const { following, wakeListHubs } = ctx;
  if (!isApi || routePath !== '/following') return false;

  try {
    if (req.method === 'GET') {
      sendJSON(res, 200, { success: true, agents: await following.list() });
      return true;
    }
    if (req.method === 'POST') {
      const body = await parseJSONBody(req);
      let agents: string[];
      if (Array.isArray(body.add)) {
        if (!body.add.every(isFollowingKey)) {
          sendError(res, 400, 'INVALID_FOLLOWING', 'Every key must be "<project>::<agent path>"');
          return true;
        }
        agents = await following.add(body.add);
      } else if (isFollowingKey(body.key) && typeof body.following === 'boolean') {
        agents = await following.set(body.key, body.following);
      } else {
        sendError(res, 400, 'INVALID_FOLLOWING', 'Send {key, following} or {add: [keys]}');
        return true;
      }
      // Sessions narrowed to followed agents must refresh at once.
      wakeListHubs();
      sendJSON(res, 200, { success: true, agents });
      return true;
    }
  } catch (error) {
    if (sendRequestParseError(res, error)) return true;
    sendError(res, 500, 'FOLLOWING_FAILED', toErrorMessage(error));
    return true;
  }
  return false;
}
