/**
 * Revision status rules shared by the daemon and the review page. Kept free of
 * Node imports so the browser bundle can use the same rule as the routes.
 */
export type AgentRevisionStatus =
  | 'running'
  | 'proposed'
  | 'no-change'
  | 'accepted'
  | 'applying'
  | 'applied'
  | 'discarded'
  | 'restoring'
  | 'restored'
  | 'error';

/** Statuses whose reviser session the operator can still reply to. A reply
 *  continues that same session, so everything the session was built on (its
 *  project view included) must outlive these statuses. */
export function revisionAcceptsFollowUp(status: AgentRevisionStatus): boolean {
  return status === 'proposed' || status === 'no-change' || status === 'accepted';
}

/** The reviser's project view can go once no turn is running and none can follow. */
export function revisionViewReleasable(status: AgentRevisionStatus): boolean {
  return status !== 'running' && !revisionAcceptsFollowUp(status);
}
