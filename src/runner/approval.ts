import type { AgentConfig } from '../parser';

type ApprovalConfig = NonNullable<AgentConfig['approval']>;
type ApprovalObject = Exclude<ApprovalConfig, boolean>;

export function isApprovalEnabled(config: AgentConfig): boolean {
  return config.approval === true || (typeof config.approval === 'object' && config.approval !== null);
}

function getApprovalObject(config: AgentConfig): ApprovalObject | undefined {
  return typeof config.approval === 'object' && config.approval !== null
    ? config.approval
    : undefined;
}

function getSlackApprovalChannel(config: AgentConfig): { channelId?: string } | undefined {
  const slack = config.channels?.slack;
  if (!slack || slack.enabled === false || !slack.events.includes('approval')) return undefined;
  const channelId = 'channelId' in slack ? slack.channelId : undefined;
  return {
    ...(channelId && { channelId })
  };
}

export function approvalToolDefaults(config: AgentConfig): {
  timeout?: string;
  slack?: { channelId?: string };
} | undefined {
  if (!isApprovalEnabled(config)) return undefined;

  const approval = getApprovalObject(config);
  const slack = getSlackApprovalChannel(config);

  return {
    ...(approval?.timeout && { timeout: approval.timeout }),
    ...(slack && {
      slack: {
        ...(slack.channelId && { channelId: slack.channelId })
      }
    })
  };
}

export function appendApprovalInstructions(instructions: string, config: AgentConfig): string {
  if (!isApprovalEnabled(config)) return instructions;

  const approval = getApprovalObject(config) ?? {};
  const timeoutNote = approval.timeout
    ? `This approval request expires after ${approval.timeout}.`
    : 'This approval request does not expire unless a timeout is configured in YAML.';

  const approvalInstructions = [
    '## Approval Gate',
    '',
    'Approval is enabled in frontmatter. Before you produce the final answer or take an irreversible publish/ship/finalize action, call the `await_human` tool.',
    '',
    'Use this approval request:',
    `- prompt: concise reviewer-facing approval request for the work you just prepared`,
    '- summary: short description of what changed and what is being approved',
    '- draft or artifact_url: the reviewable work itself, a preview link, PR, document, file, or artifact URL when available',
    '- context: relevant background, constraints, or work completed so far',
    '- risk: known risks, unresolved questions, or reviewer attention areas when relevant',
    timeoutNote,
    '',
    'After the approval result:',
    '- approve: finalize the work and complete normally.',
    '- reject: stop cleanly and summarize the rejection.',
    '- comment: treat the reviewer comment as feedback, not approval. Revise or clarify the work, then call `await_human` again with the updated review request. Only stop instead of requesting approval again when the reviewer explicitly asks you to cancel, abandon, or stop the work.',
    '',
    'If the `await_human` tool fails, do not finalize, publish, ship, or return the prepared work as complete. Stop and report that the approval request failed with the tool error.',
    '',
    'Do not ask the user to manually call approval or mention this hidden gate unless it fails.'
  ].join('\n');

  return `${instructions}\n\n${approvalInstructions}`;
}
