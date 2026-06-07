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
    'Fill the fields so a reviewer can decide without asking you follow-up questions. Put the substance in the body fields, NOT in `prompt`:',
    '- prompt: ONE short line, a direct yes/no question (e.g. "Approve this newsletter draft for send?"). Do not put the content, headings, or bullet lists here.',
    '- draft: the full reviewable work itself, written in Markdown. Use headings, bullet lists, tables, and fenced code blocks. This is the primary artifact the reviewer reads, so make it complete, not a one-line summary. Include the actual text/copy/code/plan being approved.',
    '- artifact_path: when the reviewable work is a file you created (an HTML page, a long report, a rendered document), pass its path relative to the project root (e.g. `.agentuse/artifacts/report.html`). The reviewer can open it in a popup viewer. Prefer this over inlining very long or HTML content into `draft`. For more than one file, use artifact_paths (an array of project-relative paths) instead.',
    '- artifact_url: external link to review instead (PR, hosted preview, Google Doc). Use draft_url for a non-primary draft link.',
    '- summary: a few sentences on what changed and what is being approved (renders under "Why this request").',
    '- context: real background, constraints, inputs used, and work completed so far. Give specifics, not a placeholder.',
    '- risk: concrete risks, unresolved questions, or areas needing reviewer attention. Omit only if there genuinely are none.',
    '',
    'Be thorough, not terse: a reviewer seeing only a one-line prompt with empty body fields cannot make a good decision. Markdown in draft/summary/context/risk is rendered, so format for readability.',
    '',
    'Worked example of a good call:',
    '```',
    'await_human({',
    '  prompt: "Approve this launch email for send to the 4,200-subscriber list?",',
    '  draft: "## Subject: Your Q3 roadmap is here\\n\\nHi {{first_name}},\\n\\n- New: bulk export\\n- Faster sync (2x)\\n- Fixed: timezone bug\\n\\n**CTA:** [See what\'s new](https://example.com/changelog)",',
    '  summary: "Final copy for the Q3 product-update broadcast. Subject line A/B winner from last week applied. Links verified.",',
    '  context: "List: all active subscribers (4,200). Send window: Tue 9am ET. Built from the changelog at .agentuse/artifacts/changelog.md.",',
    '  risk: "Irreversible once sent. The {{first_name}} merge tag is empty for ~120 imported contacts."',
    '})',
    '```',
    '',
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
