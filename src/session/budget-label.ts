import type { ExecutionBudgetState } from '../runner/execution-budget';

/** Outcome stays authoritative. A notice is not proof of graceful completion. */
export function budgetLabel(status: string, errorCode: string | undefined, budget?: ExecutionBudgetState): string | undefined {
  if (budget?.noticeDeliveredAt === undefined) return undefined;
  if (status === 'running') return 'Wrapping up · execution budget nearly used';
  if (budget.wrappedUpAt !== undefined && status === 'error' && errorCode === 'INCOMPLETE') return 'Wrapped up before timeout';
  return 'Budget wrap-up notice received';
}
