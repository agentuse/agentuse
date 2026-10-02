import { RunAbortError } from '../runner/failure';
import { createInterface } from 'readline';
import { logger, LogLevel } from '../utils/logger';
import { loadGlobalDefaults } from '../utils/global-config';
import { toErrorMessage } from '../utils/error-message';
import { stringifyJsonLine } from '../utils/json-line';
import { SessionManager } from '../session/index.js';
import { initStorage } from '../storage/index.js';
import { getApprovalInfo } from './approval.js';
import { externalActivityUntil, invalidateListCaches, EXTERNAL_ACTIVITY_WINDOW_MS } from './cache.js';
import { createWorkerContext } from './context.js';
import { getSessionFinalResponses, listAllApprovals, listSessions } from './lists.js';
import { executeAgent } from './run.js';
import { createPreparingSession, failPreparingSession, getSessionContext, getSessionStatusInfo, markSessionReviewed, reconcileOrphanSessions, reopenGate, stopSession, sweepExpiredApprovals } from './sessions.js';
import type { ExecuteRequest } from './types.js';

/**
 * Internal worker mode for serve command.
 * Listens for JSON requests on stdin, executes agents, returns JSON on stdout.
 * This works around EBADF issues when spawning from async callbacks.
 */
export async function runInternalWorker() {

  // Configure logger to be quiet
  logger.configure({ level: LogLevel.ERROR, quiet: true, disableTUI: true });
  loadGlobalDefaults();

  const ctx = createWorkerContext();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const parentPid = process.ppid;
  let workerExiting = false;
  let parentWatchTimer: NodeJS.Timeout | undefined;
  /**
   * Run requests (execute/resume/continue-session) currently executing here.
   * Counted around the whole request rather than read off
   * `ctx.activeExecutionControllers`, which only fills in once a session row exists
   * and so misses the setup window at the front of every run.
   */
  let inFlightRuns = 0;
  /**
   * Async non-run RPCs still executing. Some are reads, but several mutate
   * durable state (expiration, orphan reconciliation, stop, gate reopen), so a
   * release must drain this entire class before it acknowledges or exits.
   */
  let inFlightOperations = 0;
  /**
   * Set by a `release` request: serve is going down but this worker still has
   * work, so it has been cut loose to finish on its own instead of being killed
   * mid-run. A released worker deliberately outlives its parent.
   */
  let released = false;
  let pendingReleaseRequest: ExecuteRequest | undefined;
  let releaseAcknowledged = false;
  let releaseBackstopTimer: NodeJS.Timeout | undefined;
  /** An exit that arrived mid-work and was deferred until every request drains. */
  let pendingExitCode: number | null = null;
  /** Project roots seen on run requests. A worker only ever serves one. */
  const inFlightProjectRoots = new Set<string>();
  /** Runs this worker aborted because the user stopped them after release. */
  const stoppedWhileReleased = new Map<string, RunAbortError>();
  let releasedStopWatch: NodeJS.Timeout | undefined;
  /**
   * Longest timeout any in-flight run was given, so the release backstop below
   * can never cut a legitimately slow run short. Unknown means the daemon's own
   * ceiling for a run request, which is the most a run can be waited on anyway.
   */
  let maxRunTimeoutSeconds = 0;
  const UNKNOWN_RUN_TIMEOUT_SECONDS = 24 * 60 * 60;
  /** Grace past a run's own deadline before we call it hung and leave. */
  const RELEASE_BACKSTOP_GRACE_SECONDS = 600;
  /** Hard cap on how long a released worker may live, overriding the above. */
  const releaseBackstopOverride = Number(process.env.AGENTUSE_RELEASE_BACKSTOP_SECONDS);

  /**
   * Once released, watch storage for a stop the user asked for.
   *
   * Stopping a run is otherwise purely in-process: serve forwards it to the
   * worker holding the AbortController. A released worker is no longer the one
   * serve talks to, so its runs would take a stop that reads as successful,
   * keep executing anyway, and then overwrite the stopped status with their own
   * result -- the user watches it un-stop itself and the side effects land.
   * Polling closes that window for the one case that has it, without putting a
   * storage read in every run's step loop.
   */
  const watchForStopWhileReleased = () => {
    if (releasedStopWatch) return;
    releasedStopWatch = setInterval(() => {
      void (async () => {
        if (ctx.activeExecutionControllers.size === 0) return;
        for (const projectRoot of inFlightProjectRoots) {
          try {
            await initStorage(projectRoot);
            const sessionManager = new SessionManager();
            for (const [sessionId, controller] of ctx.activeExecutionControllers) {
              if (ctx.activeStoppedSessions.has(sessionId)) continue;
              const found = await sessionManager.findSession(sessionId);
              if (!['USER_STOPPED', 'CLIENT_DISCONNECT'].includes(found?.session.error?.code ?? '')) continue;
              ctx.activeStoppedSessions.add(sessionId);
              const reason = new RunAbortError(found?.session.error?.code === 'CLIENT_DISCONNECT' ? 'client_disconnect' : 'user_stopped', found!.session.error!.message);
              stoppedWhileReleased.set(sessionId, reason);
              controller.abort(reason);
            }
          } catch {
            // Storage hiccup -- try again on the next tick.
          }
        }
      })();
    }, 5_000);
    releasedStopWatch.unref?.();
  };

  /**
   * Restore the stopped verdict on a run we aborted after release.
   *
   * A local stop survives because the process that wrote USER_STOPPED is the
   * same one that then finishes the run, so its own terminal write stands down.
   * Ours was written by a different process, so this worker still believes the
   * session is running and stamps the abort as a TIMEOUT over the top -- the
   * user stops a run, watches it report stopped, then watches it report a
   * timeout instead. stopSessionTree will not correct it (it only touches
   * running/suspended sessions), so write the verdict back directly, strictly
   * after the run has made its last write.
   */
  const restampStopsAfterRelease = async () => {
    if (stoppedWhileReleased.size === 0) return;
    for (const projectRoot of inFlightProjectRoots) {
      try {
        await initStorage(projectRoot);
        const sessionManager = new SessionManager();
        for (const [sessionId, reason] of stoppedWhileReleased) {
          const found = await sessionManager.findSession(sessionId);
          if (!found) continue;
          const code = reason.causeCode === 'client_disconnect' ? 'CLIENT_DISCONNECT' : 'USER_STOPPED';
          if (found.session.error?.code !== code) {
            await sessionManager.updateSession(sessionId, found.agentId, {
              status: 'error',
              error: { code, cause: reason.causeCode, message: reason.message, time: Date.now() },
            } as any);
          }
          stoppedWhileReleased.delete(sessionId);
        }
      } catch {
        // Leave it recorded; the next run to settle tries again.
      }
    }
  };

  const exitWorker = (code = 0, options: { force?: boolean } = {}) => {
    if (workerExiting) return;
    // Work in flight is never abandoned voluntarily. Ctrl-C and supervisor
    // tree-kills (pm2's default, systemd's control-group default) are delivered
    // to this process directly and land here mid-request. Runs and state-changing
    // maintenance RPCs both need to reach a durable terminal write before exit.
    // `force` is reserved for the released-run backstop / dead-parent watchdog.
    if ((inFlightRuns > 0 || inFlightOperations > 0) && !options.force) {
      pendingExitCode = code;
      return;
    }
    workerExiting = true;
    if (parentWatchTimer) clearInterval(parentWatchTimer);
    if (releasedStopWatch) clearInterval(releasedStopWatch);
    if (releaseBackstopTimer) clearTimeout(releaseBackstopTimer);
    rl.close();
    process.exit(code);
  };

  /** Settle a run and take any release/exit that was deferred while it ran. */
  const runFinished = () => {
    inFlightRuns = Math.max(0, inFlightRuns - 1);
    if (released) return finishReleaseIfDrained();
    if (inFlightRuns === 0 && inFlightOperations === 0 && pendingExitCode !== null) {
      exitWorker(pendingExitCode);
    }
  };

  // A released worker outlives serve, so its stdout pipe can close underneath
  // it. Losing the reply is fine -- the run it describes is already durable in
  // storage, and serve re-reads state from there -- but an unhandled EPIPE
  // would take the process down mid-run, which is not.
  /** Diagnostics must never take the process down; both pipes can be dead. */
  const writeStderr = (line: string) => {
    try {
      process.stderr.write(line);
    } catch {
      // Released worker with no parent left to read it.
    }
  };
  process.stderr.on('error', () => {/* parent is gone; nothing to report to */});
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
    writeStderr(`[worker] stdout error: ${err?.message}\n`);
  });

  /** Write one IPC response, tolerating a parent that is no longer listening.
   *  Every reply to a request carries this worker's RSS: serve decides on each
   *  settled request whether the process has banked enough memory to be worth
   *  retiring (see recycleIfDue), and a run reply alone is too rare a
   *  heartbeat -- the memory is banked precisely when the worker goes idle.
   *  Unsolicited messages (the ready signal) are left as-is; nothing settles. */
  const reply = (response: unknown) => {
    try {
      const isRequestReply = typeof response === 'object' && response !== null && 'id' in response;
      const payload = isRequestReply
        ? { ...(response as Record<string, unknown>), workerRssBytes: process.memoryUsage.rss() }
        : response;
      process.stdout.write(stringifyJsonLine(payload));
    } catch {
      // Released worker with nowhere to report; storage already has the result.
    }
  };

  const startReleasedRunProtection = () => {
    if (inFlightRuns === 0) return;
    watchForStopWhileReleased();
    if (releaseBackstopTimer) return;
    // Runs are bounded by their own timeout. Outliving it by this margin means
    // something downstream of abort is wedged and the process would otherwise
    // stay resident forever. This timer starts only after non-run RPCs drain.
    const backstopSeconds = Number.isFinite(releaseBackstopOverride) && releaseBackstopOverride > 0
      ? releaseBackstopOverride
      : maxRunTimeoutSeconds + RELEASE_BACKSTOP_GRACE_SECONDS;
    releaseBackstopTimer = setTimeout(() => {
      writeStderr(`[worker] released run outlived its ${backstopSeconds}s deadline; exiting\n`);
      exitWorker(0, { force: true });
    }, backstopSeconds * 1000);
    releaseBackstopTimer.unref?.();
  };

  /** Acknowledge release only once every non-run RPC that preceded it is done. */
  function finishReleaseIfDrained(): void {
    if (!released || inFlightOperations > 0) return;
    if (!releaseAcknowledged) {
      releaseAcknowledged = true;
      reply({
        id: pendingReleaseRequest?.id ?? 'release',
        success: true,
        inFlightRuns,
        inFlightOperations,
      });
    }
    if (inFlightRuns === 0) {
      exitWorker(0);
      return;
    }
    startReleasedRunProtection();
  }

  const operationFinished = () => {
    inFlightOperations = Math.max(0, inFlightOperations - 1);
    if (released) {
      finishReleaseIfDrained();
      return;
    }
    if (inFlightRuns === 0 && inFlightOperations === 0 && pendingExitCode !== null) {
      exitWorker(pendingExitCode);
    }
  };

  /** Dispatch an async non-run RPC under the worker drain barrier. */
  const dispatchOperation = (request: ExecuteRequest, operation: () => Promise<unknown>) => {
    inFlightOperations += 1;
    void Promise.resolve()
      .then(operation)
      .then(
        (response) => reply(response),
        (error) => reply({
          id: request.id,
          success: false,
          error: { code: 'WORKER_ERROR', message: toErrorMessage(error) },
        })
      )
      .finally(operationFinished);
  };

  // Reap a worker whose serve died without releasing it (a crash, a SIGKILL).
  // `release` clears this timer, which is what lets a released worker outlive
  // its parent on purpose.
  let orphanTicks = 0;
  parentWatchTimer = setInterval(() => {
    const orphaned = parentPid === 1 || process.ppid !== parentPid || process.ppid === 1;
    if (!orphaned) {
      orphanTicks = 0;
      return;
    }
    orphanTicks += 1;
    // Idle: nothing to protect, and a stray worker helps nobody.
    if (inFlightRuns === 0 && inFlightOperations === 0) return exitWorker(0, { force: true });
    // State-changing maintenance work is normally short and has no safe replay
    // boundary. Let it reach its durable write even after an unclean parent
    // death; the release/reconcile paths reap the process once it drains.
    if (inFlightOperations > 0) return;
    // Mid-run, allow a few ticks first. A clean shutdown writes the release
    // line and exits, so the parent can be gone a moment before that line is
    // read -- and reaping a run we were about to be released to finish is
    // exactly the bug this whole path exists to prevent.
    if (orphanTicks >= 3) exitWorker(0, { force: true });
  }, 1_000);
  parentWatchTimer.unref?.();
  process.stdin.on('end', () => exitWorker(0));
  process.stdin.on('close', () => exitWorker(0));
  // `on`, not `once`: a released worker must keep ignoring repeat signals from a
  // supervisor that tree-kills. With `once` the second SIGTERM falls through to
  // the default action and kills the run anyway.
  process.on('SIGTERM', () => exitWorker(0));
  process.on('SIGINT', () => exitWorker(130));

  // Signal ready
  reply({ type: 'ready' });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line) as ExecuteRequest;
      if (released) {
        reply({
          id: request.id,
          success: false,
          error: { code: 'WORKER_RELEASED', message: 'Worker is draining and no longer accepts requests' },
        });
        continue;
      }
      if (request.type === 'approval-info') {
        dispatchOperation(request, () => getApprovalInfo(request));
      } else if (request.type === 'session-status') {
        dispatchOperation(request, () => getSessionStatusInfo(request));
      } else if (request.type === 'create-preparing-session') {
        dispatchOperation(request, () => createPreparingSession(request));
      } else if (request.type === 'fail-preparing-session') {
        dispatchOperation(request, () => failPreparingSession(request));
      } else if (request.type === 'session-context') {
        dispatchOperation(request, () => getSessionContext(request));
      } else if (request.type === 'sweep-expired') {
        dispatchOperation(request, () => sweepExpiredApprovals(request));
      } else if (request.type === 'reconcile-orphans') {
        dispatchOperation(request, () => reconcileOrphanSessions(request));
      } else if (request.type === 'list-approvals') {
        dispatchOperation(request, () => listAllApprovals(ctx, request));
      } else if (request.type === 'invalidate-lists') {
        // A run this worker didn't start just changed state (see the runner's
        // started/finished pokes in runner/announce.ts). Drop the cached lists
        // so the next dashboard read reflects it instead of waiting out the TTL.
        // A start poke also opens an activity window, because it races the
        // session write and the refill right after it can still see nothing.
        if (request.externalActivity) {
          externalActivityUntil.set(request.projectRoot, Date.now() + EXTERNAL_ACTIVITY_WINDOW_MS);
        }
        invalidateListCaches(request.projectRoot);
        reply({ id: request.id, success: true });
      } else if (request.type === 'reset-provider-plugins') {
        // Provider setup runs in the daemon, which can only reset its own
        // caches. Without this poke a warm worker keeps serving the plugin set
        // and readiness it loaded on first use, so a provider installed,
        // updated, removed, or re-credentialed in Settings would not reach a
        // run until the worker was recycled. Clearing only affects the next
        // getInstalledPluginHost() call, so no in-flight lookup is disturbed.
        const { resetProviderPluginCache } = await import('../plugin/provider-runtime.js');
        resetProviderPluginCache();
        reply({ id: request.id, success: true });
      } else if (request.type === 'list-sessions') {
        dispatchOperation(request, () => listSessions(ctx, request));
      } else if (request.type === 'session-final-responses') {
        dispatchOperation(request, () => getSessionFinalResponses(request));
      } else if (request.type === 'stop-session') {
        dispatchOperation(request, () => stopSession(ctx, request));
      } else if (request.type === 'mark-session-reviewed') {
        dispatchOperation(request, () => markSessionReviewed(request));
      } else if (request.type === 'reopen-gate') {
        dispatchOperation(request, () => reopenGate(request));
      } else if (request.type === 'release') {
        // Cut the parent-death tethers immediately, but do not acknowledge or
        // exit until every earlier non-run RPC has drained. The for-await loop
        // starts each operation before it can consume this line, so this is a
        // strict barrier for stop/reopen/reconcile and similar storage writes.
        released = true;
        pendingReleaseRequest = request;
        if (parentWatchTimer) {
          clearInterval(parentWatchTimer);
          parentWatchTimer = undefined;
        }
        finishReleaseIfDrained();
      } else if (request.type === 'execute' || request.type === 'resume' || request.type === 'continue-session' || request.type === 'finish-cascade' || request.type === 'retry-cascade') {
        // Don't await - handle requests concurrently
        // Each request runs in parallel, response sent when complete
        inFlightRuns += 1;
        inFlightProjectRoots.add(request.projectRoot);
        maxRunTimeoutSeconds = Math.max(maxRunTimeoutSeconds, request.timeout ?? UNKNOWN_RUN_TIMEOUT_SECONDS);
        executeAgent(ctx, request).then(async (response) => {
          // A run's peak heap is largely banked for good: a worker that has run
          // an agent settles two to three times above a fresh one and stays
          // there for the daemon's lifetime. reply() reports the RSS so serve
          // can retire this process once it is idle, rather than carrying the
          // high-water mark of every run it ever handled.
          reply(response);
          // Before runFinished, which may exit the process.
          await restampStopsAfterRelease();
          runFinished();
        }, (err) => {
          // executeAgent resolves its own errors, so this is a defect rather
          // than a run failure -- but it must still settle the count, or a
          // released worker would never reach its exit.
          reply({ id: request.id, success: false, error: { code: 'WORKER_ERROR', message: (err as Error).message } });
          runFinished();
        });
      } else {
        reply({
          id: (request as any).id || 'unknown',
          success: false,
          error: { code: 'UNKNOWN_REQUEST', message: 'Unknown request type' },
        });
      }
    } catch (err) {
      reply({
        id: 'unknown',
        success: false,
        error: { code: 'PARSE_ERROR', message: (err as Error).message },
      });
    }
  }

  exitWorker(0);
}
