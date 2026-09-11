/**
 * Budgets for the internal revision and change-set sessions, and the tags that
 * mark a proposal or a change request in a session log. Moved out of serve.ts.
 */


/** Tag helpers for the reviser's follow-up prompt, kept out of the route body
 *  so the literal tag text is written once. */
export function revisionProposalTag(source: string): string {
  return `<standing_proposal>\n${source}\n</standing_proposal>`;
}

export function revisionRequestTag(request: string): string {
  return `<operator_request>\n${request}\n</operator_request>`;
}

/** Authoring budgets for a change set session. The creator writes several
 *  files and loads skills; the reviser diagnoses first, so it gets more. Both
 *  match the frontmatter the session-agent builders render. */
export const CHANGESET_CREATE_TIMEOUT_SECONDS = 480;

export const CHANGESET_CREATE_MAX_STEPS = 24;

export const CHANGESET_REVISE_TIMEOUT_SECONDS = 600;

export const CHANGESET_REVISE_MAX_STEPS = 32;
