import { compareStoreBrowserSummaries } from "../stores";
import type { StoreItem } from "../../../store/types";
import { toErrorMessage } from "../../../utils/error-message.js";
import { sendError, sendJSON } from "../http";
import { findStoreItemRelations, isSafeStoreName, listProjectStores, listStoreRows } from "../stores";
import type { StoreBrowserRows, StoreBrowserSummary, StoreItemRef } from "../stores";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The store browser: per-project store list, one store's rows, and a single
 * item with its relations.
 */
export async function storeRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath } = rq;
  const {
    projects,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {
    if (req.method === "GET" && routePath === '/stores') {
      const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
      const selectedProjects = requestedProject
        ? projects.filter((project) => project.id === requestedProject)
        : projects;
      if (requestedProject && selectedProjects.length === 0) {
        sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
        return;
      }

      const stores: StoreBrowserSummary[] = [];
      const errors: Array<{ projectId: string; storeName?: string; message: string }> = [];
      for (const project of selectedProjects) {
        const result = await listProjectStores(project);
        stores.push(...result.stores);
        errors.push(...result.errors.map((error) => ({ projectId: project.id, ...error })));
      }
      stores.sort(compareStoreBrowserSummaries);

      if (isApi) {
        sendJSON(res, 200, { success: true, multiProject: projects.length > 1, stores, errors });
        return;
      }
    }

    const storePageMatch = req.method === "GET" ? routePath.match(/^\/stores\/([^/?#]+)$/) : null;
    if (storePageMatch) {
      const storeName = decodeURIComponent(storePageMatch[1]);
      if (!isSafeStoreName(storeName)) {
        sendError(res, 400, "INVALID_STORE_NAME", "Invalid store name");
        return;
      }

      const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
      const selectedProjects = requestedProject
        ? projects.filter((project) => project.id === requestedProject)
        : projects;
      if (requestedProject && selectedProjects.length === 0) {
        sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
        return;
      }

      const rows: StoreBrowserRows[] = [];
      const errors: Array<{ projectId: string; message: string }> = [];
      for (const project of selectedProjects) {
        try {
          const row = await listStoreRows(project, storeName);
          if (row) rows.push(row);
        } catch (err) {
          errors.push({ projectId: project.id, message: toErrorMessage(err) });
        }
      }

      if (rows.length === 0 && errors.length === 0) {
        sendError(res, 404, "STORE_NOT_FOUND", `Store not found: ${storeName}`);
        return;
      }

      if (isApi) {
        sendJSON(res, 200, { success: true, multiProject: projects.length > 1, store: storeName, rows, errors });
        return;
      }
    }

    const storeItemPageMatch = req.method === "GET" ? routePath.match(/^\/stores\/([^/?#]+)\/([^/?#]+)$/) : null;
    if (storeItemPageMatch) {
      const storeName = decodeURIComponent(storeItemPageMatch[1]);
      const itemId = decodeURIComponent(storeItemPageMatch[2]);
      if (!isSafeStoreName(storeName)) {
        sendError(res, 400, "INVALID_STORE_NAME", "Invalid store name");
        return;
      }

      const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
      const selectedProjects = requestedProject
        ? projects.filter((project) => project.id === requestedProject)
        : projects;
      if (requestedProject && selectedProjects.length === 0) {
        sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
        return;
      }

      const errors: Array<{ projectId: string; message: string }> = [];
      let found: { projectId: string; item: StoreItem; parent: StoreItemRef | null; children: StoreItemRef[] } | undefined;
      for (const project of selectedProjects) {
        try {
          const resolved = await findStoreItemRelations(project, storeName, itemId);
          if (resolved) {
            found = { projectId: project.id, ...resolved };
            break;
          }
        } catch (err) {
          errors.push({ projectId: project.id, message: toErrorMessage(err) });
        }
      }

      if (!found) {
        if (errors.length > 0) {
          sendError(res, 500, "STORE_ITEM_LOOKUP_FAILED", errors.map((err) => `${err.projectId}: ${err.message}`).join('; '));
          return;
        }
        sendError(res, 404, "STORE_ITEM_NOT_FOUND", `Store item not found: ${itemId}`);
        return;
      }

      if (isApi) {
        sendJSON(res, 200, { success: true, multiProject: projects.length > 1, store: storeName, project: found.projectId, item: found.item, parent: found.parent, children: found.children });
        return;
      }
    }
    matched = false;
  };
  await run();
  return matched;
}
