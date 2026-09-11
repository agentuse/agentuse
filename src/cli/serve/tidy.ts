/**
 * In-flight learning tidy-up jobs, tracked per agent file.
 *
 * One consolidation may run per agent at a time; finished jobs linger briefly
 * so a poll can still read the outcome. Moved verbatim out of serve.ts.
 */
import type { ConsolidationResult, TidyProgress } from "../../learning";

/**
 * A tidy-up in flight, or one this process finished recently.
 *
 * The pass is minutes of model work on a large corrections file, far too long to
 * hold a request open for: the browser or a proxy times out and the user is left
 * with two rewritten files and no idea what happened. So the request starts a
 * job and returns its id, and the page polls this registry.
 */
export interface TidyJob {
  id: string;
  project: string;
  path: string;
  agentFilePath: string;
  stateRoot: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error' | 'undone';
  phase: TidyProgress['phase'];
  step: number;
  total: number;
  round: number;
  maxRounds: number;
  projectedActive: number;
  cap: number;
  dryRun: boolean;
  result?: ConsolidationResult;
  error?: string;
}

export const tidyJobs = new Map<string, TidyJob>();

/** How long a finished job stays queryable in memory. Beyond this the page
 *  falls back to the record on disk, which is what survives a daemon restart. */
export const TIDY_JOB_RETENTION_MS = 6 * 60 * 60 * 1000;

export function pruneTidyJobs(now = Date.now()): void {
  for (const [id, job] of tidyJobs) {
    if (job.finishedAt && now - job.finishedAt > TIDY_JOB_RETENTION_MS) tidyJobs.delete(id);
  }
}

/** The running job for this agent, if any. A second Tidy up press joins the
 *  first rather than starting a competing pass over the same two files. */
export function runningTidyJob(project: string, path: string): TidyJob | undefined {
  for (const job of tidyJobs.values()) {
    if (job.status === 'running' && job.project === project && job.path === path) return job;
  }
  return undefined;
}

/** Same question asked by agent file, for the list payload — which knows the
 *  file it is describing but not which project id was used to reach it. */
export function runningTidyJobForFile(agentFilePath: string): TidyJob | undefined {
  for (const job of tidyJobs.values()) {
    if (job.status === 'running' && job.agentFilePath === agentFilePath) return job;
  }
  return undefined;
}

export function tidyJobView(job: TidyJob) {
  return {
    id: job.id,
    project: job.project,
    path: job.path,
    status: job.status,
    phase: job.phase,
    step: job.step,
    total: job.total,
    round: job.round,
    maxRounds: job.maxRounds,
    projectedActive: job.projectedActive,
    cap: job.cap,
    dryRun: job.dryRun,
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}
