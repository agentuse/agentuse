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

  // Lease enforcement note (agentuse-lab#165, Phase 2): when the agent declares
  // effectful command patterns, the runtime mechanically matches each matching
  // command against the latest APPROVED changes[] before it may execute. The
  // model must therefore put the exact final content/command in changes[] and
  // must never run an effectful command before its gate is approved.
  const effectPatterns = config.effects ?? [];
  const effectsNote = effectPatterns.length > 0
    ? [
        '',
        '## Effectful commands are lease-enforced',
        '',
        `These bash command patterns are EFFECTFUL and mechanically blocked until covered by an approved plan: ${effectPatterns.map(p => `\`${p}\``).join(', ')}.`,
        '',
        '- Before running any matching command, call `await_human` and put the exact final content (or the exact command) in `changes[].content`, verbatim. On approve, the runtime derives the grant from those entries; a matching command runs only when it equals or contains an approved entry.',
        '- Never emit a matching command before the gate returns approve: it is auto-denied, never executed.',
        '- If a matching command is denied, do NOT retry or reword it. Revise the plan, re-gate via `await_human` with the exact new content in `changes[]`, and run it only after approval.',
        '- If you revise approved content (e.g. trim for a length limit), the old approval no longer covers it: re-gate with the revised version.',
      ].join('\n')
    : '';

  const approvalInstructions = [
    '## Approval Gate',
    '',
    'Approval is enabled in frontmatter. Before you take an irreversible publish/ship/finalize action, or before delivering prepared work as your final answer, call the `await_human` tool. If your instructions define their own approval boundary, follow it.',
    '',
    'Fill the fields so a reviewer can decide without asking you follow-up questions. Put the substance in the body fields, NOT in `prompt`:',
    '- prompt: ONE short line, a direct yes/no question (e.g. "Approve this newsletter draft for send?"). Do not put the content, headings, or bullet lists here.',
    '- changes: the exact actions taken on approval, one entry per discrete action, in order, each `{ label, content }` with the verbatim final content (the comment text to post, the email body to send, the edit to apply). The reviewer skims these highlighted boxes first, so put ONLY final content here, never rationale.',
    '- reference: when the action responds to something (commenting on a post, replying to a message, amending a document), pass the original as `{ label, author, title, url, excerpt }` so the reviewer sees the quoted original directly above your changes.',
    '- draft: the full reviewable work itself, written in Markdown. Use headings, bullet lists, tables, and fenced code blocks. For long-form deliverables this is the primary artifact the reviewer reads, so make it complete, not a one-line summary. When you use changes for the verbatim content, use draft only for supporting detail; do not duplicate the change content inside it.',
    '- artifact_path: when the reviewable work is a file you created (an HTML page, a long report, a rendered document), pass its path relative to the project root (e.g. `.agentuse/artifacts/report.html`). The reviewer can open it in a popup viewer. Prefer this over inlining very long or HTML content into `draft`. For more than one file, use artifact_paths (an array of project-relative paths) instead.',
    '- artifact_url: external link to review instead (PR, hosted preview, Google Doc). Use draft_url for a non-primary draft link.',
    '- options: when the decision is a PICK among alternatives (candidates, variants, strategies) rather than a plain yes/no, list them as `{ id, label, description?, recommended? }`. The reviewer gets a single-select menu with the recommended one preselected, and the tool result carries the picked id as `choice`; never ask the reviewer to type a number or name into a comment. Mark exactly one option `recommended: true`. Keep the full per-option detail in draft; description is the one-line skim. Do not add "reject all" or "other" options, because Reject and Comment are always available.',
    '- summary: a few sentences on what changed and what is being approved (renders under "Why this request").',
    '- context: only background the other fields do not already carry (constraints, inputs used, process notes). Never restate the reference target/URL, the change content, or the summary. Omit context entirely when nothing extra remains.',
    '- risk: concrete risks, unresolved questions, or areas needing reviewer attention. Omit only if there genuinely are none.',
    '',
    'Be thorough, not terse: a reviewer seeing only a one-line prompt with empty body fields cannot make a good decision. Markdown in draft/summary/context/risk is rendered, so format for readability.',
    '',
    'Worked example of a good call:',
    '```',
    'await_human({',
    '  prompt: "Approve this launch email for send to the 4,200-subscriber list?",',
    '  changes: [',
    '    { label: "Email body (subject: Your Q3 roadmap is here)", content: "Hi {{first_name}},\\n\\n- New: bulk export\\n- Faster sync (2x)\\n- Fixed: timezone bug\\n\\n**CTA:** [See what\'s new](https://example.com/changelog)" },',
    '    { label: "Then: schedule send", content: "Queue the broadcast for Tue 9am ET via the newsletter tool." }',
    '  ],',
    '  summary: "Final copy for the Q3 product-update broadcast. Subject line A/B winner from last week applied. Links verified.",',
    '  context: "List: all active subscribers (4,200). Send window: Tue 9am ET. Built from the changelog at .agentuse/artifacts/changelog.md.",',
    '  risk: "Irreversible once sent. The {{first_name}} merge tag is empty for ~120 imported contacts."',
    '})',
    '```',
    '',
    timeoutNote,
    '',
    'After the approval result:',
    '- approve: finalize the work and complete normally. If you supplied options, the result\'s `choice` field holds the picked option id: proceed with exactly that option; never infer the pick from the comment when `choice` is present.',
    '- reject: do not finalize, publish, ship, or perform the approved action. First perform any workflow-specific cleanup/status updates required by your instructions (for example, updating relevant store items), then stop cleanly and summarize the rejection.',
    '- comment: treat the reviewer comment as feedback, not approval. Revise or clarify the work, then call `await_human` again with the updated review request. Only stop instead of requesting approval again when the reviewer explicitly asks you to cancel, abandon, or stop the work.',
    '',
    'If the `await_human` tool fails, do not finalize, publish, ship, or return the prepared work as complete. Stop and report that the approval request failed with the tool error.',
    '',
    'Do not ask the user to manually call approval or mention this hidden gate unless it fails.'
  ].join('\n');

  return `${instructions}\n\n${approvalInstructions}${effectsNote}`;
}
