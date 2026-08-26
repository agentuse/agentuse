import { useState } from 'preact/hooks';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';

export interface DebugPromptContext {
  sessionId: string;
  projectId?: string | undefined;
  projectPath?: string | undefined;
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
  lines.push('Use the `/agentuse` skill for AgentUse commands and workflows.');
  lines.push('Before editing any `.agentuse` file, run:');
  lines.push('  agentuse skills get core --full');
  lines.push('  agentuse skills get creator --full');
  lines.push('After editing, run `agentuse doctor <agent-file>`.');
  lines.push('');
  lines.push('Session:');
  lines.push(`- Session ID: ${ctx.sessionId}`);
  if (ctx.projectId) lines.push(`- Project: ${ctx.projectId}`);
  if (ctx.projectPath) lines.push(`- Project directory: ${ctx.projectPath}`);
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

/** Ready-to-paste handoff from the demo session to a real project agent. */
export function buildOnboardingPrompt(ctx: DebugPromptContext, detail = ''): string {
  const lines = [
    'Help me create my first AgentUse agent in this project.',
  ];
  if (ctx.projectId) lines.splice(1, 0, `Project: ${ctx.projectId}`);
  if (ctx.projectPath) lines.push(`Project directory: ${ctx.projectPath}`);
  lines.push(
    '',
    'Load and follow the installed onboarding workflow:',
    '  agentuse skills get onboarding --full',
    '',
    'The supplied project directory is authoritative. AgentUse serve is already running; do not change its project settings or restart it.',
    'Before creating a file, run `agentuse provider list`. If no AgentUse runtime provider is configured, guide me through `agentuse provider login` and wait until it is ready. Use only a model from a confirmed provider.',
  );
  if (detail.trim()) lines.push('', `The job I want to automate: ${detail.trim()}`);
  return lines.join('\n');
}

// Opens the shared "Send to Coding Agent" dialog pre-loaded with a debug prompt
// for this run (Claude Code, Codex, …): the /agentuse skill, the session id, and
// the exact command to replay the run's logs, plus an optional focus note.
export function DebugPromptButton(props: { context: DebugPromptContext; mode?: 'debug' | 'onboarding' }) {
  const [open, setOpen] = useState(false);
  const onboarding = props.mode === 'onboarding';

  return (
    <>
      <button
        type="button"
        class={`debug-prompt-button${onboarding ? ' onboarding-handoff' : ''}`}
        onClick={() => setOpen(true)}
        title={onboarding
          ? 'Give a coding agent a ready-to-paste prompt for creating your first real agent'
          : 'Hand this run to a coding agent (Claude Code, Codex…) to debug, fix, or improve it'}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{onboarding ? 'Create my first agent…' : 'Send to Coding Agent…'}</span>
      </button>
      <SendToCodingAgentDialog
        open={open}
        buildPrompt={(detail) => onboarding
          ? buildOnboardingPrompt(props.context, detail)
          : buildDebugPrompt(props.context, detail)}
        {...(onboarding ? {
          title: 'create your first agent',
          detailFirst: true,
          promptCollapsed: true,
          copyLabel: 'Copy instructions',
          copyHint: 'Paste into Codex, Claude Code, Cursor, or another coding agent. It will confirm an AgentUse provider before creating your agent.',
          ...(props.context.projectPath ? {
            contextLabel: 'Your agent will be saved in',
            contextValue: props.context.projectPath,
            contextHint: 'AgentUse created and registered this project for you.',
          } : {}),
        } : {})}
        detailLabel={onboarding ? 'What would you like your first agent to do?' : 'Give the agent more detail on what to focus on'}
        placeholder={onboarding ? 'e.g. summarize new support tickets every morning' : 'e.g. the run timed out on the email step'}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
