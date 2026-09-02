export interface InternalJobLifecycleState<TError> {
  status: 'running' | 'completed' | 'error';
  phase: 'preparing' | 'running';
  error?: TError;
}

export interface InternalJobLifecycleOptions<TPrepared, TExecution, TError> {
  job: InternalJobLifecycleState<TError>;
  prepare(): Promise<TPrepared>;
  execute(prepared: TPrepared): Promise<TExecution>;
  consume(execution: TExecution, prepared: TPrepared): Promise<void>;
  mapError(error: unknown, phase: 'preparing' | 'running'): TError;
  persist(): Promise<void>;
  wake(): void;
  failPreparing?(error: TError): Promise<void>;
  onError?(error: TError): Promise<void>;
  cleanup?(): Promise<void>;
  onPersistenceError?(error: unknown): void;
}

/**
 * Shared lifecycle for model-backed internal jobs.
 *
 * Product-specific preparation, execution, and result projection stay in the
 * operation adapter. Phase promotion, failure projection, durable finalization,
 * cleanup, and observer wakeups happen exactly once here.
 */
export async function runInternalJobLifecycle<TPrepared, TExecution, TError>(
  options: InternalJobLifecycleOptions<TPrepared, TExecution, TError>,
): Promise<void> {
  const { job } = options;
  let failurePhase: 'preparing' | 'running' = 'preparing';
  try {
    const prepared = await options.prepare();
    job.phase = 'running';
    await options.persist();
    options.wake();
    failurePhase = 'running';
    const execution = await options.execute(prepared);
    await options.consume(execution, prepared);
  } catch (error) {
    const failure = options.mapError(error, failurePhase);
    job.status = 'error';
    job.error = failure;
    if (failurePhase === 'preparing') await options.failPreparing?.(failure).catch(() => undefined);
    await options.onError?.(failure).catch(() => undefined);
  } finally {
    try {
      await options.persist();
    } catch (error) {
      try { options.onPersistenceError?.(error); } catch { /* finalization remains best-effort */ }
    }
    try {
      await options.cleanup?.();
    } catch {
      // Cleanup must not prevent observers from receiving the terminal wakeup.
    } finally {
      options.wake();
    }
  }
}
