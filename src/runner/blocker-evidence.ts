import type { ToolCallTrace } from '../plugin/types';
import type { RunOutcome } from '../tools/report-outcome';
import {
  normalizeBlockerSubject,
  type Blocker,
  type BlockerKind,
  type BlockerSource,
} from '../session/blocker';

export interface RuntimeBlockerEvidence {
  kind: Extract<BlockerKind, 'missing_tool' | 'missing_package'>;
  subject: string;
}

const MISSING_TOOL_PATTERNS = [
  // sh/bash: "/bin/sh: birdc: command not found". The lookahead skips zsh's
  // "zsh: command not found: birdc", whose name follows instead.
  /(?:^|[\s:])([A-Za-z0-9_.+-]+): command not found(?!:)/g,
  // zsh: "zsh: command not found: birdc"
  /command not found: ([A-Za-z0-9_.+-]+)/g,
];
// Python: "ModuleNotFoundError: No module named 'boto3.session'"
const MISSING_PYTHON_MODULE = /No module named '([A-Za-z0-9_.]+)'/g;
// Node: "Cannot find module 'zod'" / "Cannot find package 'zod'". Relative and
// absolute paths are a broken import in the agent's own code, not a package.
const MISSING_NODE_PACKAGE = /Cannot find (?:module|package) '([^'./][^']*)'/g;

function traceText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function childRuntimeBlocker(output: unknown): RuntimeBlockerEvidence | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const metadata = (output as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const blocker = (metadata as { blocker?: Partial<Blocker> }).blocker;
  if (!blocker || blocker.source !== 'runtime' || typeof blocker.subject !== 'string') return undefined;
  if (blocker.kind !== 'missing_tool' && blocker.kind !== 'missing_package') return undefined;
  return { kind: blocker.kind, subject: blocker.subject };
}

/** Top-level package for a module path: `boto3.session` → `boto3`, `@scope/pkg/x` → `@scope/pkg`. */
function packageRoot(module: string, separator: '.' | '/'): string {
  const parts = module.split(separator);
  return separator === '/' && module.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * Blockers the runtime can prove from what a failed tool call printed. Only
 * failed calls count: a successful `which birdc || echo missing` is the agent
 * checking, not the run breaking. Ordered oldest to newest, one per subject.
 */
export function detectRuntimeBlockers(traces: readonly ToolCallTrace[] | undefined): RuntimeBlockerEvidence[] {
  const found = new Map<string, RuntimeBlockerEvidence>();
  const add = (kind: RuntimeBlockerEvidence['kind'], subject: string) => {
    const key = `${kind}:${normalizeBlockerSubject(subject)}`;
    found.delete(key);
    found.set(key, { kind, subject });
  };
  for (const trace of traces ?? []) {
    if (trace.type === 'llm') continue;
    // A sub-agent already settled its own blocker from its own trace; a parent
    // inherits that proof rather than re-reading the child's tool calls.
    const child = trace.type === 'subagent' ? childRuntimeBlocker(trace.output) : undefined;
    if (child) add(child.kind, child.subject);
    if (trace.success !== false) continue;
    const text = traceText(trace.output);
    for (const pattern of MISSING_TOOL_PATTERNS) {
      for (const match of text.matchAll(pattern)) add('missing_tool', match[1]!);
    }
    for (const match of text.matchAll(MISSING_PYTHON_MODULE)) add('missing_package', packageRoot(match[1]!, '.'));
    for (const match of text.matchAll(MISSING_NODE_PACKAGE)) add('missing_package', packageRoot(match[1]!, '/'));
  }
  return [...found.values()];
}

/** Whole-word mention, so subject `ls` does not match "tools". */
function mentions(text: string, subject: string): boolean {
  if (!subject) return false;
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`).test(text);
}

/**
 * The blocker to persist for an incomplete run. Runtime evidence wins when it
 * is about the same problem the agent declared: a subject the agent's own words
 * name, or else the only evidence of the kind it declared. Otherwise the
 * agent's declaration stands, so a stray `command not found` from an
 * exploratory call cannot relabel an unrelated blocker.
 */
export function resolveBlocker(
  declared: { kind: BlockerKind; subject: string } | undefined,
  reason: string,
  evidence: readonly RuntimeBlockerEvidence[],
): Blocker | undefined {
  const said = normalizeBlockerSubject(`${declared?.subject ?? ''} ${reason}`);
  const named = [...evidence].reverse().find((item) => mentions(said, normalizeBlockerSubject(item.subject)));
  const sameKind = evidence.filter((item) => item.kind === declared?.kind);
  const matched = named ?? (sameKind.length === 1 ? sameKind[0] : undefined);
  if (matched) return { kind: matched.kind, subject: matched.subject, source: 'runtime' };
  if (!declared) return undefined;
  return { kind: declared.kind, subject: declared.subject.trim(), source: 'agent' };
}

type Incomplete = NonNullable<RunOutcome['incomplete']>;

/**
 * Weigh runtime evidence against the agent's declared blocker and return the
 * incomplete verdict to persist and report. Called once, when the run ends.
 */
export function settleIncomplete(incomplete: Incomplete, traces: readonly ToolCallTrace[] | undefined): Incomplete {
  const blocker = resolveBlocker(incomplete.blocker, incomplete.reason, detectRuntimeBlockers(traces));
  return { ...incomplete, ...(blocker && { blocker }) };
}

/** The session error an incomplete verdict persists as. */
export function incompleteSessionError(incomplete: Incomplete): {
  code: 'INCOMPLETE';
  message: string;
  cause?: string;
  subject?: string;
  causeSource?: BlockerSource;
} {
  const blocker = incomplete.blocker;
  return {
    code: 'INCOMPLETE',
    message: incomplete.reason,
    ...(blocker && {
      cause: blocker.kind,
      subject: blocker.subject,
      causeSource: blocker.source ?? 'agent',
    }),
  };
}
