import { useState } from 'preact/hooks';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';

export interface DebugPromptContext {
  sessionId: string;
  projectId?: string | undefined;
  agentName?: string | undefined;
  agentFilePath?: string | undefined;
  model?: string | undefined;
  sessionStatus?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

// The prompt a coding agent (Claude Code, Codex, etc.) receives when the user
// wants to debug/fix/improve this run. It carries enough context to start
// without back-and-forth: the /agentuse skill, the session id, and the exact
// command to replay the run's logs.
export function buildDebugPrompt(ctx: DebugPromptContext, detail = ''): string {
  const lines: string[] = [];
  lines.push('Help me debug, fix, or improve this AgentUse agent run.');
  lines.push('');
  lines.push('Use the /agentuse skill for AgentUse commands and workflows.');
  lines.push('');
  lines.push('Session:');
  lines.push(`- Session ID: ${ctx.sessionId}`);
  if (ctx.projectId) lines.push(`- Project: ${ctx.projectId}`);
  if (ctx.agentName) {
    lines.push(`- Agent: ${ctx.agentName}${ctx.agentFilePath ? ` (${ctx.agentFilePath})` : ''}`);
  } else if (ctx.agentFilePath) {
    lines.push(`- Agent file: ${ctx.agentFilePath}`);
  }
  if (ctx.model) lines.push(`- Model: ${ctx.model}`);
  if (ctx.sessionStatus) lines.push(`- Status: ${ctx.sessionStatus}`);
  if (ctx.errorCode || ctx.errorMessage) {
    lines.push(`- Error: ${[ctx.errorCode, ctx.errorMessage].filter(Boolean).join(': ')}`);
  }
  lines.push('');
  lines.push('Inspect what happened in this run:');
  lines.push(`  agentuse sessions show ${ctx.sessionId} --full`);
  lines.push('');
  lines.push(
    'Read the full session log, identify what went wrong or could be better, ' +
    'then help me debug the issue, fix the agent, or improve the run.'
  );
  if (detail.trim()) {
    lines.push('');
    lines.push(`Focus on: ${detail.trim()}`);
  }
  return lines.join('\n');
}

// Opens the shared "Send to Coding Agent" dialog pre-loaded with a debug prompt
// for this run (Claude Code, Codex, …): the /agentuse skill, the session id, and
// the exact command to replay the run's logs, plus an optional focus note.
export function DebugPromptButton(props: { context: DebugPromptContext }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        class="debug-prompt-button"
        onClick={() => setOpen(true)}
        title="Hand this run to a coding agent (Claude Code, Codex…) to debug, fix, or improve it"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>Send to Coding Agent…</span>
      </button>
      <SendToCodingAgentDialog
        open={open}
        buildPrompt={(detail) => buildDebugPrompt(props.context, detail)}
        detailLabel="Give the agent more detail on what to focus on"
        placeholder="e.g. the run timed out on the email step"
        onClose={() => setOpen(false)}
      />
    </>
  );
}
