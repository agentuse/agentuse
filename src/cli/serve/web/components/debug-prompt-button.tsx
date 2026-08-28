import { useCallback, useEffect, useState } from 'preact/hooks';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';
import { fetchAgents, type AgentRow } from '../lib/api';
import { agentDetailHref } from '../lib/links';
import type { ProviderStatus } from '../../../../auth/provider-status';

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

export interface OnboardingExecutionContext {
  surface: 'web' | 'desktop';
  cliCommand: string;
  serveAlreadyRunning: boolean;
  providerStatus?: ProviderStatus;
}

declare global {
  interface Window {
    agentuseDesktop?: {
      surface: 'desktop';
      cliCommand: string;
      serveAlreadyRunning: true;
      getProviderStatus: () => Promise<ProviderStatus>;
    };
  }
}

function currentOnboardingExecutionContext(providerStatus?: ProviderStatus): OnboardingExecutionContext | undefined {
  if (typeof window === 'undefined' || !window.agentuseDesktop) return undefined;
  return {
    surface: window.agentuseDesktop.surface,
    cliCommand: window.agentuseDesktop.cliCommand,
    serveAlreadyRunning: window.agentuseDesktop.serveAlreadyRunning,
    ...(providerStatus ? { providerStatus } : {}),
  };
}

const ONBOARDING_POLL_MS = 3_000;
const ONBOARDING_SLOW_MS = 90_000;
const ONBOARDING_WAIT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function onboardingProjectAgents(agents: AgentRow[], projectId: string | undefined): AgentRow[] {
  if (!projectId) return [];
  return agents.filter((agent) => agent.projectId === projectId);
}

function waitingStorageKey(ctx: DebugPromptContext): string | undefined {
  if (!ctx.projectId) return undefined;
  return `agentuse:onboarding:waiting:${ctx.projectId}:${ctx.sessionId}`;
}

function readWaitingStartedAt(key: string | undefined): number | null {
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value) && value > 0 && Date.now() - value < ONBOARDING_WAIT_MAX_AGE_MS) return value;
    localStorage.removeItem(key);
  } catch {
    // Restricted browser contexts may deny storage; polling still works for
    // the lifetime of this page.
  }
  return null;
}

function writeWaitingStartedAt(key: string | undefined, value: number | null): void {
  if (!key || typeof localStorage === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // Storage persistence is an accelerator, never required for detection.
  }
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
export function buildOnboardingPrompt(
  ctx: DebugPromptContext,
  detail = '',
  execution?: OnboardingExecutionContext,
): string {
  const cli = execution?.cliCommand ?? 'agentuse';
  const lines = [
    '# Create My First Agent',
    '',
    'Help me create my first AgentUse agent in this project.',
    '',
    '## Project',
  ];
  if (ctx.projectId) lines.push(`- **Project:** ${ctx.projectId}`);
  if (ctx.projectPath) lines.push(`- **Directory:** ${ctx.projectPath}`);
  if (!ctx.projectId && !ctx.projectPath) lines.push('- Use the project supplied by AgentUse.');
  if (detail.trim()) {
    lines.push(
      '',
      '## What I Want to Automate',
      '',
      detail.trim(),
    );
  }
  if (execution?.surface === 'desktop') {
    lines.push(
      '',
      '## AgentUse CLI',
      '',
      'Use this CLI bundled inside AgentUse Desktop for every AgentUse command:',
      '',
      '```sh',
      cli,
      '```',
      '',
      'Do not substitute a package-manager installation or bare `agentuse`.',
    );
    if (execution.providerStatus) {
      lines.push(
        '',
        '## Provider Status from AgentUse Desktop',
        '',
        'AgentUse Desktop read this status from the same runtime environment that will run the agent:',
        '',
        '```json',
        JSON.stringify(execution.providerStatus, null, 2),
        '```',
        '',
        'Use this status as authoritative. Do not replace it with credentials from the coding agent itself.',
      );
    }
  }
  lines.push(
    '',
    '## Required Workflow',
    '',
    '1. Load and follow the installed onboarding workflow:',
    '',
    '```sh',
    `${cli} skills get onboarding --full`,
    '```',
  );
  if (execution?.surface === 'desktop' && execution.providerStatus) {
    lines.push(
      '',
      '2. Use the provider status supplied above. A provider is ready for Desktop only when it has `configured: true` and at least one source with `stored: true`.',
      '',
      '3. If no provider is ready, do not create the agent yet. Guide me through provider login:',
      '',
      '```sh',
      `${cli} provider login`,
      '```',
      '',
      '4. After login, confirm the updated status from the same Desktop profile:',
      '',
      '```sh',
      `${cli} provider list --json`,
      '```',
      '',
      '5. Use only a model from a confirmed provider.',
    );
  } else {
    lines.push(
      '',
      '2. Before creating a file, check the available AgentUse providers:',
      '',
      '```sh',
      `${cli} provider list --json`,
      '```',
      '',
      '3. Read the JSON result. If the provider you will use has `configured: false`, do not create the agent yet. Guide me through provider login and wait until it is ready:',
      '',
      '```sh',
      `${cli} provider login`,
      '```',
      '',
      '4. Use only a model from a confirmed provider.',
    );
  }
  lines.push(
    '',
    '## Runtime Guardrails',
    '',
    '- The supplied project directory is authoritative.',
    execution?.surface === 'desktop' && execution.serveAlreadyRunning
      ? '- AgentUse Desktop owns the running `serve` process. Do not change its project settings, reconfigure it, or restart it.'
      : '- AgentUse `serve` is already running. Do not change its project settings or restart it.',
  );
  return lines.join('\n');
}

// Opens the shared "Send to Coding Agent" dialog pre-loaded with a debug prompt
// for this run (Claude Code, Codex, …): the /agentuse skill, the session id, and
// the exact command to replay the run's logs, plus an optional focus note.
export function DebugPromptButton(props: { context: DebugPromptContext; mode?: 'debug' | 'onboarding' }) {
  const [open, setOpen] = useState(false);
  const onboarding = props.mode === 'onboarding';
  const storageKey = onboarding ? waitingStorageKey(props.context) : undefined;
  const [waitingStartedAt, setWaitingStartedAt] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [detectedAgents, setDetectedAgents] = useState<AgentRow[]>([]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | undefined>(undefined);
  const [providerStatusLoading, setProviderStatusLoading] = useState(false);
  const [providerStatusError, setProviderStatusError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(false);
    setDetectedAgents([]);
    setCheckError(null);
    setProviderStatus(undefined);
    setProviderStatusError(null);
    setWaitingStartedAt(onboarding ? readWaitingStartedAt(storageKey) : null);
  }, [onboarding, storageKey]);

  useEffect(() => {
    if (!onboarding || !props.context.projectId) return;
    let cancelled = false;

    const check = async () => {
      try {
        const payload = await fetchAgents();
        if (cancelled) return;
        const matches = onboardingProjectAgents(payload.agents, props.context.projectId);
        setCheckError(null);
        if (matches.length === 0) return;
        setDetectedAgents(matches);
        setWaitingStartedAt(null);
        writeWaitingStartedAt(storageKey, null);
      } catch (error) {
        if (!cancelled) setCheckError((error as Error).message || 'Could not check for your agent.');
      }
    };

    void check();
    const interval = waitingStartedAt === null ? undefined : setInterval(() => void check(), ONBOARDING_POLL_MS);
    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
    };
  }, [onboarding, props.context.projectId, storageKey, waitingStartedAt, checkRevision]);

  useEffect(() => {
    if (waitingStartedAt === null) {
      setSlow(false);
      return;
    }
    const remaining = ONBOARDING_SLOW_MS - (Date.now() - waitingStartedAt);
    if (remaining <= 0) {
      setSlow(true);
      return;
    }
    setSlow(false);
    const timeout = setTimeout(() => setSlow(true), remaining);
    return () => clearTimeout(timeout);
  }, [waitingStartedAt]);

  const beginWaiting = useCallback(() => {
    const startedAt = Date.now();
    setOpen(false);
    setCheckError(null);
    setWaitingStartedAt(startedAt);
    writeWaitingStartedAt(storageKey, startedAt);
    setCheckRevision((value) => value + 1);
  }, [storageKey]);

  const openPrompt = useCallback(async () => {
    if (!onboarding || typeof window === 'undefined' || !window.agentuseDesktop) {
      setOpen(true);
      return;
    }
    setProviderStatusLoading(true);
    setProviderStatusError(null);
    try {
      setProviderStatus(await window.agentuseDesktop.getProviderStatus());
      setOpen(true);
    } catch (error) {
      setProviderStatusError((error as Error).message || 'Could not read provider status from AgentUse Desktop.');
    } finally {
      setProviderStatusLoading(false);
    }
  }, [onboarding]);

  if (onboarding && detectedAgents.length === 1) {
    const agent = detectedAgents[0];
    return (
      <div class="onboarding-agent-status is-ready" role="status" aria-live="polite">
        <span class="onboarding-agent-status-icon" aria-hidden="true">✓</span>
        <span class="onboarding-agent-status-copy">
          <strong>Your agent is ready</strong>
          <span><code>{agent.name}</code> was added successfully.</span>
        </span>
        <a class="onboarding-agent-status-primary" href={agentDetailHref(agent.projectId, agent.runPath)}>
          Open agent
        </a>
      </div>
    );
  }

  if (onboarding && detectedAgents.length > 1) {
    const projectHref = props.context.projectId
      ? `/agents/${encodeURIComponent(props.context.projectId)}`
      : '/agents';
    return (
      <div class="onboarding-agent-status is-ready" role="status" aria-live="polite">
        <span class="onboarding-agent-status-icon" aria-hidden="true">✓</span>
        <span class="onboarding-agent-status-copy">
          <strong>Your agents are ready</strong>
          <span>{detectedAgents.length} agents are available in this project.</span>
        </span>
        <a class="onboarding-agent-status-primary" href={projectHref}>Open agents</a>
      </div>
    );
  }

  const waiting = onboarding && waitingStartedAt !== null;

  return (
    <>
      {waiting ? (
        <div class={`onboarding-agent-status is-waiting${slow ? ' is-slow' : ''}`} role="status" aria-live="polite" aria-busy="true">
          <span class="btn-spinner onboarding-agent-status-spinner" aria-hidden="true" />
          <span class="onboarding-agent-status-copy">
            <strong>{slow ? 'Still waiting for your agent…' : 'Waiting for your agent…'}</strong>
            <span>{slow
              ? 'Creation may still be in progress. AgentUse will keep checking.'
              : 'Finish the setup in your coding agent. This screen will update automatically.'}</span>
            {slow && checkError && <small>{checkError}</small>}
          </span>
          {slow && (
            <span class="onboarding-agent-status-actions">
              <button type="button" onClick={() => void openPrompt()}>Copy prompt again</button>
              <button
                type="button"
                onClick={() => {
                  setCheckError(null);
                  setCheckRevision((value) => value + 1);
                }}
              >Check for agent</button>
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          class={`debug-prompt-button${onboarding ? ' onboarding-handoff' : ''}`}
          disabled={providerStatusLoading}
          aria-busy={providerStatusLoading}
          onClick={() => void openPrompt()}
          title={onboarding
            ? 'Give a coding agent a ready-to-paste prompt for creating your first real agent'
            : 'Hand this run to a coding agent (Claude Code, Codex…) to debug, fix, or improve it'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2v1" />
          </svg>
          <span>{providerStatusLoading
            ? 'Checking providers…'
            : onboarding ? 'Create my first agent…' : 'Send to Coding Agent…'}</span>
        </button>
      )}
      {providerStatusError && (
        <span class="onboarding-provider-status-error" role="alert">
          Couldn’t read provider status from AgentUse Desktop. Try again.
        </span>
      )}
      <SendToCodingAgentDialog
        open={open}
        buildPrompt={(detail) => onboarding
          ? buildOnboardingPrompt(props.context, detail, currentOnboardingExecutionContext(providerStatus))
          : buildDebugPrompt(props.context, detail)}
        {...(onboarding ? {
          title: 'create your first agent',
          detailFirst: true,
          promptCollapsed: true,
          copyLabel: 'Copy instructions',
          copyHint: 'Paste into Codex, Claude Code, Cursor, or another coding agent. AgentUse will detect your new agent automatically.',
          ...(props.context.projectPath ? {
            contextLabel: 'Your agent will be saved in',
            contextValue: props.context.projectPath,
            contextHint: 'AgentUse created and registered this project for you.',
          } : {}),
        } : {})}
        detailLabel={onboarding ? 'What would you like your first agent to do?' : 'Give the agent more detail on what to focus on'}
        placeholder={onboarding ? 'e.g. summarize new support tickets every morning' : 'e.g. the run timed out on the email step'}
        {...(onboarding ? { onCopied: beginWaiting } : {})}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
