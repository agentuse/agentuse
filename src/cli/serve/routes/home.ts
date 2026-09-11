import { version as packageVersion } from "../../../../package.json";
import { getCachedAvailableUpdate, refreshUpdateCacheInBackground } from "../../../update-check";
import { getBuildInfo } from "../../../utils/build-info";
import { canUseHostFolderPicker } from "../../../utils/local-request";
import { readAbout } from "../about";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The daemon root. GET /api answers server-info JSON; GET / falls through to
 * the SPA shell. Both read the same project rollup so the surfaces never drift.
 */
export async function homeRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  const {
    state: serveState,
    effectivePublicUrl,
    effectiveHost,
    brandNameCfg,
    projects,
    agentCounts,
    scheduler,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {
    // GET /api returns server-info JSON; GET / serves the HTML dashboard.
    // Both share the same project rollup so the two surfaces never drift.
    if (req.method === "GET" && routePath === "/") {
      const defaultProject = serveState.effectiveDefault ?? (projects.length === 1 ? projects[0]!.id : null);
      // ABOUT.md at the project root names the project for the UI (#156):
      // display identity only, read per request (mtime-cached) so edits
      // show up without a restart.
      const projectInfo = await Promise.all(projects.map(async (p) => ({
        id: p.id,
        path: p.root,
        ...(p.scopeRoot !== p.root && { scope: p.scopeRoot }),
        agentCount: agentCounts.get(p.id) ?? 0,
        scheduleCount: scheduler.list().filter((s) => s.projectId === p.id).length,
        ...await readAbout(p.root).then((about) => (about ? { about } : {})),
      })));

      if (isApi) {
        // The helper enforces the 24-hour cache interval. Calling it from
        // the polled info route lets a daemon discover releases that land
        // weeks after startup without introducing a separate live timer.
        const build = getBuildInfo();
        // A dev checkout is ahead of every published release; never offer an "update".
        if (!build.dev) refreshUpdateCacheInBackground(packageVersion);
        res.writeHead(200, { "Content-Type": "application/json" });
        const update = build.dev ? null : getCachedAvailableUpdate(packageVersion);
        res.end(JSON.stringify({
          version: build.version,
          ...(build.dev && { dev: true }),
          ...(update && { update }),
          brand: { name: brandNameCfg ?? "AgentUse" },
          // Externally reachable base for "copy link" in the UI; the Mac
          // app loads the page from 127.0.0.1, so the page's own origin
          // is useless off this machine.
          publicUrl: effectivePublicUrl,
          capabilities: {
            projectFolderPicker: canUseHostFolderPicker(effectiveHost, req.socket.remoteAddress, req.headers.host),
          },
          default: defaultProject,
          projects: projectInfo,
        }));
        return;
      }
    }
    matched = false;
  };
  await run();
  return matched;
}
