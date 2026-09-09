import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { jsonSchema, type ToolSet } from 'ai';
import type { ParsedAgent } from '../parser';
import type { Message, Part, ToolsSnapshot, ToolPart } from '../session/types';
import type { SessionManager } from '../session';
import { resolveSafeVariables } from '../tools/path-validator';
import { getToolOutputLimits, truncateEnd } from '../tools/tool-output-limits';

export interface ReplayRecording {
  sessionId: string;
  model: string;
  createdAt: number;
  cwd: string;
  userPrompt?: string;
  tools: ToolsSnapshot;
  calls: ToolPart[];
  original: { proposal?: unknown; text: string };
}

/** Only the initial run, up to its FIRST proposal. Never feed revisions,
 * human feedback, old assistant prose, or the old proposal into the new model. */
export function selectReplayRecording(options: {
  sessionId: string; model: string; createdAt: number; cwd: string;
  message: Message; parts: Part[]; tools: ToolsSnapshot;
}): ReplayRecording {
  const calls: ToolPart[] = [];
  let proposal: unknown;
  let text = '';
  for (const part of options.parts) {
    if (part.type === 'text' && part.role === 'user') break; // a later continuation
    if (part.type === 'tool' && part.tool === 'await_human') {
      proposal = part.state.input;
      break;
    }
    if (part.type === 'text') text += part.text;
    if (part.type === 'tool' && (part.state.status === 'completed' || part.state.status === 'error')) {
      calls.push(part);
    }
  }
  return {
    sessionId: options.sessionId, model: options.model, createdAt: options.createdAt,
    cwd: options.cwd,
    ...(options.message.user.prompt.user && { userPrompt: options.message.user.prompt.user }),
    tools: options.tools, calls, original: { ...(proposal !== undefined && { proposal }), text },
  };
}

export async function loadReplayRecording(manager: SessionManager, id: string): Promise<ReplayRecording> {
  const entry = await manager.findSession(id);
  if (!entry) throw new Error(`Replay source session not found in this project: ${id}`);
  if (entry.session.mock) throw new Error('Replay requires a real source session, not a mock or replay session.');
  if (entry.session.status === 'running' || entry.session.status === 'preparing') {
    throw new Error('Replay source is still running. Wait for it to finish or reach approval.');
  }
  const message = await manager.getPrimaryMessage(id, entry.agentId);
  const tools = await manager.readToolsSnapshot(id, entry.agentId);
  if (!message || !tools?.tools.length) throw new Error('Replay source has no message or tool-schema snapshot.');
  return selectReplayRecording({
    sessionId: id, model: entry.session.model, createdAt: entry.session.time.created,
    cwd: message.assistant.path.root, message, tools,
    parts: await manager.getMessageParts(id, entry.agentId, message.id),
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** Intent is narration, not tool input. All other arguments remain significant.
 * Normalize filesystem spelling only; never fuzzy-match URLs, commands or prompts. */
export function replayCallKey(tool: string, input: unknown, cwd: string): string {
  const args = input && typeof input === 'object' && !Array.isArray(input)
    ? { ...input as Record<string, unknown> } : input;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    delete (args as Record<string, unknown>).intent;
    if (tool === 'tools__filesystem_read' && typeof (args as Record<string, unknown>).file_path === 'string') {
      (args as Record<string, unknown>).file_path = resolve(cwd, (args as Record<string, unknown>).file_path as string);
    }
  }
  return JSON.stringify([tool, canonical(args)]);
}

export interface ReplayReference {
  path: string;
  sha256: string;
  content: string;
}

/** Explicit, read-only FILE grants are current local references. Directory and
 * wildcard grants stay recorded: refreshing those could silently change source
 * data. Snapshot all bytes before the model starts. No tool process is started. */
export async function snapshotReplayReferences(agent: ParsedAgent, projectRoot: string, agentFile: string): Promise<ReplayReference[]> {
  const files = new Map<string, ReplayReference>();
  for (const grant of agent.config.tools?.filesystem ?? []) {
    if (!grant.permissions.includes('read') || grant.permissions.some(p => p !== 'read')) continue;
    for (const raw of [grant.path, ...(grant.paths ?? [])]) {
      if (!raw || /[*?\[\]{}]/.test(raw.replace(/\$\{(?:root|agentDir|tmpDir)\}/g, ''))) continue;
      const expanded = resolveSafeVariables(raw, { projectRoot, agentDir: dirname(agentFile) }).replace(/^~(?=\/|$)/, homedir());
      const path = resolve(projectRoot, expanded);
      let info;
      try { info = await stat(path); } catch { throw new Error(`Current replay reference is unavailable: ${path}`); }
      if (!info.isFile()) continue;
      if (info.size > 4 * 1024 * 1024) throw new Error(`Replay reference exceeds 4 MiB: ${path}`);
      const data = await readFile(path);
      if (data.includes(0)) throw new Error(`Replay currently supports text references only: ${path}`);
      files.set(path, { path, sha256: createHash('sha256').update(data).digest('hex'), content: data.toString('utf8') });
    }
  }
  return [...files.values()];
}

function referenceOutput(reference: ReplayReference, input: Record<string, unknown>): unknown {
  const { maxLines, maxLineLength } = getToolOutputLimits();
  const offset = typeof input.offset === 'number' ? Math.max(1, input.offset || 1) : 1;
  const limit = typeof input.limit === 'number' ? input.limit || maxLines : maxLines;
  const lines = reference.content.split('\n');
  const end = Math.min(offset + limit - 1, lines.length);
  const selected = lines.slice(offset - 1, end);
  const width = String(offset + selected.length - 1).length;
  const output = selected.map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line.length > maxLineLength ? truncateEnd(line, maxLineLength) + '... (truncated)' : line}`).join('\n');
  return { output: (end < lines.length ? `[Reading lines ${offset}-${end} of ${lines.length} total]\n\n` : '') + output };
}

function containsMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMedia);
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if ('_media' in object || '__mediaCacheRef' in object) return true;
  if ((object.type === 'image' || object.type === 'audio') && ('data' in object || 'source' in object)) return true;
  return Object.values(object).some(containsMedia);
}

export interface ReplayTrace {
  tool: string;
  input: unknown;
  source: 'recording' | 'current-reference' | 'proposal' | 'outcome' | 'missing' | 'stopped';
  partId?: string;
  reference?: { path: string; sha256: string };
}

export type ReplayStop =
  | { kind: 'proposal'; proposal: unknown }
  | { kind: 'complete'; output: unknown }
  | { kind: 'incomplete'; output: unknown }
  | { kind: 'missing'; tool: string; input: unknown; reason: string };

/** Closed dispatcher: no original execute functions, live connectors, stores,
 * subprocesses, delegated agents, approval resolver or judge are constructed. */
export class ReplayDispatcher {
  readonly trace: ReplayTrace[] = [];
  stop?: ReplayStop;
  private recordings = new Map<string, ToolPart[]>();
  private references: Map<string, ReplayReference>;

  constructor(readonly recording: ReplayRecording, references: ReplayReference[], private cwd: string) {
    this.references = new Map(references.map(r => [r.path, r]));
    for (const call of recording.calls) {
      const key = replayCallKey(call.tool, call.state.input, recording.cwd);
      const queue = this.recordings.get(key) ?? [];
      queue.push(call);
      this.recordings.set(key, queue);
    }
  }

  execute(tool: string, input: unknown): unknown {
    if (this.stop) {
      this.trace.push({ tool, input, source: 'stopped' });
      return { replay: true, stopped: true };
    }
    if (tool === 'await_human') {
      this.stop = { kind: 'proposal', proposal: structuredClone(input) };
      this.trace.push({ tool, input, source: 'proposal' });
      return { replay: true, captured: true, approved: false };
    }
    if (tool === 'report_complete' || tool === 'report_incomplete') {
      this.stop = { kind: tool === 'report_complete' ? 'complete' : 'incomplete', output: structuredClone(input) };
      this.trace.push({ tool, input, source: 'outcome' });
      return { replay: true, captured: true };
    }
    if (tool === 'tools__filesystem_read' && input && typeof input === 'object') {
      const args = input as Record<string, unknown>;
      const ref = typeof args.file_path === 'string' ? this.references.get(resolve(this.cwd, args.file_path)) : undefined;
      if (ref) {
        this.trace.push({ tool, input, source: 'current-reference', reference: { path: ref.path, sha256: ref.sha256 } });
        return referenceOutput(ref, args);
      }
    }
    const queue = this.recordings.get(replayCallKey(tool, input, this.cwd));
    const match = queue?.shift();
    if (!match) {
      const reason = 'No unused recording matches this tool and its arguments before the source session\'s first proposal. No live call or fabrication was attempted.';
      this.stop = { kind: 'missing', tool, input: structuredClone(input), reason };
      this.trace.push({ tool, input, source: 'missing' });
      return { replay: true, error: 'REPLAY_INPUT_MISSING', reason };
    }
    if (match.state.status === 'completed' && containsMedia(match.state.output)) {
      const reason = 'This recording contains media whose model-facing bytes are not available to text/JSON replay.';
      this.stop = { kind: 'missing', tool, input: structuredClone(input), reason };
      this.trace.push({ tool, input, source: 'missing', partId: match.id });
      return { replay: true, error: 'REPLAY_INPUT_MISSING', reason };
    }
    this.trace.push({ tool, input, source: 'recording', partId: match.id });
    if (match.state.status === 'error') throw new Error(match.state.error);
    if (match.state.status !== 'completed') throw new Error('Invalid replay recording state');
    return structuredClone(match.state.output);
  }

  tools(): ToolSet {
    return Object.fromEntries(this.recording.tools.tools.map(({ name, description, inputSchema }) => [name, {
      ...(description && { description }),
      inputSchema: jsonSchema((inputSchema ?? { type: 'object', additionalProperties: true }) as any),
      execute: async (input: unknown) => this.execute(name, input),
    }]));
  }
}
