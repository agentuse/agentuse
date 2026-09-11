import { LearningStore, clearTidyRecord, consolidateLearnings, effectiveCap, readTidyRecord, saveManualLearning, undoConsolidation, writeTidyRecord } from "../../../learning";
import { parseAgent } from "../../../parser";
import { toErrorMessage } from "../../../utils/error-message.js";
import { resolveProjectContext } from "../../../utils/project";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { learningListPayload } from "../learnings-payload";
import { resolveScopedAgentPath } from "../project";
import { TidyJob, pruneTidyJobs, runningTidyJob, tidyJobView, tidyJobs } from "../tidy";
import { ServerResponse } from "http";
import { dirname } from "path";
import { ulid } from "ulid";
import type { ServeContext, ServeRequest } from "../context";

/**
 * An agent's learning store: listing, adding, discarding, and the tidy-up
 * consolidation with its undo.
 */
export async function agentLearningRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, routePath } = rq;
  const {
    projects,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    // Agent-level learnings: the full store for one agent, unfiltered (the
    // session endpoints above show only a single session's captures). Same
    // operator-surface gate and path validation as /agents/detail.
    const resolveAgentLearningTarget = async (
      res: ServerResponse,
      requestedProject: string | undefined,
      requestedPath: string | undefined,
    ): Promise<{ store: LearningStore; agent: Awaited<ReturnType<typeof parseAgent>>; absPath: string; stateRoot: string; tidyTarget: { project: string; runPath: string } } | null> => {
      if (!requestedProject || !requestedPath) {
        sendError(res, 400, "MISSING_PARAMS", "Both project and path are required");
        return null;
      }
      const project = projects.find((p) => p.id === requestedProject);
      if (!project) {
        sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
        return null;
      }
      if (!project.agentFiles.includes(requestedPath)) {
        sendError(res, 404, "AGENT_NOT_FOUND", `Agent not loaded: ${requestedPath}`);
        return null;
      }
      const absPath = resolveScopedAgentPath(project, requestedPath);
      const agent = await parseAgent(absPath);
      const stateRoot = resolveProjectContext(dirname(absPath), { agentFilePath: absPath }).stateRoot;
      return {
        store: LearningStore.fromAgentFile(absPath, stateRoot, agent.name),
        agent,
        absPath,
        stateRoot,
        tidyTarget: { project: project.id, runPath: requestedPath },
      };
    };

    /** The agent-scoped list, always carrying the last tidy-up so every
     *  response that redraws the panel keeps the offer to undo it. */
    const agentLearningPayload = (target: NonNullable<Awaited<ReturnType<typeof resolveAgentLearningTarget>>>) =>
      learningListPayload(target.store, {
        config: target.agent.config.learning,
        stateRoot: target.stateRoot,
        agentFilePath: target.absPath,
        tidyTarget: target.tidyTarget,
      });

    // GET /agents/learnings?project=<id>&path=<runPath>: list all stored learnings.
    if (req.method === "GET" && routePath === '/agents/learnings') {
      try {
        const target = await resolveAgentLearningTarget(
          res,
          requestUrl.searchParams.get('project') ?? undefined,
          requestUrl.searchParams.get('path') ?? undefined,
        );
        if (!target) return;
        sendJSON(res, 200, await agentLearningPayload(target));
      } catch (err) {
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /agents/learnings: add a manual rule for the agent (no session context).
    if (req.method === "POST" && routePath === '/agents/learnings') {
      try {
        const body = await parseJSONBody(req);
        const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
        if (!instruction) {
          sendError(res, 400, "INSTRUCTION_REQUIRED", "A rule to remember is required");
          return;
        }
        const target = await resolveAgentLearningTarget(
          res,
          typeof body.project === 'string' ? body.project : undefined,
          typeof body.path === 'string' ? body.path : undefined,
        );
        if (!target) return;
        await saveManualLearning({
          agentFilePath: target.absPath,
          stateRoot: target.stateRoot,
          instruction,
          model: target.agent.config.model,
          agentInstructions: target.agent.instructions,
          cap: effectiveCap(target.agent.config.learning),
        });
        sendJSON(res, 200, await agentLearningPayload(target));
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /agents/learnings/discard: drop a stored learning by id.
    if (req.method === "POST" && routePath === '/agents/learnings/discard') {
      try {
        const body = await parseJSONBody(req);
        const learningId = typeof body.id === 'string' ? body.id : '';
        if (!learningId) {
          sendError(res, 400, "ID_REQUIRED", "A learning id is required");
          return;
        }
        const target = await resolveAgentLearningTarget(
          res,
          typeof body.project === 'string' ? body.project : undefined,
          typeof body.path === 'string' ? body.path : undefined,
        );
        if (!target) return;
        await target.store.remove(learningId);
        sendJSON(res, 200, await agentLearningPayload(target));
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /agents/learnings/tidy: merge, sharpen, retire and make permanent,
    // until every stored correction reaches the agent. `dryRun` returns the
    // plan and both diffs without writing.
    //
    // Deliberately the same core call as `agentuse learnings tidy`: the
    // reviewer who lives in this UI and the operator who lives in the
    // terminal must not get different results from the same button.
    if (req.method === "POST" && routePath === '/agents/learnings/tidy') {
      try {
        const body = await parseJSONBody(req);
        const projectId = typeof body.project === 'string' ? body.project : undefined;
        const runPath = typeof body.path === 'string' ? body.path : undefined;
        const target = await resolveAgentLearningTarget(res, projectId, runPath);
        if (!target) return;

        // A second press while one is running joins the first. Two passes
        // over the same two files would race each other's writes, and the
        // loser's undo snapshot would restore the winner's output.
        const existing = runningTidyJob(projectId!, runPath!);
        if (existing) {
          sendJSON(res, 200, { success: true, job: tidyJobView(existing) });
          return;
        }

        pruneTidyJobs();
        const job: TidyJob = {
          id: ulid(),
          project: projectId!,
          path: runPath!,
          agentFilePath: target.absPath,
          stateRoot: target.stateRoot,
          startedAt: Date.now(),
          status: 'running',
          phase: 'deciding',
          step: 0,
          total: 0,
          round: 1,
          maxRounds: 1,
          projectedActive: 0,
          cap: effectiveCap(target.agent.config.learning),
          dryRun: body.dryRun === true,
        };
        tidyJobs.set(job.id, job);

        // Deliberately not awaited: the response carries the job id so the
        // page can start showing progress immediately.
        void consolidateLearnings({
          agentFilePath: target.absPath,
          agentInstructions: target.agent.instructions,
          agentModel: target.agent.config.model,
          config: target.agent.config.learning,
          stateRoot: target.stateRoot,
          onProgress: (progress) => {
            job.phase = progress.phase;
            job.step = progress.step;
            job.total = progress.total;
            job.round = progress.round;
            job.maxRounds = progress.maxRounds;
            job.projectedActive = progress.projectedActive;
            job.cap = progress.cap;
          },
          ...(job.dryRun ? { dryRun: true } : {}),
        }).then(async (result) => {
          job.result = result;
          job.status = 'done';
          job.phase = 'done';
          job.finishedAt = Date.now();
          // Only a real, applied pass is worth remembering: a dry run
          // changed nothing, so there is nothing to undo.
          if (!job.dryRun && result.undoId) {
            await writeTidyRecord(target.stateRoot, target.absPath, {
              jobId: job.id,
              agentFilePath: target.absPath,
              startedAt: job.startedAt,
              finishedAt: job.finishedAt,
              result,
            }).catch(() => {});
          }
        }).catch((err: unknown) => {
          job.status = 'error';
          job.finishedAt = Date.now();
          job.error = toErrorMessage(err);
        });

        sendJSON(res, 202, { success: true, job: tidyJobView(job) });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // GET /agents/learnings/tidy?project=&path=&job=: how the tidy-up is
    // going, and its result once it lands. Without `job` it answers with the
    // last tidy-up this agent had, read from disk — that is what makes Undo
    // reachable after the tab that started it is gone.
    if (req.method === "GET" && routePath === '/agents/learnings/tidy') {
      try {
        const projectId = requestUrl.searchParams.get('project') ?? undefined;
        const runPath = requestUrl.searchParams.get('path') ?? undefined;
        const target = await resolveAgentLearningTarget(res, projectId, runPath);
        if (!target) return;
        const jobId = requestUrl.searchParams.get('job') ?? undefined;
        const job = jobId ? tidyJobs.get(jobId) : runningTidyJob(projectId!, runPath!);
        const record = await readTidyRecord(target.stateRoot, target.absPath);

        // In-memory job first (it is the only thing that knows about a run
        // still in flight), then the record on disk, which is what survives
        // a daemon restart. Asking for a specific job only ever gets that
        // job's result: the record is the LAST tidy-up, and answering a
        // stale job id with it would show the user a result they did not
        // ask for next to an Undo button that rolls back something else.
        const recordForRequest = record && (jobId === undefined || record.jobId === jobId) ? record : null;
        const result = job?.result ?? (job === undefined ? recordForRequest?.result : undefined);
        sendJSON(res, 200, {
          ...(await agentLearningPayload(target)),
          ...(job ? { job: tidyJobView(job) } : {}),
          ...(result ? { tidy: result } : {}),
        });
      } catch (err) {
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /agents/learnings/undo: restore both files to their state before
    // the last tidy-up. Half the change lands in the agent file, so an undo
    // that only rolled back the store would leave it quietly rewritten.
    if (req.method === "POST" && routePath === '/agents/learnings/undo') {
      try {
        const body = await parseJSONBody(req);
        const target = await resolveAgentLearningTarget(
          res,
          typeof body.project === 'string' ? body.project : undefined,
          typeof body.path === 'string' ? body.path : undefined,
        );
        if (!target) return;
        const restored = await undoConsolidation(target.stateRoot, target.absPath);
        if (restored) {
          await clearTidyRecord(target.stateRoot, target.absPath);
          for (const job of tidyJobs.values()) {
            if (job.status === 'done' && job.agentFilePath === target.absPath) job.status = 'undone';
          }
        }
        sendJSON(res, 200, {
          ...(await agentLearningPayload(target)),
          undone: Boolean(restored),
          restored: restored?.restored ?? [],
        });
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
