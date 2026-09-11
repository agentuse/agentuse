import { toErrorMessage } from "../../../utils/error-message.js";
import { logger } from "../../../utils/logger";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { isEndedSessionStatus } from "../session-lists";
import type { ServeContext, ServeRequest } from "../context";

/**
 * A session's lifecycle actions: stop, started, finished, reviewed and reopen.
 */
export async function sessionLifecycleRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath, sessionAuthorized } = rq;
  const {
    state: serveState,
    effectivePublicUrl,
    refreshProjectLists,
    workers,
    testRunWorkers,
    deliverNotification,
    wakeListHubs,
    findSessionInfo,
    findSessionStatusInfo,
    activeApprovalResumes,
    activeSessionContinuations,
    notifiedFinishedSessions,
    approvalActionSessionId,
    startApprovalResume,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    // POST /sessions/:id/stop: end a session and its subagent children.
    // When the session (or the leaf of its delegation cascade) is suspended
    // on a pending approval gate, a plain stop would orphan the gate: the
    // agent never resumes, so any state it manages (store items, drafts)
    // stays "awaiting approval" forever. Instead the stop is delivered as a
    // REJECT decision through the normal approval-resume path, letting the
    // agent record the rejection and end cleanly. If that resume fails, the
    // tree is hard-stopped as a fallback. Pass { force: true } to skip the
    // reject and hard-stop immediately. Authorized the same way as the
    // session page: local, session token, or API key.
    const sessionStopMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/stop$/) : null;
    if (sessionStopMatch) {
      try {
        const sessionId = decodeURIComponent(sessionStopMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
        const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
          ? body.reason.trim()
          : undefined;
        const force = body.force === true;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }

        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }

        const project = found.project;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }

        const info = found.info;
        const targetSessionId = approvalActionSessionId(info, sessionId);
        const gateKey = `${project.id}:${targetSessionId}`;
        const gateResumeToken = info.approval.currentResumeToken;
        // currentResumeToken is only surfaced for an actionable await_human
        // gate (own or cascade leaf), so its presence identifies a
        // rejectable approval rather than a generic await_* suspension.
        const rejectableGate = !force
          && info.approval.sessionStatus === 'suspended'
          && typeof gateResumeToken === 'string'
          && (info.approval.expiresAt === undefined || info.approval.expiresAt > Date.now())
          && !activeApprovalResumes.has(gateKey)
          && !activeSessionContinuations.has(gateKey);

        if (rejectableGate) {
          const hardStop = (): void => {
            void projectWorker.stopSession({ projectRoot: project.root, sessionId, reason, dismissEnded: true })
              .then(() => wakeListHubs())
              .catch((err) => logger.warn(`Fallback stop after failed reject-resume of ${sessionId} failed: ${toErrorMessage(err)}`));
          };
          startApprovalResume(res, {
            project,
            sessionId,
            info,
            resumeToken: gateResumeToken,
            status: 'reject',
            comment: reason ?? 'Discarded: session stopped by the reviewer',
            responseExtra: { rejected: true },
            onResumeFailure: hardStop,
          });
          return;
        }

        const activeKey = `${project.id}:${sessionId}`;
        activeApprovalResumes.delete(activeKey);
        activeSessionContinuations.delete(activeKey);

        // This route is always human-initiated (web Discard / CLI stop), so
        // an already-ended failed session gets dismissed instead of no-op'd.
        // A test run lives in its own worker; stopping it through the
        // project worker only stamps the record while the run keeps going.
        const stopWorker = testRunWorkers.get(sessionId) ?? projectWorker;
        const result = await stopWorker.stopSession({
          projectRoot: project.root,
          sessionId,
          reason,
          dismissEnded: true,
        });
        if (!result.success) {
          sendError(res, 500, result.error.code, result.error.message);
          return;
        }
        wakeListHubs();
        sendJSON(res, 200, { success: true, sessionId, stopped: result.stopped });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/started: the runner's best-effort poke that a run
    // just began (see runner/announce.ts). Runs the daemon launches itself
    // invalidate their caches inline; this is how a plain `agentuse run` in
    // another process gets the same treatment, so its session shows up live
    // instead of waiting out a cached list. No push — starting isn't news.
    const sessionStartedMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/started$/) : null;
    if (sessionStartedMatch) {
      try {
        const sessionId = decodeURIComponent(sessionStartedMatch[1]);
        const body = await parseJSONBody(req);
        const token = typeof body.token === 'string' ? body.token : requestUrl.searchParams.get('token') ?? undefined;
        const projectId = typeof body.project === 'string' ? body.project : undefined;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }

        const found = await findSessionStatusInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }

        await refreshProjectLists(found.project, { externalActivity: true });
        sendJSON(res, 200, { success: true, status: "refreshed" });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 500, "INTERNAL_ERROR", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/finished: the runner's best-effort poke that a run
    // reached a terminal state (see runner/announce.ts), fanned out as a Web
    // Push to devices subscribed to the sessions category. The reported
    // status is never trusted — it is re-read from storage — and the poke
    // carries the session view token, validated like every session action.
    const sessionFinishedMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/finished$/) : null;
    if (sessionFinishedMatch) {
      try {
        const sessionId = decodeURIComponent(sessionFinishedMatch[1]);
        const body = await parseJSONBody(req);
        const token = typeof body.token === 'string' ? body.token : requestUrl.searchParams.get('token') ?? undefined;
        const projectId = typeof body.project === 'string' ? body.project : undefined;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }

        const found = await findSessionStatusInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }

        const status = found.session.sessionStatus;
        // Regardless of push dedup below, a terminal-state poke means the
        // session lists just changed; refresh dashboards promptly. Waking
        // the hubs without dropping the worker's cache would re-serve the
        // stale "still running" list, so go through refreshProjectLists.
        await refreshProjectLists(found.project);
        if (status !== 'completed' && status !== 'error') {
          sendJSON(res, 200, { success: true, status: "ignored", reason: `session is ${status}` });
          return;
        }
        // Mock/test runs never push: a test loop would otherwise buzz the
        // phone once per iteration. The list refresh above still happened,
        // so dashboards stay current.
        if (found.session.mock) {
          sendJSON(res, 200, { success: true, status: "ignored", reason: "mock session" });
          return;
        }
        if (notifiedFinishedSessions.has(sessionId)) {
          sendJSON(res, 200, { success: true, status: "already-notified" });
          return;
        }
        notifiedFinishedSessions.set(sessionId, Date.now());
        // Bound the dedup map. First drop entries older than a day (can't
        // recur anyway); if >1000 sessions finished within the window that
        // frees nothing, so also hard-cap by evicting oldest-first (Map
        // preserves insertion order, which is time order here).
        if (notifiedFinishedSessions.size > 1000) {
          const cutoff = Date.now() - 24 * 3600 * 1000;
          for (const [key, at] of notifiedFinishedSessions) {
            if (at < cutoff) notifiedFinishedSessions.delete(key);
          }
          while (notifiedFinishedSessions.size > 1000) {
            const oldest = notifiedFinishedSessions.keys().next().value;
            if (oldest === undefined) break;
            notifiedFinishedSessions.delete(oldest);
          }
        }

        const agentName = found.session.agent.name;
        const sessionQuery = new URLSearchParams();
        if (token) sessionQuery.set('token', token);
        sessionQuery.set('project', found.project.id);
        void deliverNotification('sessions', {
          title: status === 'completed' ? "Session completed" : "Session failed",
          body: serveState.multiProject ? `${found.project.id}/${agentName}` : agentName,
          url: `${effectivePublicUrl}/sessions/${encodeURIComponent(sessionId)}?${sessionQuery.toString()}`,
          tag: `session-${sessionId}`,
        });
        sendJSON(res, 200, { success: true, status: "notified" });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/reopen: roll an ended (error/completed) session back
    // to its suspended approval gate so the reviewer can retry a resume that
    // failed downstream. User-initiated only; the normal approval/decision
    // flow takes over once it is suspended again.
    // POST /sessions/:id/reviewed: the session page opened on an ended run.
    // Stamps reviewedAt (idempotent) so "results you haven't seen" drops it.
    const sessionReviewedMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/reviewed$/) : null;
    if (sessionReviewedMatch) {
      try {
        const sessionId = decodeURIComponent(sessionReviewedMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }
        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        if (!isEndedSessionStatus(found.info.approval.sessionStatus)) {
          sendError(res, 409, "SESSION_NOT_ENDED", `Session is ${found.info.approval.sessionStatus}`);
          return;
        }
        const project = found.project;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }
        const result = await projectWorker.markSessionReviewed({ projectRoot: project.root, sessionId });
        if (!result.success) {
          sendError(res, result.error.code === 'SESSION_NOT_FOUND' ? 404 : 500, result.error.code, result.error.message);
          return;
        }
        if (!result.alreadyReviewed) wakeListHubs();
        sendJSON(res, 200, { success: true, sessionId, reviewedAt: result.reviewedAt, alreadyReviewed: result.alreadyReviewed });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    const sessionReopenMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/reopen$/) : null;
    if (sessionReopenMatch) {
      try {
        const sessionId = decodeURIComponent(sessionReopenMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }

        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }

        const sessionStatus = found.info.approval.sessionStatus;
        if (sessionStatus === 'suspended') {
          sendError(res, 409, "SESSION_SUSPENDED", "Session is already suspended");
          return;
        }
        if (sessionStatus === 'running') {
          sendError(res, 409, "SESSION_RUNNING", `Session ${sessionId} is still running`);
          return;
        }
        if (!isEndedSessionStatus(sessionStatus)) {
          sendError(res, 409, "SESSION_NOT_ENDED", `Session is ${sessionStatus}`);
          return;
        }

        const project = found.project;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }

        const activeKey = `${project.id}:${sessionId}`;
        activeApprovalResumes.delete(activeKey);
        activeSessionContinuations.delete(activeKey);

        const result = await projectWorker.reopenGate({ projectRoot: project.root, sessionId });
        if (!result.success) {
          const code = result.error.code;
          const httpStatus = code === 'NO_REOPENABLE_GATE' ? 409
            : code === 'SESSION_NOT_FOUND' ? 404
            : 400;
          sendError(res, httpStatus, code, result.error.message);
          return;
        }
        wakeListHubs();
        sendJSON(res, 200, { success: true, sessionId, status: "suspended" });
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
