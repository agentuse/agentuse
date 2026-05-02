import type { AgentConfig } from '../parser';

type ApprovalConfig = NonNullable<AgentConfig['approval']>;
type ApprovalObject = Exclude<ApprovalConfig, boolean>;

export const DEFAULT_APPROVAL_ACTIONS: Array<{ id: string; label: string; style?: 'primary' | 'danger' }> = [
  { id: 'approve', label: 'Approve', style: 'primary' },
  { id: 'reject', label: 'Reject', style: 'danger' },
  { id: 'comment', label: 'Comment' }
];

export function isApprovalEnabled(config: AgentConfig): boolean {
  return config.approval === true || (typeof config.approval === 'object' && config.approval !== null);
}

function getApprovalObject(config: AgentConfig): ApprovalObject | undefined {
  return typeof config.approval === 'object' && config.approval !== null
    ? config.approval
    : undefined;
}

function getSlackApprovalRoute(config: AgentConfig): { channel_id?: string } | undefined {
  for (const route of config.notifications?.routes ?? []) {
    if (route.enabled === false || !route.on.includes('approval')) continue;
    const destinations = route.to as Record<string, unknown>;
    const slack = destinations.slack;
    if (slack === undefined) continue;
    return slack as { channel_id?: string };
  }
  return undefined;
}

export function approvalToolDefaults(config: AgentConfig): {
  timeout?: string;
  actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
  slack?: { channelId?: string };
} | undefined {
  if (!isApprovalEnabled(config)) return undefined;

  const approval = getApprovalObject(config);
  const slack = getSlackApprovalRoute(config);

  return {
    ...(approval?.timeout && { timeout: approval.timeout }),
    actions: DEFAULT_APPROVAL_ACTIONS,
    ...(slack && {
      slack: {
        ...(slack.channel_id && { channelId: slack.channel_id })
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
    '- comment: use the reviewer comment to revise or clarify the work, then request approval again if the work still needs approval.',
    '',
    'If the `await_human` tool fails, do not finalize, publish, ship, or return the prepared work as complete. Stop and report that the approval request failed with the tool error.',
    '',
    'Do not ask the user to manually call approval or mention this hidden gate unless it fails.'
  ].join('\n');

  return `${instructions}\n\n${approvalInstructions}`;
}
