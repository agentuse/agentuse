import { ApprovalListPayload } from "../list-payloads";
import { toErrorMessage } from "../../../utils/error-message.js";
import { approvalLog } from "../../../utils/logger";
import { sessionViewToken } from "../../../utils/session-token";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { isEndedSessionStatus, shouldLogApprovalRequest } from "../session-lists";
import { relative } from "path";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The approvals surface: the list and its event stream, the legacy per-approval
 * page, and the requested/status/decision/continue action routes.
 */
export async function approvalRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath } = rq;
  const {
    state: serveState,
    apiKey,
    serverUrl,
    effectivePublicUrl,
    workers,
    approvalListHub,
    deliverNotification,
    wakeListHubs,
    findApprovalInfo,
    buildApprovalListPayload,
    activeApprovalResumes,
    activeSessionContinuations,
    loggedApprovalRequests,
    approvalActionSessionId,
    applyResumeError,
    validateDecisionChoice,
    startApprovalResume,
    startSessionContinue,
    readRememberField,
    resolveRememberedLearning,
    persistRememberedLearning,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    if (req.method === "GET" && routePath === '/approvals') {
      if (isApi) {
        const result = await buildApprovalListPayload(requestUrl);
        if (!result.success) {
          sendError(res, result.status, result.code, result.message);
          return;
        }
        sendJSON(res, 200, result.payload);
        return;
      }
    }

    const approvalListEventsMatch = req.method === "GET" ? routePath.match(/^\/approvals\/events$/) : null;
    if (approvalListEventsMatch) {
      const streamKey = [
        'approvals',
        requestUrl.searchParams.get('days') ?? '',
        requestUrl.searchParams.get('project') ?? '',
        requestUrl.searchParams.get('view') ?? ''
      ].join(':');
      const poll: import("../sse").ApprovalListPoll<ApprovalListPayload> = async () => {
        const result = await buildApprovalListPayload(requestUrl);
        return result.success
          ? { ok: true, snapshot: result.payload }
          : { ok: false, error: { code: result.code, message: result.message } };
      };
      if (!approvalListHub.subscribe({ key: streamKey, poll, req, res })) {
        sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many live approval-list connections");
      }
      return;
    }

    // The single-approval view is an HTML page (embedded in Slack); it has no
    // JSON twin, so it only matches at root, never under `/api/*`.
    // The approval detail page is now the unified session page. Redirect
    // GET /approvals/:id -> /sessions/:id, carrying any token through. Old
    // Slack links carry a gate resumeToken; the session page accepts it as a
    // view credential during the transition window (see sessionPageMatch).
    const approvalPageMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/approvals\/([^/?#]+)$/) : null;
    if (approvalPageMatch) {
      const sessionId = decodeURIComponent(approvalPageMatch[1]);
      const target = new URL(`/sessions/${encodeURIComponent(sessionId)}`, serverUrl);
      const token = requestUrl.searchParams.get('token');
      const projectId = requestUrl.searchParams.get('project');
      if (token) target.searchParams.set('token', token);
      if (projectId) target.searchParams.set('project', projectId);
      res.writeHead(302, { Location: `${target.pathname}${target.search}` });
      res.end();
      return;
    }

    const approvalRequestedMatch = req.method === "POST" ? routePath.match(/^\/approvals\/([^/?#]+)\/requested$/) : null;
    if (approvalRequestedMatch) {
      try {
        const sessionId = decodeURIComponent(approvalRequestedMatch[1]);
        const body = await parseJSONBody(req);
        const token = typeof body.resumeToken === 'string' ? body.resumeToken : undefined;
        const approvalUrl = typeof body.approvalUrl === 'string' ? body.approvalUrl : undefined;
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!token) {
          sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
          return;
        }

        const found = await findApprovalInfo({
          ...(projectId && { projectId }),
          sessionId,
          resumeToken: token,
        });
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }

        // A new pending approval changes both lists (session suspended +
        // approvals bucket); surface it on dashboards without the 10s wait.
        wakeListHubs();

        const logKey = `${found.project.id}:${sessionId}:${token}`;
        if (shouldLogApprovalRequest(loggedApprovalRequests, logKey)) {
          const filePath = found.info.approval.agent.filePath;
          const agentLabel = filePath
            ? relative(found.project.root, filePath)
            : found.info.approval.agent.name;
          approvalLog.sent(
            serveState.multiProject ? `${found.project.id}/${agentLabel}` : agentLabel,
            found.info.approval.approvalUrl ?? approvalUrl,
            sessionId
          );
          // Same dedup guard as the log line: one push per unique approval.
          const label = serveState.multiProject ? `${found.project.id}/${agentLabel}` : agentLabel;
          const prompt = found.info.approval.prompt;
          // The first change is the verbatim payload under review; showing it in
          // the push lets the reviewer judge without opening the page.
          const firstChange = found.info.approval.changes?.[0]?.content;
          // A delegated child's page is view-only; the decision lives on the
          // cascade root's page, so deep-link the push there.
          const pushSessionId = approvalActionSessionId(found.info, sessionId);
          const approvalQuery = new URLSearchParams();
          const viewToken = sessionViewToken(pushSessionId, apiKey);
          if (viewToken) approvalQuery.set('token', viewToken);
          approvalQuery.set('project', found.project.id);
          // Badge the home-screen icon with the total pending count.
          // Counted out-of-band so the runner's callback isn't delayed.
          // Floor of 1: this push IS a pending approval, so even when the
          // list query races the announcement (or fails), the badge must
          // never be omitted or zero.
          void (async () => {
            let pendingCount = 0;
            try {
              const list = await buildApprovalListPayload(new URL(`${serverUrl}/api/approvals`));
              if (list.success) pendingCount = list.payload.buckets.pending.length;
            } catch {
              // Badge is decoration; never block the notification on it.
            }
            // Approve/Reject buttons on the notification itself, where the
            // platform renders them (Chrome/Android/desktop; iOS shows a
            // plain tap-through). Only when the decision belongs to the
            // pushed session: a delegated child's gate is decided on the
            // cascade root, whose resume token this request doesn't carry.
            // Gates that offer options can't be one-tap approved (approve
            // requires a choice), so those always tap through to the page.
            const hasOptions = (found.info.approval.options?.length ?? 0) > 0;
            const decidableInline = pushSessionId === sessionId && !hasOptions;
            await deliverNotification('approvals', {
              title: "Approval needed",
              body: [
                prompt ? `${label}: ${prompt.slice(0, 140)}` : label,
                ...(firstChange ? [firstChange.slice(0, 160)] : []),
              ].join('\n'),
              url: `${effectivePublicUrl}/sessions/${encodeURIComponent(pushSessionId)}?${approvalQuery.toString()}`,
              tag: `approval-${pushSessionId}`,
              appBadge: Math.max(1, pendingCount),
              ...(decidableInline && {
                actions: [
                  { action: 'approve', title: 'Approve' },
                  { action: 'reject', title: 'Reject' },
                ],
                decision: {
                  sessionId: pushSessionId,
                  resumeToken: token,
                  project: found.project.id,
                  ...(viewToken && { token: viewToken }),
                },
              }),
            });
          })();
        }

        sendJSON(res, 200, { success: true, status: "logged", sessionId });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    const approvalStatusMatch = req.method === "GET" ? routePath.match(/^\/approvals\/([^/?#]+)\/status$/) : null;
    if (approvalStatusMatch) {
      const sessionId = decodeURIComponent(approvalStatusMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      if (!token) {
        sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
        return;
      }

      const found = await findApprovalInfo({
        ...(projectId && { projectId }),
        sessionId,
        resumeToken: token,
        allowHistorical: true,
      });
      if (!found.success) {
        sendError(res, found.status, found.code, found.message);
        return;
      }

      const activeKey = `${found.project.id}:${sessionId}`;
      const status = activeApprovalResumes.has(activeKey)
        ? 'resuming'
        : activeSessionContinuations.has(activeKey)
          ? 'continuing'
        : found.info.approval.sessionStatus === 'suspended'
          ? 'waiting'
          : found.info.approval.sessionStatus;
      // Same single-copy rule as /sessions/:id/status: logs travel top level.
      const approval = { ...found.info.approval };
      delete approval.logs;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        sessionId,
        status,
        approval: applyResumeError(approval, activeKey),
        logs: found.info.approval.logs ?? [],
        decision: found.info.approval.decision
      }));
      return;
    }

    const approvalDecisionMatch = req.method === "POST" ? routePath.match(/^\/approvals\/([^/?#]+)\/decision$/) : null;
    if (approvalDecisionMatch) {
      try {
        const sessionId = decodeURIComponent(approvalDecisionMatch[1]);
        const body = await parseJSONBody(req);
        const token = typeof body.resumeToken === 'string' ? body.resumeToken : undefined;
        const status = typeof body.status === 'string' ? body.status : undefined;
        const comment = typeof body.comment === 'string' && body.comment.length > 0 ? body.comment : undefined;
        const choice = typeof body.choice === 'string' && body.choice.length > 0 ? body.choice : undefined;
        const remember = readRememberField(body);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!token) {
          sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
          return;
        }
        if (!status) {
          sendError(res, 400, "STATUS_REQUIRED", "Missing approval status");
          return;
        }
        if (remember && (status !== 'comment' || !comment)) {
          sendError(res, 400, "REMEMBER_REQUIRES_COMMENT", "Remembered learnings can only be saved with a non-empty comment decision");
          return;
        }

        const found = await findApprovalInfo({
          ...(projectId && { projectId }),
          sessionId,
          resumeToken: token
        });
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const choiceError = validateDecisionChoice(found.info, status, choice);
        if (choiceError) {
          sendError(res, 400, choiceError.code, choiceError.message);
          return;
        }
        if (
          !found.info.approval.currentResumeToken &&
          !found.info.approval.approvalUrl &&
          found.info.approval.decision === undefined
        ) {
          sendError(res, 404, "APPROVAL_NOT_FOUND", `Approval request not found for session ${sessionId}`);
          return;
        }

        const project = found.project;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }

        const activeKey = `${project.id}:${sessionId}`;
        if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
          sendError(res, 409, "APPROVAL_RESUMING", "Approval decision has already been submitted and the session is resuming");
          return;
        }
        const info = found.info;
        if (info.approval.sessionStatus !== 'suspended') {
          sendError(res, 409, "SESSION_NOT_SUSPENDED", `Session is ${info.approval.sessionStatus}`);
          return;
        }
        if (info.approval.expiresAt !== undefined && info.approval.expiresAt <= Date.now()) {
          sendError(res, 410, "APPROVAL_EXPIRED", "Approval request has expired");
          return;
        }

        const rememberTarget = await resolveRememberedLearning(info, remember, approvalActionSessionId(info, sessionId));
        startApprovalResume(res, { project, sessionId, info, resumeToken: token, status, comment, choice });
        persistRememberedLearning(rememberTarget);
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    const approvalContinueMatch = req.method === "POST" ? routePath.match(/^\/approvals\/([^/?#]+)\/continue$/) : null;
    if (approvalContinueMatch) {
      try {
        const sessionId = decodeURIComponent(approvalContinueMatch[1]);
        const body = await parseJSONBody(req);
        const token = typeof body.resumeToken === 'string' ? body.resumeToken : undefined;
        const prompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0 ? body.prompt.trim() : undefined;
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!token) {
          sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
          return;
        }
        if (!prompt) {
          sendError(res, 400, "PROMPT_REQUIRED", "Missing continuation prompt");
          return;
        }

        const found = await findApprovalInfo({
          ...(projectId && { projectId }),
          sessionId,
          resumeToken: token,
          allowHistorical: true
        });
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        if (
          !found.info.approval.currentResumeToken &&
          !found.info.approval.approvalUrl &&
          found.info.approval.decision === undefined
        ) {
          sendError(res, 404, "APPROVAL_NOT_FOUND", `Approval request not found for session ${sessionId}`);
          return;
        }

        const project = found.project;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }

        const activeKey = `${project.id}:${sessionId}`;
        if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
          sendError(res, 409, "SESSION_ACTIVE", `Session ${sessionId} is already being resumed`);
          return;
        }

        const sessionStatus = found.info.approval.sessionStatus;
        if (sessionStatus === 'suspended') {
          sendError(res, 409, "SESSION_SUSPENDED", "Session is suspended; submit an approval decision instead");
          return;
        }
        if (sessionStatus === 'running') {
          sendError(res, 409, "SESSION_RUNNING", `Session ${sessionId} is already running`);
          return;
        }
        if (!isEndedSessionStatus(sessionStatus)) {
          sendError(res, 409, "SESSION_NOT_ENDED", `Session is ${sessionStatus}`);
          return;
        }

        startSessionContinue(res, { project, sessionId, prompt });
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
