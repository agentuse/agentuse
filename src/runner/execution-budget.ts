import { runDeadline, RunAbortError } from './failure';
import { logger } from '../utils/logger';
import type { SessionManager } from '../session';
import type { SessionInfo } from '../session/types';

export interface ExecutionBudgetState {
  configuredMs: number;
  elapsedMs: number;
  effectiveMs: number;
  limitingSessionId?: string;
  noticeDeliveredAt?: number;
  wrappedUpAt?: number;
  modelLatencyMs?: number;
}

export const BUDGET_WRAP_UP_NOTICE = 'Execution budget nearly used. Stop starting new work, finish the current useful operation, and return what you have established through the normal response path. Clearly identify unfinished or uncertain work. All verification, approval, and publication safety checks still apply. If required work is unfinished, report incomplete; never declare success merely to meet the deadline.';

const budgets = new WeakMap<AbortSignal, ExecutionBudget>();
export const executionBudgetFor = (signal?: AbortSignal): ExecutionBudget | undefined => signal ? budgets.get(signal) : undefined;

/** Active execution only: dispose at suspension, restore elapsed time on resume. */
export class ExecutionBudget {
  private started = Date.now();
  private priorElapsed = 0;
  private modelLatencyMs = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private deliveredAt: number | undefined;
  private wrappedUpAt: number | undefined;
  private parent: ExecutionBudget | undefined;
  private parentSignal: AbortSignal | undefined;
  private removeParentListener?: () => void;
  private persist?: (state: ExecutionBudgetState) => Promise<void>;
  private restoredAncestors: ExecutionBudget[] = [];
  private sessionId?: string;
  private effectiveMs: number;
  private limitingSessionId: string | undefined;
  readonly controller: AbortController;
  constructor(private configuredMs: number, options: { controller?: AbortController; parentSignal?: AbortSignal } = {}) {
    this.controller = options.controller ?? new AbortController();
    this.effectiveMs = configuredMs;
    budgets.set(this.signal, this);
    this.setParent(options.parentSignal);
    this.arm();
  }
  get signal(): AbortSignal { return this.controller.signal; }
  get elapsedMs(): number { return this.priorElapsed + (this.stopped ? 0 : Date.now() - this.started); }
  get parentAborted(): boolean { return this.parentSignal?.aborted ?? false; }
  /**
   * True when the abort came from a deadline -- this budget's own or a restored
   * ancestor's -- rather than an operator stop. bind() folds ancestor signals
   * into parentSignal, so parentAborted alone cannot tell the two apart.
   */
  get abortedByDeadline(): boolean {
    const reason = this.signal.aborted ? this.signal.reason : undefined;
    return reason instanceof RunAbortError && reason.causeCode === 'run_deadline';
  }
  get remainingMs(): number { return Math.max(0, Math.min(this.configuredMs - this.elapsedMs, this.parent?.remainingMs ?? Infinity)); }
  private setParent(signal?: AbortSignal) {
    this.removeParentListener?.();
    this.parentSignal = signal;
    this.parent = executionBudgetFor(signal);
    if (!signal) return;
    const abort = () => this.controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.removeParentListener = () => signal.removeEventListener('abort', abort);
  }
  private arm() {
    clearTimeout(this.timer);
    const ownRemaining = this.configuredMs - this.elapsedMs;
    const parentRemaining = this.parent?.remainingMs ?? Infinity;
    this.effectiveMs = this.elapsedMs + Math.max(0, Math.min(ownRemaining, parentRemaining));
    // A tie means the parent is the real limit: a child that inherited the
    // parent's remaining budget tracks it exactly, so `<` would credit the
    // child for a deadline it did not set.
    this.limitingSessionId = parentRemaining <= ownRemaining
      ? this.parent?.snapshot().limitingSessionId
      : this.sessionId;
    const remaining = Math.max(0, ownRemaining);
    if (remaining === 0) this.controller.abort(runDeadline(this.configuredMs / 1000));
    else {
      this.timer = setTimeout(() => this.controller.abort(runDeadline(this.configuredMs / 1000)), remaining);
      this.timer.unref?.();
    }
  }
  observeModelDuration(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.modelLatencyMs = Math.max(this.modelLatencyMs, ms);
  }
  snapshot(): ExecutionBudgetState {
    return {
      ...(this.modelLatencyMs > 0 && { modelLatencyMs: this.modelLatencyMs }),
      configuredMs: this.configuredMs, elapsedMs: this.elapsedMs, effectiveMs: this.effectiveMs,
      ...(this.limitingSessionId && { limitingSessionId: this.limitingSessionId }),
      ...(this.deliveredAt !== undefined && { noticeDeliveredAt: this.deliveredAt }),
      ...(this.wrappedUpAt !== undefined && { wrappedUpAt: this.wrappedUpAt }),
    };
  }
  private restore(state: ExecutionBudgetState) {
    // configuredMs is deliberately NOT restored: the caller built this budget
    // from the live `--timeout` flag / agent config, and the docs promise the
    // flag wins. bind()'s ancestor loop passes state.configuredMs into the
    // constructor, so a restored ancestor still gets its own recorded budget.
    this.priorElapsed = state.elapsedMs;
    this.modelLatencyMs = state.modelLatencyMs ?? 0;
    this.deliveredAt = state.noticeDeliveredAt;
    // Without this a restored ancestor snapshot would persist wrappedUpAt:
    // undefined back over a parent that had already wrapped up cleanly.
    this.wrappedUpAt = state.wrappedUpAt;
    // A continuation gets a new budget; an approval resume retains the notice.
    this.started = Date.now();
    this.arm();
  }
  async bind(manager: SessionManager, sessionId: string, agentId: string, resume = false): Promise<void> {
    this.sessionId = sessionId;
    this.persist = state => manager.updateSession(sessionId, agentId, { executionBudget: state });
    if (resume) {
      const found = await manager.findSession(sessionId);
      if (found?.session.executionBudget) this.restore(found.session.executionBudget);
      // A durable child resumes without its in-memory parents. Restore their
      // clocks while the child executes, excluding the human suspension gap.
      if (!this.parent && found?.session.parentSessionID) {
        const ancestors: Array<{ session: SessionInfo; agentId: string }> = [];
        const seen = new Set([sessionId]);
        let id: string | undefined = found.session.parentSessionID;
        while (id && !seen.has(id)) {
          seen.add(id);
          const ancestor = await manager.findSession(id);
          if (!ancestor) break;
          ancestors.push(ancestor);
          id = ancestor.session.parentSessionID;
        }
        let parentSignal: AbortSignal | undefined;
        for (const ancestor of ancestors.reverse()) {
          const state = ancestor.session.executionBudget;
          if (!state) continue; // Historical sessions have no active-budget ledger.
          const budget = new ExecutionBudget(state.configuredMs, { ...(parentSignal && { parentSignal }) });
          budget.sessionId = ancestor.session.id;
          budget.restore(state);
          budget.persist = snapshot => manager.updateSession(ancestor.session.id, ancestor.agentId, { executionBudget: snapshot });
          this.restoredAncestors.push(budget);
          parentSignal = budget.signal;
        }
        if (parentSignal) {
          const combined = this.parentSignal ? AbortSignal.any([this.parentSignal, parentSignal]) : parentSignal;
          const ancestorBudget = executionBudgetFor(parentSignal);
          if (ancestorBudget) budgets.set(combined, ancestorBudget);
          this.setParent(combined);
        }
      }
    }
    this.arm();
    await this.persist(this.snapshot());
  }
  /** Called only at a safe model boundary; never interrupts a tool or opens a gate. */
  get notice(): string | undefined { return this.deliveredAt !== undefined ? BUDGET_WRAP_UP_NOTICE : undefined; }
  async takeNotice(): Promise<string | undefined> {
    // Reserve one ordinary model turn plus a final response at the slowest
    // observed latency. The original 80% boundary remains the no-sample fallback.
    const reserve = Math.max(this.effectiveMs * 0.2, this.modelLatencyMs * 2);
    if (this.stopped || this.signal.aborted || this.deliveredAt !== undefined || this.remainingMs > reserve) return undefined;
    this.deliveredAt = Date.now();
    await this.persist?.(this.snapshot());
    return BUDGET_WRAP_UP_NOTICE;
  }
  async finish(returnedResponse = false): Promise<void> {
    if (this.stopped) return;
    this.priorElapsed = this.elapsedMs;
    this.stopped = true;
    clearTimeout(this.timer);
    this.removeParentListener?.();
    if (returnedResponse && !this.signal.aborted && this.deliveredAt !== undefined) this.wrappedUpAt = Date.now();
    const writes = await Promise.allSettled([
      this.persist?.(this.snapshot()),
      ...this.restoredAncestors.reverse().map(ancestor => ancestor.finish()),
    ]);
    for (const result of writes) {
      if (result.status === 'rejected') logger.warn(`Could not persist execution budget: ${String(result.reason)}`);
    }
  }
}
