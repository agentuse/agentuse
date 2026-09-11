import { providerReadinessSnapshot, providerSetupSnapshot } from "../../../auth/provider-setup";
import { toErrorMessage } from "../../../utils/error-message.js";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { PROVIDER_POST_ROUTES } from "../provider-routes";
import type { ServeContext, ServeRequest } from "../context";

/**
 * Provider setup: the readiness snapshots plus every provider POST endpoint,
 * driven from one shared table.
 */
export async function providerRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath } = rq;
  const {
    resetWorkerProviderPlugins,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    if (isApi && routePath === "/providers" && req.method === "GET") {
      try {
        // `?readiness=defer` skips plugin check() hooks (which can spawn a
        // CLI) so the list renders first; the client then settles rows via
        // /providers/readiness.
        const readiness = requestUrl.searchParams.get('readiness') === 'defer' ? 'defer' : 'run';
        sendJSON(res, 200, { success: true, ...await providerSetupSnapshot({ readiness }) });
      } catch (err) {
        sendError(res, 500, "PROVIDER_STATUS_FAILED", toErrorMessage(err));
      }
      return;
    }

    if (isApi && routePath === "/providers/readiness" && req.method === "GET") {
      try {
        sendJSON(res, 200, { success: true, ...await providerReadinessSnapshot({
          force: requestUrl.searchParams.get('force') === 'true',
          ...(requestUrl.searchParams.get('provider') && { provider: requestUrl.searchParams.get('provider')! }),
        }) });
      } catch (err) {
        sendError(res, 500, "PROVIDER_STATUS_FAILED", toErrorMessage(err));
      }
      return;
    }

    const providerRoute = isApi && req.method === "POST" ? PROVIDER_POST_ROUTES[routePath] : undefined;
    if (providerRoute) {
      try {
        const body = await parseJSONBody(req);
        const result = await providerRoute.handle(body);
        // Provider setup mutates plugins and credentials in this process,
        // whose reset reaches only its own caches. Workers are long-lived
        // and cache both on first use, so without this every route here
        // could report a change that runs would not see until a recycle.
        await resetWorkerProviderPlugins();
        sendJSON(res, 200, { success: true, ...result });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, providerRoute.code, toErrorMessage(err));
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
