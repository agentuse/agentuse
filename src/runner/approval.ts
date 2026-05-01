import type { AgentConfig } from '../parser';

type ApprovalConfig = NonNullable<AgentConfig['approval']>;
type ApprovalObject = Exclude<ApprovalConfig, boolean>;

function normalizeActions(actions: ApprovalObject['actions']): Array<{ id: string; label: string; style?: 'primary' | 'danger' }> {
  const defaults: Array<{ id: string; label: string; style?: 'primary' | 'danger' }> = [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
    { id: 'comment', label: 'Comment' }
  ];

  if (!actions || actions.length === 0) return defaults;

  return actions.map(action => {
    if (typeof action === 'string') {
      return {
        id: action,
        label: action.charAt(0).toUpperCase() + action.slice(1),
        ...(action === 'approve' && { style: 'primary' as const }),
        ...(action === 'reject' && { style: 'danger' as const })
      };
    }
    return {
      id: action.id,
      label: action.label,
      ...(action.style && { style: action.style })
    };
  });
}

export function isApprovalEnabled(config: AgentConfig): boolean {
  return config.approval === true || (typeof config.approval === 'object' && config.approval !== null);
}

function getApprovalObject(config: AgentConfig): ApprovalObject | undefined {
  return typeof config.approval === 'object' && config.approval !== null
    ? config.approval
    : undefined;
}

export function approvalToolDefaults(config: AgentConfig): {
  channel?: 'slack' | 'webhook';
  url?: string;
  channelId?: string;
  timeout?: string;
  actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
} | undefined {
  if (!isApprovalEnabled(config)) return undefined;

  if (config.approval === true) {
    return {
      channel: 'slack',
      actions: normalizeActions(undefined)
    };
  }

  const approval = getApprovalObject(config);
  if (!approval) return undefined;

  const channel = approval.channel ?? (approval.url ? 'webhook' : 'slack');
  return {
    channel,
    ...(approval.url && { url: approval.url }),
    ...(approval.channel_id && { channelId: approval.channel_id }),
    ...(approval.timeout && { timeout: approval.timeout }),
    actions: normalizeActions(approval.actions)
  };
}

export function appendApprovalInstructions(instructions: string, config: AgentConfig): string {
  if (!isApprovalEnabled(config)) return instructions;

  const approval = getApprovalObject(config) ?? {};
  const actions = normalizeActions(approval.actions);
  const actionList = actions.map(action => action.id).join(', ');
  const include = approval.include?.join(', ') ?? 'draft, summary';
  const onComment = approval.on_comment ?? 'revise_until_approved';
  const timeout = approval.timeout ?? '7d';

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
    `- include: ${include}`,
    `- actions: ${actionList}`,
    `- timeout: ${timeout}`,
    '',
    'After the approval result:',
    '- approve: finalize the work and complete normally.',
    '- reject: stop cleanly and summarize the rejection.',
    onComment === 'revise_once'
      ? '- comment: revise once from the reviewer comment, then request approval one more time.'
      : onComment === 'return_comment'
        ? '- comment: return the reviewer comment without revising.'
        : '- comment: revise from the reviewer comment and request approval again until approved or rejected.',
    '',
    'If the `await_human` tool fails, do not finalize, publish, ship, or return the prepared work as complete. Stop and report that the approval request failed with the tool error.',
    '',
    'Do not ask the user to manually call approval or mention this hidden gate unless it fails.'
  ].join('\n');

  return `${instructions}\n\n${approvalInstructions}`;
}
