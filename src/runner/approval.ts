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
  timeout?: string | number;
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
  // model may emit a plain gate and its gated command together so the runtime
  // can bind the exact command without relying on hand-copied shell text. Pick
  // gates remain explicit because each command must be scoped to one option.
  const effectPatterns = config.tools?.bash?.gated ?? [];
  const effectsNote = effectPatterns.length > 0
    ? [
        '',
        '## Gated commands are lease-enforced',
        '',
        `These bash command patterns are GATED and mechanically blocked until covered by an approved plan: ${effectPatterns.map((p: string) => `\`${p}\``).join(', ')}.`,
        '',
        '- For a plain yes/no gate, emit `await_human` and the exact matching bash command in the SAME step. The runtime attaches the command to the approval request and blocks it from executing. After approve, re-issue that exact command once in a later step; do not open a second gate.',
        '- For a pick gate, put one exact complete command in changes[] per option and set each entry\'s `optionId` to its options[].id. Do not emit any candidate command until the reviewer returns a choice.',
        '- An approved lease entry is one-shot and is consumed before dispatch. To authorize the same command twice, list it twice. A failed command still burns its entry; ask again before retrying an ambiguous external effect.',
        '- If a matching command is denied as not covered, do NOT retry or reword it. Revise the plan and request approval for the exact new command. If it is denied as already used, request a new approval only when another execution is genuinely intended.',
        '- If you revise the command or its payload (e.g. trim for a length limit), the old approval no longer covers it: re-gate with the complete revised command.',
      ].join('\n')
    : '';

  const approvalInstructions = [
    '## Approval Gate',
    '',
    'Approval is enabled in frontmatter. Before you take an irreversible publish/ship/finalize action, or before delivering prepared work as your final answer, call the `await_human` tool. If your instructions define their own approval boundary, follow it.',
    '',
    'Call `await_human` as the only tool in its step EXCEPT for one supported case: when a plain gate authorizes a tools.bash.gated command, emit that exact command alongside the gate so the runtime can attach it. The command is blocked and must be re-issued only after approval. All non-gated sibling tools remain forbidden alongside a gate.',
    '',
    'Fill the fields so a reviewer can decide without asking you follow-up questions. Put the substance in the body fields, NOT in `prompt`:',
    '- prompt: ONE short line, a direct yes/no question (e.g. "Approve this newsletter draft for send?"). Do not put the content, headings, or bullet lists here.',
    '- changes: the exact actions taken on approval, one entry per discrete action, in order, each `{ label, content, displayContent?, optionId? }`. `content` is the verbatim final action used for authorization. When it must be an executable command carrying a payload, `displayContent` is REQUIRED: set it to the exact human-facing business content without the CLI wrapper (for example, the reply or email body); the UI shows that first and keeps the command visible but secondary. On pick gates, optionId binds an action to one options[].id; omit it only for unconditional actions. Put only final content here, never rationale.',
    '- reference: when the action responds to something (commenting on a post, replying to a message, amending a document), pass the original as `{ label, author, title, url, excerpt }` so the reviewer sees the quoted original directly above your changes.',
    '- draft: the full reviewable work itself, written in Markdown. Use headings, bullet lists, tables, and fenced code blocks. For long-form deliverables this is the primary artifact the reviewer reads, so make it complete, not a one-line summary. When you use changes for the verbatim content, use draft only for supporting detail; do not duplicate the change content inside it.',
    '- artifact_path: when the reviewable work is a file you created (an HTML page, a long report, a rendered document), pass its path relative to the project root (e.g. `.agentuse/artifacts/report.html`). The reviewer can open it in a popup viewer. Prefer this over inlining very long or HTML content into `draft`. For more than one file, use artifact_paths (an array of project-relative paths) instead.',
    '- artifact_url: external link to review instead (PR, hosted preview, Google Doc). Use draft_url for a non-primary draft link.',
    '- options: when the decision is a PICK among alternatives (candidates, variants, strategies) rather than a plain yes/no, list them as `{ id, label, description?, recommended? }`. The reviewer gets a single-select menu with the recommended one preselected, and the tool result carries the picked id as `choice`; never ask the reviewer to type a number or name into a comment. Mark exactly one option `recommended: true`. Keep the full per-option detail in draft; description is the one-line skim. Do not add "reject all" or "other" options, because Reject and Comment are always available.',
    '- summary: ONE sentence on what is being decided, or on a pick gate what separates the alternatives (renders under "Why this request"). Never restate the candidate content, the reference, or the actions available to the reviewer: the card already shows all three, and repeating them is pure reading cost. Do not open by praising the reviewer\'s earlier feedback. Omit it when the options and their descriptions already make the choice clear.',
    '- repeat approvals: after the first `await_human` in a run, every later gate must explain in `summary` what changed or why the previous approval no longer covers the action. If it still covers the action, do not ask again.',
    '- context: only background the other fields do not already carry (constraints, inputs used, process notes). Never restate the reference target/URL, the change content, or the summary. Omit context entirely when nothing extra remains.',
    '- risk: ONE line, and only when approving causes something genuinely hard to undo (a public post, a payment, an email, a deletion). Name the real-world consequence, never AgentUse\'s internal gate/lease/approval machinery: you cannot observe it, and describing it tells the reviewer something false. Do not restate UI state such as which option is preselected. Omit it when the action is reversible.',
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
    '- machine feedback: if `source` is `pre-review` or `gate-preflight`, this was NOT a human rejection. Apply its comment, revise the request, and call await_human again.',
    '- approve: finalize the work and complete normally. If you supplied options, the result\'s `choice` field holds the picked option id: proceed with exactly that option; never infer the pick from the comment when `choice` is present.',
    '- reject: do not finalize, publish, ship, or perform the approved action. First perform any workflow-specific cleanup/status updates required by your instructions (for example, updating relevant store items), then stop cleanly and summarize the rejection.',
    '- comment: this branch takes precedence over option-selection ambiguity. Treat the reviewer comment as feedback, not approval. On a pick gate, a missing `choice` is NOT ambiguous when the comment itself gives an actionable edit or replacement; for example, `reply "very nice!"` means replace the proposed reply with the exact text `very nice!`, even if it names no option. Apply the requested revision without substituting your own quality preference, then call `await_human` again with the updated review request. Only stop instead of requesting approval again when the reviewer explicitly asks you to cancel, abandon, or stop the work.',
    '',
    'If the `await_human` tool fails, do not finalize, publish, ship, or return the prepared work as complete. Stop and report that the approval request failed with the tool error.',
    '',
    'Do not ask the user to manually call approval or mention this hidden gate unless it fails.'
  ].join('\n');

  return `${instructions}\n\n${approvalInstructions}${effectsNote}`;
}
