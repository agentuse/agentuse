/** Observed supervisor evidence, never an inference that a run may be replayed. */
export interface WorkerDeath {
  pid?: number;
  procStartedAt?: string;
  event: 'exit' | 'error';
  exitCode?: number | null;
  signal?: string | null;
  errorMessage?: string;
  observedAt: number;
}

export function workerDeathDetail(evidence: WorkerDeath): string {
  return JSON.stringify({ ...evidence,
    ...(evidence.errorMessage !== undefined && { errorMessage: evidence.errorMessage.slice(0, 1000) }),
  });
}

export function matchingWorkerDeath(owner: { pid: number; procStartedAt?: string } | undefined, updatedAt: number,
  evidence?: WorkerDeath): string | undefined {
  return owner && evidence?.pid === owner.pid && evidence.observedAt >= updatedAt
    && (!owner.procStartedAt || evidence.procStartedAt === owner.procStartedAt)
    ? workerDeathDetail(evidence) : undefined;
}
