import { SessionsPayload } from "../list-payloads";
import { getManifestPath, readArtifactManifest } from "../../../tools/artifact-manifest";
import { toErrorMessage } from "../../../utils/error-message.js";
import { sessionViewToken, validateSessionToken } from "../../../utils/session-token";
import { serveSessionArtifact, serveSessionToolOutputArtifact, sessionDeclaredArtifactPaths } from "../artifacts";
import { isOperatorRequest, validateApiKey } from "../auth";
import { parseJSONBody, sendError, sendHTML, sendJSON, sendRequestParseError } from "../http";
import { selectSessionProjects } from "../project";
import { isEndedSessionStatus, sessionListStreamKey, sessionLogLimit } from "../session-lists";
import { logsWithChildSessions } from "../session-log";
import { renderWebAssetsMissingPage } from "../static";
import type { SessionContextPayload } from "../types";
import { escapeHtml } from "../ui";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The sessions surface: the list and its event stream, one session's payload,
 * status, context stack, artifacts, and its decision/resume/continue actions.
 */
export async function sessionRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath, sessionAuthorized } = rq;
  const {
    apiKey,
    serverUrl,
    projects,
    workers,
    staticAssets,
    approvalHub,
    sessionListHub,
    findApprovalInfo,
    findSessionInfo,
    findSessionStatusInfo,
    buildSessionsPayload,
    activeApprovalResumes,
    activeSessionContinuations,
    approvalActionSessionId,
    applyResumeError,
    validateDecisionChoice,
    startApprovalResume,
    startSessionContinue,
    startCascadeRetry,
    readRememberField,
    resolveRememberedLearning,
    persistRememberedLearning,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    // GET /sessions (+ /api/sessions): operator surface listing every run.
    // API-key gated (not a capability route). Filters: ?agent= ?status=
    // ?triage=<undismissed|dismissed> ?trigger= ?approval=
    // ?q=<text> (agent id/name + final output) ?window=<1h|6h|24h|7d|30d|90d|all>
    // (default: 24h).
    // Legacy ?days=<n|all> and ?hours=<n> still work.
    if (req.method === "GET" && routePath === '/sessions') {
      if (isApi) {
        const result = await buildSessionsPayload(requestUrl);
        if (!result.success) {
          sendError(res, result.status, result.code, result.message);
          return;
        }
        sendJSON(res, 200, result.payload);
        return;
      }
    }

    const sessionListEventsMatch = req.method === "GET" ? routePath.match(/^\/sessions\/events$/) : null;
    if (sessionListEventsMatch) {
      // The poll closure below captures the FIRST subscriber's full URL, so
      // every param that shapes the payload must be part of the key —
      // including limit/cursor, or a limitless Home subscriber would share
      // (and be truncated by) a limit-50 sessions-list snapshot.
      const streamKey = sessionListStreamKey(requestUrl);
      const poll: import("../sse").ApprovalListPoll<SessionsPayload> = async () => {
        const result = await buildSessionsPayload(requestUrl);
        return result.success
          ? { ok: true, snapshot: result.payload }
          : { ok: false, error: { code: result.code, message: result.message } };
      };
      if (!sessionListHub.subscribe({ key: streamKey, poll, req, res })) {
        sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many live session-list connections");
      }
      return;
    }

    // GET /api/sessions/:id: JSON twin of the session page. Header-gated
    // (handled by the global gate above, since this is an `/api/*` route).
    const sessionApiMatch = (req.method === "GET" && isApi) ? routePath.match(/^\/sessions\/([^/?#]+)$/) : null;
    if (sessionApiMatch) {
      const sessionId = decodeURIComponent(sessionApiMatch[1]);
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      const found = await findSessionInfo(sessionId, projectId);
      if (!found.success) {
        sendError(res, found.status, found.code, found.message);
        return;
      }
      const activeKey = `${found.project.id}:${sessionId}`;
      const sessionStatus = activeApprovalResumes.has(activeKey)
        ? 'resuming'
        : activeSessionContinuations.has(activeKey)
          ? 'continuing'
          : found.info.approval.sessionStatus === 'suspended'
            ? 'waiting'
            : found.info.approval.sessionStatus;
      sendJSON(res, 200, {
        success: true,
        session: {
          ...found.info.approval,
          status: sessionStatus,
          project: found.project.id,
        }
      });
      return;
    }

    // GET /sessions/:id (HTML): the unified view + approve page. Exempt from
    // the global header gate; authorized via session token / api key / local.
    // GET /sessions/:id (HTML): serve the SPA shell. The SPA fetches its
    // data from /sessions/:id/{status,events} authorized via ?token=. When
    // the caller arrives with a legacy gate resumeToken (old Slack links) or
    // an api-key header (which the browser will not resend on later fetches),
    // mint the canonical session-view token and 302 to a tokenized URL so the
    // client's own fetches authorize. On local (no api key) the token is
    // empty and links omit it; nothing to convert.
    // The optional trailing segment is the context-stack diagnostic subpage;
    // it is a client route, so it serves the same shell and is preserved
    // across the token-minting redirect.
    const sessionPageMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)(\/context)?$/) : null;
    if (sessionPageMatch) {
      const sessionId = decodeURIComponent(sessionPageMatch[1]);
      const sessionSubPath = sessionPageMatch[2] ?? '';
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;

      if (apiKey && !validateSessionToken(token, sessionId, apiKey)) {
        let allow = validateApiKey(req, apiKey);
        if (!allow && token) {
          // Not an escalation: the legacy /approvals/:id?token=<resumeToken>
          // page already granted approve to the same holder.
          const legacy = await findApprovalInfo({ ...(projectId && { projectId }), sessionId, resumeToken: token, allowHistorical: true });
          allow = legacy.success;
        }
        if (allow) {
          const minted = sessionViewToken(sessionId, apiKey);
          const target = new URL(`/sessions/${encodeURIComponent(sessionId)}${sessionSubPath}`, serverUrl);
          if (minted) target.searchParams.set('token', minted);
          if (projectId) target.searchParams.set('project', projectId);
          res.writeHead(302, { Location: `${target.pathname}${target.search}` });
          res.end();
          return;
        }
        // Otherwise fall through and serve the shell anyway; the client's
        // /status fetch surfaces the 401 in the SPA's auth-error UI.
      }

      const shell = staticAssets.renderShell();
      if (!shell) {
        sendHTML(res, 503, renderWebAssetsMissingPage());
        return;
      }
      sendHTML(res, 200, shell);
      return;
    }

    // GET /sessions/:id/events: SSE stream of session status + log deltas.
    // Same capability auth as the page; the hub runs one shared worker poll
    // per session and pushes only changes. The poll closure reproduces the
    // /status?logs=1 body exactly, so the stream and the polling fallback are
    // equivalent.
    const sessionEventsMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/events$/) : null;
    if (sessionEventsMatch) {
      const sessionId = decodeURIComponent(sessionEventsMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      const logsLimit = sessionLogLimit(requestUrl);
      if (!sessionAuthorized(sessionId, token)) {
        sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
        return;
      }
      const poll: import("../sse").SessionPoll = async () => {
        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          return { ok: false, error: { code: found.code, message: found.message } };
        }
        const activeKey = `${found.project.id}:${sessionId}`;
        const status = activeApprovalResumes.has(activeKey)
          ? 'resuming'
          : activeSessionContinuations.has(activeKey)
            ? 'continuing'
            : found.info.approval.sessionStatus === 'suspended'
              ? 'waiting'
              : found.info.approval.sessionStatus;
        const allLogs = logsWithChildSessions(
          found.info.approval.logs ?? [],
          found.info.approval.childSessions ?? [],
          (childSessionId) => {
            const params = new URLSearchParams();
            const childToken = sessionViewToken(childSessionId, apiKey);
            if (childToken) params.set('token', childToken);
            params.set('project', found.project.id);
            return `/sessions/${encodeURIComponent(childSessionId)}?${params.toString()}`;
          },
          found.info.approval.importantDescendants ?? [],
          { sessionId, agentName: found.info.approval.agent.name },
          found.info.approval.importantDescendantEvents ?? []
        );
        const logs = allLogs.slice(-logsLimit);
        const approval = { ...found.info.approval };
        delete approval.logs;
        if (approval.parentSessionId) {
          const params = new URLSearchParams();
          const parentToken = isOperatorRequest(req.headers.authorization, apiKey) ? sessionViewToken(approval.parentSessionId, apiKey) : '';
          if (parentToken) params.set('token', parentToken);
          params.set('project', found.project.id);
          approval.parentHref = `/sessions/${encodeURIComponent(approval.parentSessionId)}?${params.toString()}`;
        }
        applyResumeError(approval, activeKey);
        return { ok: true, snapshot: { status, approval, logs } };
      };
      if (!approvalHub.subscribe({ key: `${sessionId}:logs:${logsLimit}`, sessionId, poll, req, res })) {
        sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many live connections for this session");
      }
      return;
    }

    // GET /sessions/:id/status: live status poll for the session page.
    const sessionStatusMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/status$/) : null;
    if (sessionStatusMatch) {
      const sessionId = decodeURIComponent(sessionStatusMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      const includeLogs = requestUrl.searchParams.get('logs') === '1';
      const logsLimit = sessionLogLimit(requestUrl);
      if (!sessionAuthorized(sessionId, token)) {
        sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
        return;
      }
      if (!includeLogs) {
        const found = await findSessionStatusInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const activeKey = `${found.project.id}:${sessionId}`;
        const status = activeApprovalResumes.has(activeKey)
          ? 'resuming'
          : activeSessionContinuations.has(activeKey)
            ? 'continuing'
            : found.session.sessionStatus === 'suspended'
              ? 'waiting'
              : found.session.sessionStatus;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          sessionId,
          status,
          project: found.project.id,
          approval: applyResumeError({ ...found.session }, activeKey)
        }));
        return;
      }

      const found = await findSessionInfo(sessionId, projectId);
      if (!found.success) {
        sendError(res, found.status, found.code, found.message);
        return;
      }
      const statusSessionId = approvalActionSessionId(found.info, sessionId);
      const activeKey = `${found.project.id}:${statusSessionId}`;
      const status = activeApprovalResumes.has(activeKey)
        ? 'resuming'
        : activeSessionContinuations.has(activeKey)
          ? 'continuing'
          : found.info.approval.sessionStatus === 'suspended'
            ? 'waiting'
            : found.info.approval.sessionStatus;
      const allLogs = logsWithChildSessions(
        found.info.approval.logs ?? [],
        found.info.approval.childSessions ?? [],
        (childSessionId) => {
          const params = new URLSearchParams();
          const childToken = sessionViewToken(childSessionId, apiKey);
          if (childToken) params.set('token', childToken);
          params.set('project', found.project.id);
          return `/sessions/${encodeURIComponent(childSessionId)}?${params.toString()}`;
        },
        found.info.approval.importantDescendants ?? [],
        { sessionId, agentName: found.info.approval.agent.name },
        found.info.approval.importantDescendantEvents ?? []
      );
      const logs = allLogs.slice(-logsLimit);
      const parentSid = found.info.approval.parentSessionId;
      let parentHref: string | undefined;
      if (parentSid) {
        const params = new URLSearchParams();
        const parentToken = isOperatorRequest(req.headers.authorization, apiKey) ? sessionViewToken(parentSid, apiKey) : '';
        if (parentToken) params.set('token', parentToken);
        params.set('project', found.project.id);
        parentHref = `/sessions/${encodeURIComponent(parentSid)}?${params.toString()}`;
      }
      // The log array is shipped once, at the top level. Leaving a copy on
      // `approval` doubles the payload of the SPA's busiest poll.
      const approval = { ...found.info.approval };
      delete approval.logs;
      if (parentHref) approval.parentHref = parentHref;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        sessionId,
        status,
        approval: applyResumeError(approval, activeKey),
        logs,
        logsTotal: allLogs.length,
        decision: found.info.approval.decision
      }));
      return;
    }

    // GET /sessions/:id/artifacts-list: project artifacts this run produced,
    // read from the artifact manifest. Token-gated like the rest of the
    // session page data so the SPA fetches it with ?token=. The file bytes are
    // served separately by /sessions/:id/artifacts/<path>.
    const sessionArtifactsListMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/artifacts-list$/) : null;
    if (sessionArtifactsListMatch) {
      const sessionId = decodeURIComponent(sessionArtifactsListMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      if (!sessionAuthorized(sessionId, token)) {
        sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
        return;
      }
      // Resolving an artifact list needs only the owning project. The old
      // path rebuilt the complete transcript/approval view before reading
      // the manifest, multiplying that work during live log bursts.
      const found = await findSessionStatusInfo(sessionId, projectId);
      if (!found.success) {
        sendError(res, found.status, found.code, found.message);
        return;
      }
      const manifest = await readArtifactManifest(getManifestPath(found.project.root));
      const artifacts = manifest.artifacts
        .filter((a) => a.sessionId === sessionId)
        .map((a) => ({
          name: a.name,
          ...(a.title !== undefined ? { title: a.title } : {}),
          type: a.type,
          group: a.group,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        }));
      sendJSON(res, 200, { success: true, artifacts });
      return;
    }

    // GET /sessions/:id/context-stack: the diagnostic breakdown of what went
    // into this run's context window - system messages, tool schemas, agent
    // instructions, inlined skill files, injected corrections. Read-only and
    // reconstructed from what the run already persisted. Named
    // `context-stack` because `/sessions/:id/context` is the SPA page that
    // renders it.
    const sessionContextMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/context-stack$/) : null;
    if (sessionContextMatch) {
      const sessionId = decodeURIComponent(sessionContextMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      if (!sessionAuthorized(sessionId, token)) {
        sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
        return;
      }
      const selection = selectSessionProjects(projects, projectId);
      if (!selection.success) {
        sendError(res, selection.status, selection.code, selection.message);
        return;
      }
      let contextResult: SessionContextPayload | undefined;
      let contextError: { status: number; code: string; message: string } | undefined;
      for (const project of selection.projects) {
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          contextError ??= { status: 500, code: "WORKER_UNAVAILABLE", message: `No worker for project ${project.id}` };
          continue;
        }
        const info = await projectWorker.getSessionContext({ projectRoot: project.root, sessionId });
        if (info.success) {
          contextResult = info.context;
          break;
        }
        if (info.error.code !== 'SESSION_NOT_FOUND') {
          contextError ??= {
            status: info.error.code === 'SESSION_CORRUPTED' ? 422 : 500,
            code: info.error.code,
            message: info.error.message,
          };
        }
      }
      if (!contextResult) {
        const fallback = contextError ?? { status: 404, code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` };
        sendError(res, fallback.status, fallback.code, fallback.message);
        return;
      }
      sendJSON(res, 200, { success: true, context: contextResult });
      return;
    }

    // GET /sessions/:id/artifacts/*: serve a local file artifact referenced
    // by an await_human gate, for the in-page popup viewer. Same session auth
    // as the page; the file is resolved against the project root with a
    // traversal + secrets guard.
    const sessionArtifactMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/artifacts\/(.+)$/) : null;
    if (sessionArtifactMatch) {
      const sessionId = decodeURIComponent(sessionArtifactMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      if (!sessionAuthorized(sessionId, token)) {
        sendHTML(res, 401, '<!doctype html><title>Artifact</title><p>Not authorized for this session.</p>');
        return;
      }
      const found = await findSessionInfo(sessionId, projectId);
      if (!found.success) {
        sendHTML(res, found.status, `<!doctype html><title>Artifact</title><p>${escapeHtml(found.message)}</p>`);
        return;
      }
      const declaredPaths = isOperatorRequest(req.headers.authorization, apiKey)
        ? undefined
        : sessionDeclaredArtifactPaths(
          found.project.root,
          found.info.approval.logs ?? [],
          (await readArtifactManifest(getManifestPath(found.project.root))).artifacts
            .filter((artifact) => artifact.sessionId === sessionId)
            .map((artifact) => artifact.name),
        );
      await serveSessionArtifact(res, found.project.root, sessionArtifactMatch[2], requestUrl.searchParams.get('theme') ?? undefined, {
        sessionId,
        snapHash: requestUrl.searchParams.get('snap') ?? undefined,
        rangeHeader: typeof req.headers.range === 'string' ? req.headers.range : undefined,
        declaredPaths,
      });
      return;
    }

    // GET /sessions/:id/tool-artifacts/*: serve a full tool-output artifact
    // persisted under session storage. Same session auth as the page; the
    // handler validates the path stays under the resolved storage root and
    // belongs to the requested session id.
    const sessionToolArtifactMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/tool-artifacts\/(.+)$/) : null;
    if (sessionToolArtifactMatch) {
      const sessionId = decodeURIComponent(sessionToolArtifactMatch[1]);
      const token = requestUrl.searchParams.get('token') ?? undefined;
      const projectId = requestUrl.searchParams.get('project') ?? undefined;
      if (!sessionAuthorized(sessionId, token)) {
        sendHTML(res, 401, '<!doctype html><title>Artifact</title><p>Not authorized for this session.</p>');
        return;
      }
      const found = await findSessionInfo(sessionId, projectId);
      if (!found.success) {
        sendHTML(res, found.status, `<!doctype html><title>Artifact</title><p>${escapeHtml(found.message)}</p>`);
        return;
      }
      await serveSessionToolOutputArtifact(res, found.project.root, sessionId, sessionToolArtifactMatch[2], requestUrl.searchParams.get('theme') ?? undefined);
      return;
    }

    // POST /sessions/:id/decision: approve / reject / comment on the current
    // pending gate. Authorized via session token / api key / local; the gate
    // resumeToken is resolved server-side from session state.
    const sessionDecisionMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/decision$/) : null;
    if (sessionDecisionMatch) {
      try {
        const sessionId = decodeURIComponent(sessionDecisionMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const status = typeof body.status === 'string' ? body.status : undefined;
        const comment = typeof body.comment === 'string' && body.comment.length > 0 ? body.comment : undefined;
        const choice = typeof body.choice === 'string' && body.choice.length > 0 ? body.choice : undefined;
        const remember = readRememberField(body);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
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

        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const choiceError = validateDecisionChoice(found.info, status, choice);
        if (choiceError) {
          sendError(res, 400, choiceError.code, choiceError.message);
          return;
        }

        const project = found.project;
        const targetSessionId = approvalActionSessionId(found.info, sessionId);
        const activeKey = `${project.id}:${targetSessionId}`;
        if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
          sendError(res, 409, "APPROVAL_RESUMING", "Approval decision has already been submitted and the session is resuming");
          return;
        }
        const info = found.info;
        if (info.approval.sessionStatus !== 'suspended') {
          sendError(res, 409, "SESSION_NOT_SUSPENDED", `Session is ${info.approval.sessionStatus}`);
          return;
        }
        const resumeToken = info.approval.currentResumeToken;
        if (!resumeToken) {
          sendError(res, 404, "APPROVAL_NOT_FOUND", `No pending approval gate for session ${sessionId}`);
          return;
        }
        if (info.approval.expiresAt !== undefined && info.approval.expiresAt <= Date.now()) {
          sendError(res, 410, "APPROVAL_EXPIRED", "Approval request has expired");
          return;
        }

        const rememberTarget = await resolveRememberedLearning(info, remember, targetSessionId);
        startApprovalResume(res, { project, sessionId, info, resumeToken, status, comment, choice });
        persistRememberedLearning(rememberTarget);
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/resume: recover a parent whose delegated child was
    // interrupted by a model-stream stall. No prompt is needed because the
    // child continues from its own durable transcript.
    const sessionResumeMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/resume$/) : null;
    if (sessionResumeMatch) {
      try {
        const sessionId = decodeURIComponent(sessionResumeMatch[1]);
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
        const project = found.project;
        const activeKey = `${project.id}:${sessionId}`;
        if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
          sendError(res, 409, "SESSION_ACTIVE", `Session ${sessionId} is already being resumed`);
          return;
        }
        if (!found.info.approval.cascadeRetryable) {
          sendError(res, 409, "SESSION_NOT_RESUMABLE", "This run has no safely resumable delegated task");
          return;
        }
        startCascadeRetry(res, { project, sessionId });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/continue: send a follow-up instruction to an ended
    // session, continuing it with its existing context.
    const sessionContinueMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/continue$/) : null;
    if (sessionContinueMatch) {
      try {
        const sessionId = decodeURIComponent(sessionContinueMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const prompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0 ? body.prompt.trim() : undefined;
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }
        if (!isOperatorRequest(req.headers.authorization, apiKey)) {
          sendError(res, 403, "OPERATOR_REQUIRED", "Continuing a session with a new prompt needs the API key");
          return;
        }
        if (!prompt) {
          sendError(res, 400, "PROMPT_REQUIRED", "Missing continuation prompt");
          return;
        }

        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }

        const project = found.project;
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
