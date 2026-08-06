import { ANTHROPIC_IDENTITY_PROMPT } from '../../utils/anthropic';
import type { CorrectionsPart, Message, Part, SessionInfo, ToolsSnapshot } from '../../session/types';
import type {
  ContextCorrectionCounts,
  ContextFileRead,
  ContextFileReadContent,
  ContextStackLayer,
  ContextToolCallDetail,
  ContextToolResultStat,
  ContextToolRow,
  SessionContextPayload,
} from './types';

/**
 * Reconstructs "what was actually in the context window" for one session.
 *
 * Nothing here is new instrumentation: a run already persists its resolved
 * system messages (`Message.assistant.system[]`), its resolved instructions
 * (`Message.user.prompt.task`, i.e. after ${root}-style variable resolution,
 * approval instructions, inlined skills and injected corrections), and its full
 * tool catalog (the `tools` snapshot). This module only splits those back into
 * attributable layers, so the page works on sessions that predate it.
 *
 * The split is done with the exact headings the runtime appends. If those
 * headings ever change, the affected block degrades to staying part of the
 * agent-instructions layer - the text is still shown, just less finely
 * attributed. See the marker constants below.
 */

/** Same heuristic the runtime's context manager uses (DEFAULT_CHARS_PER_TOKEN). */
const CHARS_PER_TOKEN = 4;

const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

// Headings the runtime appends to the agent body, in append order. Kept in sync
// with runner/approval.ts (appendApprovalInstructions), runner/preparation.ts
// (the skills block) and runner/system-messages.ts (renderLearningPrompt).
const APPROVAL_HEADING = '## Approval Gate';
const SKILLS_HEADING = '## Skills (shared defaults';
const LEARNINGS_HEADING = '## Recent Corrections (override skill defaults on conflict)';

interface Cut {
  kind: 'approval' | 'skills' | 'learnings';
  index: number;
}

/**
 * Locate the appended blocks, searching backwards. An agent's own markdown may
 * legitimately contain a `## Approval Gate` heading of its own; the appended
 * one is always the last, and always after the preceding block in append order.
 */
function findAppendedBlocks(task: string): Cut[] {
  const cuts: Cut[] = [];
  let limit = task.length;

  for (const { kind, marker } of [
    { kind: 'learnings' as const, marker: LEARNINGS_HEADING },
    { kind: 'skills' as const, marker: SKILLS_HEADING },
    { kind: 'approval' as const, marker: APPROVAL_HEADING },
  ]) {
    const index = task.lastIndexOf(`\n${marker}`, limit);
    if (index === -1) continue;
    cuts.push({ kind, index: index + 1 });
    limit = index;
  }

  return cuts.sort((a, b) => a.index - b.index);
}

/**
 * How many corrections the injected block carried, and - when the run recorded
 * a corrections marker - how many were stored but left out of it.
 *
 * The marker is authoritative when present: it is the injection site's own
 * count, including the ones that never made it into the text. Without one the
 * block is all there is, and `renderLearningPrompt` writes exactly one
 * `- [category] instruction` bullet per injected correction, so counting them
 * recovers `applied`. The stored total and the cap leave no trace in the text
 * and stay absent rather than being inferred from the part that did.
 */
function correctionCounts(
  block: string,
  marker: CorrectionsPart | undefined
): ContextCorrectionCounts | undefined {
  if (marker) return { applied: marker.applied, active: marker.active, cap: marker.cap };

  const applied = block.split('\n').filter((line) => /^- \[[^\]]*\] /.test(line)).length;
  return applied > 0 ? { applied } : undefined;
}

/**
 * Split the inlined skills block into one layer per skill, naming the directory
 * each SKILL.md was read from. That directory is the answer to "which file got
 * loaded", so it is worth more than a single opaque blob.
 */
function splitSkillsBlock(block: string): ContextStackLayer[] {
  // Drop the "## Skills (shared defaults ...)" heading line itself; everything
  // after it is one `## Skill: <name>` section per preloaded skill.
  const body = block.slice(block.indexOf('\n') + 1);
  const sections = body.split(/(?=^## Skill: )/m).filter((s) => s.trim().length > 0);

  if (sections.length === 0) {
    return [makeLayer('skills', 'skills', 'Skills', block, {
      note: 'Skill files inlined into the instructions by `skills:` in frontmatter.',
    })];
  }

  return sections.map((section, i) => {
    const name = section.match(/^## Skill: (.+)$/m)?.[1]?.trim();
    const directory = section.match(/^\*\*Base directory\*\*: (.+)$/m)?.[1]?.trim();
    return makeLayer('skills', `skills-${i}`, name ? `Skill: ${name}` : `Skill ${i + 1}`, section, {
      ...(directory ? { source: `${directory}/SKILL.md` } : {}),
      note: 'Loaded in full at start because the agent lists it under `skills:`.',
    });
  });
}

/** Tools whose result is the text of a file, i.e. a file entering the context. */
const READ_TOOLS = new Set(['tools__filesystem_read', 'tools__skill_read', 'tools__skill_load']);

// Budgets for shipping read contents to the page. The weight figures are always
// exact; only the readable preview is bounded, so a run that read a hundred
// files cannot turn this diagnostic into a multi-megabyte response.
const MAX_TEXT_PER_READ = 20_000;
const MAX_READS_WITH_TEXT = 5;
const MAX_TOTAL_TEXT = 500_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Collapse `.` and `..` segments. Agents routinely read through paths like
 * `agents/../../data/x.json`; left raw those read as different files and defeat
 * the per-file merge below.
 */
function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // A leading `..` on a relative path has nothing to pop; keep it.
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  if (absolute) return `/${joined}`;
  return path.startsWith('./') && !joined.startsWith('..') ? `./${joined}` : joined;
}

/** The file a read call targeted, as the tool's own input describes it. */
function readTargetPath(tool: string, input: unknown): string | undefined {
  const args = asRecord(input);
  if (tool === 'tools__filesystem_read') {
    return typeof args.file_path === 'string' ? normalizePath(args.file_path) : undefined;
  }
  if (tool === 'tools__skill_read') {
    const skill = typeof args.skill === 'string' ? args.skill : undefined;
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!skill && !path) return undefined;
    return [skill, path].filter(Boolean).join('/');
  }
  // tools__skill_load pulls a whole SKILL.md in on demand.
  const name = typeof args.name === 'string' ? args.name : undefined;
  return name ? `${name}/SKILL.md` : undefined;
}

/** Per-tool cap on the individual calls shipped to the page. */
const MAX_CALL_DETAILS = 12;

/**
 * A one-line identity for a single tool call, taken from whichever argument
 * actually says what it did. Mirrors the fields the CLI logger prints for the
 * builtin tools, then falls back to a compact preview of the arguments so an
 * MCP tool still gets something better than "call 3".
 */
function describeCall(input: unknown): string {
  // Generous, because the page shortens the paths inside a command before it
  // truncates: spending this budget on directory names would cut the script
  // name and arguments, which are the parts that tell calls apart.
  const cap = 400;
  const args = asRecord(input);
  for (const key of ['command', 'file_path', 'path', 'name', 'query', 'url', 'prompt', 'pattern']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const line = value.trim().split('\n')[0]!;
      return line.length > cap ? `${line.slice(0, cap)}…` : line;
    }
  }
  const preview = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
  if (!preview) return 'no arguments';
  return preview.length > cap ? `${preview.slice(0, cap)}…` : preview;
}

/** The text the tool actually returned, which is what the model then carries. */
function readOutputText(state: unknown): string | undefined {
  const s = asRecord(state);
  if (typeof s.output === 'string') return s.output;
  const output = asRecord(s.output);
  return typeof output.output === 'string' ? output.output : undefined;
}

/**
 * When the runtime truncated a large output it records the pre-truncation size
 * alongside the artifact it spilled the rest to. Worth surfacing: it is the
 * difference between "this file is huge" and "this file is huge in my context".
 */
function originalChars(state: unknown): number | undefined {
  const s = asRecord(state);
  for (const source of [asRecord(s.metadata), asRecord(asRecord(s.output).metadata)]) {
    const ref = asRecord(source.fullOutputArtifact);
    if (typeof ref.originalChars === 'number') return ref.originalChars;
  }
  return undefined;
}

/**
 * Files pulled into the context window by read tools during the run, merged per
 * path. A file read three times is one row with `reads: 3` and the summed cost,
 * because that is what it charged the context.
 */
export function buildFileReads(parts: Part[]): ContextFileRead[] {
  const byPath = new Map<string, ContextFileRead>();

  for (const part of parts) {
    if (part.type !== 'tool' || !READ_TOOLS.has(part.tool)) continue;
    const state = part.state;
    // Only completed reads put text in the context; a failed one contributes
    // just its error string.
    if (state.status !== 'completed') continue;

    const path = readTargetPath(part.tool, state.input);
    if (!path) continue;
    const text = readOutputText(state);
    if (text === undefined) continue;

    const existing = byPath.get(path);
    const full = originalChars(state);
    const startedAt = state.time?.start;

    if (existing) {
      existing.reads += 1;
      existing.chars += text.length;
      existing.estTokens = estimateTokens(existing.chars);
      existing.content?.push({ chars: text.length, text, truncated: false });
      if (full !== undefined) existing.truncatedFrom = Math.max(existing.truncatedFrom ?? 0, full);
    } else {
      byPath.set(path, {
        path,
        tool: part.tool,
        reads: 1,
        chars: text.length,
        estTokens: estimateTokens(text.length),
        content: [{ chars: text.length, text, truncated: false }],
        ...(full !== undefined && full > text.length ? { truncatedFrom: full } : {}),
        ...(typeof startedAt === 'number' ? { firstReadAt: startedAt } : {}),
      });
    }
  }

  const files = [...byPath.values()].sort((a, b) => b.chars - a.chars);

  // Trim the previews to the transport budget, heaviest file first so the rows
  // most worth reading keep their text. `chars`/`estTokens` are left untouched.
  let remaining = MAX_TOTAL_TEXT;
  for (const file of files) {
    const kept: ContextFileReadContent[] = [];
    for (const entry of (file.content ?? []).slice(0, MAX_READS_WITH_TEXT)) {
      if (remaining <= 0) break;
      const limit = Math.min(MAX_TEXT_PER_READ, remaining);
      const truncated = entry.text.length > limit;
      const text = truncated ? entry.text.slice(0, limit) : entry.text;
      remaining -= text.length;
      kept.push({ chars: entry.chars, text, truncated });
    }
    if (kept.length > 0) file.content = kept;
    else delete file.content;
  }

  return files;
}

function makeLayer(
  kind: ContextStackLayer['kind'],
  id: string,
  label: string,
  text: string,
  extra: { source?: string; note?: string; corrections?: ContextCorrectionCounts } = {}
): ContextStackLayer {
  return {
    id,
    kind,
    label,
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.corrections ? { corrections: extra.corrections } : {}),
    chars: text.length,
    estTokens: estimateTokens(text.length),
    text,
  };
}

/**
 * The runtime prepends a one-line identity string for Anthropic models. At ~15
 * tokens it is noise as its own row, so its weight is folded into the AgentUse
 * system prompt instead of being listed separately.
 */
function isIdentityMessage(content: string): boolean {
  return content.trim() === ANTHROPIC_IDENTITY_PROMPT.trim();
}

/**
 * What the run itself added to the window after the opening prompt: the
 * model's own words, and the results its tool calls returned.
 *
 * Both re-enter the context on every later step, so on a long run they are
 * usually the larger half of the window - the opening stack is charged once,
 * these accumulate. Every tool that ran appears, including the read tools and
 * ones that only ever failed, so this is the run's whole tool activity; the
 * read tools carry `countedAsFiles` because their bytes are itemised as file
 * rows and must not be added twice.
 */
export function buildRunTraffic(parts: Part[]): {
  outputChars: number;
  toolResults: ContextToolResultStat[];
} {
  let outputChars = 0;
  const byTool = new Map<string, ContextToolResultStat>();

  const statFor = (tool: string): ContextToolResultStat => {
    const existing = byTool.get(tool);
    if (existing) return existing;
    const fresh: ContextToolResultStat = {
      tool,
      calls: 0,
      failed: 0,
      pending: 0,
      chars: 0,
      estTokens: 0,
      ...(READ_TOOLS.has(tool) ? { countedAsFiles: true } : {}),
    };
    byTool.set(tool, fresh);
    return fresh;
  };

  for (const part of parts) {
    if (part.type === 'text' && part.role !== 'user') {
      outputChars += part.text.length;
      continue;
    }
    if (part.type === 'reasoning') {
      outputChars += part.text.length;
      continue;
    }
    if (part.type !== 'tool') continue;

    const stat = statFor(part.tool);
    const detail = (status: ContextToolCallDetail['status'], chars: number) => {
      (stat.callDetails ??= []).push({
        label: describeCall(part.state.input),
        chars,
        estTokens: estimateTokens(chars),
        status,
      });
    };

    if (part.state.status === 'error') {
      // A failed call still costs its arguments and an error string, but it
      // returns no result text - so it is worth seeing, and adds no chars.
      stat.failed += 1;
      detail('failed', 0);
      continue;
    }
    if (part.state.status !== 'completed') {
      // Running, or parked on a gate. Its arguments are already in the window,
      // but there is no result yet.
      stat.pending += 1;
      detail('pending', 0);
      continue;
    }

    // The arguments the model wrote are output; the result it got back is
    // input on the next step. Both sit in the window either way.
    outputChars += JSON.stringify(part.state.input ?? '').length;
    stat.calls += 1;
    const chars = stat.countedAsFiles
      ? 0
      : readOutputText(part.state)?.length ?? JSON.stringify(part.state.output ?? '').length;
    if (!stat.countedAsFiles) {
      stat.chars += chars;
      stat.estTokens = estimateTokens(stat.chars);
    }
    detail('ok', chars);
  }

  // Heaviest call first: the question a reader has when a tool's total is
  // large is which call caused it.
  for (const stat of byTool.values()) {
    if (!stat.callDetails) continue;
    stat.callDetails.sort((a, b) => b.chars - a.chars);
    if (stat.callDetails.length > MAX_CALL_DETAILS) {
      stat.callDetails = stat.callDetails.slice(0, MAX_CALL_DETAILS);
    }
  }

  return {
    outputChars,
    // Heaviest first, with the read tools last: their bytes are shown as file
    // rows, so they are context for the reader rather than part of the total.
    toolResults: [...byTool.values()].sort((a, b) =>
      Number(a.countedAsFiles ?? false) - Number(b.countedAsFiles ?? false)
      || b.chars - a.chars
      || a.tool.localeCompare(b.tool)
    ),
  };
}

/**
 * Name a system message by its opening. These are the three the runtime can
 * emit once identity is folded away (core, manager, sandbox); anything
 * unrecognised still gets a layer, just a generic label.
 */
function describeSystemMessage(content: string, index: number): { label: string; note?: string } {
  if (content.startsWith('You are an autonomous AI agent')) {
    return { label: 'AgentUse system prompt', note: 'Built in. Output style, tool discipline, and the report_complete contract.' };
  }
  if (content.startsWith('You are a team manager agent')) {
    return { label: 'Manager instructions', note: 'Added because this agent is `type: manager`. Lists its subagents.' };
  }
  if (content.startsWith('## Sandbox Environment')) {
    return { label: 'Sandbox environment', note: 'Added because `sandbox:` is configured. Lists the container mount paths.' };
  }
  return { label: `System message ${index + 1}` };
}

export function buildSessionContextPayload(options: {
  session: SessionInfo;
  message: Message | null;
  tools: ToolsSnapshot | null;
  /** Every part of the session, used to find mid-run file reads. */
  parts?: Part[];
}): SessionContextPayload {
  const { session, message, tools, parts = [] } = options;
  const layers: ContextStackLayer[] = [];

  const rawSystem = message?.assistant.system ?? [];
  const identityChars = rawSystem.filter(isIdentityMessage).reduce((sum, c) => sum + c.length, 0);
  const systemMessages = rawSystem.filter((c) => !isIdentityMessage(c));

  for (const [i, content] of systemMessages.entries()) {
    const { label, note } = describeSystemMessage(content, i);
    // System prompts are fixed runtime text the reader did not write, so the
    // row carries its weight but not its body. Only the first row absorbs the
    // folded-in identity line.
    const chars = content.length + (i === 0 ? identityChars : 0);
    layers.push({
      id: `system-${i}`,
      kind: 'system',
      label,
      ...(note ? { note } : {}),
      chars,
      estTokens: estimateTokens(chars),
    });
  }

  // An identity line with nothing to fold into still has to be accounted for.
  if (systemMessages.length === 0 && identityChars > 0) {
    layers.push({
      id: 'system-0',
      kind: 'system',
      label: 'AgentUse system prompt',
      note: 'Built in.',
      chars: identityChars,
      estTokens: estimateTokens(identityChars),
    });
  }

  const toolRows: ContextToolRow[] = (tools?.tools ?? []).map((tool) => {
    const schema = tool.inputSchema === undefined ? undefined : JSON.stringify(tool.inputSchema, null, 2);
    const chars = (tool.name.length) + (tool.description?.length ?? 0) + (schema?.length ?? 0);
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(schema ? { schema } : {}),
      chars,
      estTokens: estimateTokens(chars),
    };
  });

  if (toolRows.length > 0) {
    const chars = toolRows.reduce((sum, tool) => sum + tool.chars, 0);
    layers.push({
      id: 'tools',
      kind: 'tools',
      label: `Tool definitions (${toolRows.length})`,
      note: 'Every tool\'s name, description and JSON schema is sent on each request. Skills that load on demand appear inside the `skill` tool\'s description, not as their own layer.',
      chars,
      estTokens: estimateTokens(chars),
    });
  }

  // Written once per run, before the stream, and only when something was
  // actually injected. A resumed run never re-derives injection, so it carries
  // the marker of the run that did.
  let correctionsMarker: CorrectionsPart | undefined;
  for (const part of parts) {
    if (part.type === 'corrections') {
      correctionsMarker = part;
      break;
    }
  }

  const task = message?.user.prompt.task ?? '';
  if (task.length > 0) {
    const cuts = findAppendedBlocks(task);
    const bodyEnd = cuts.length > 0 ? cuts[0]!.index : task.length;
    const body = task.slice(0, bodyEnd).trimEnd();

    if (body.length > 0) {
      layers.push(makeLayer('instructions', 'instructions', 'Agent instructions', body, {
        ...(session.agent.filePath ? { source: session.agent.filePath } : {}),
        note: 'The markdown body of the agent file, with ${root}/${agentDir}/${tmpDir} resolved.',
      }));
    }

    for (const [i, cut] of cuts.entries()) {
      const end = cuts[i + 1]?.index ?? task.length;
      const block = task.slice(cut.index, end).trimEnd();
      if (block.length === 0) continue;

      if (cut.kind === 'approval') {
        layers.push(makeLayer('approval', 'approval', 'Approval gate instructions', block, {
          note: 'Added because `approval:` is enabled in frontmatter. Explains the await_human contract.',
        }));
      } else if (cut.kind === 'skills') {
        layers.push(...splitSkillsBlock(block));
      } else {
        const counts = correctionCounts(block, correctionsMarker);
        layers.push(makeLayer('learnings', 'learnings', 'Recent corrections', block, {
          note: 'Added because `learning.apply` is on. Captured from earlier runs of this agent.',
          ...(counts ? { corrections: counts } : {}),
        }));
      }
    }
  }

  const userPrompt = message?.user.prompt.user;
  if (userPrompt && userPrompt.length > 0) {
    layers.push(makeLayer('prompt', 'prompt', 'Run prompt', userPrompt, {
      note: 'Passed in for this run specifically (CLI argument, schedule, or a resume).',
    }));
  }

  const totalChars = layers.reduce((sum, layer) => sum + layer.chars, 0);
  const fileReads = buildFileReads(parts);
  const fileReadChars = fileReads.reduce((sum, file) => sum + file.chars, 0);
  const tokens = message?.assistant.tokens;
  const context = message?.assistant.context;

  return {
    sessionId: session.id,
    ...(session.model ? { model: session.model } : {}),
    agent: {
      id: session.agent.id,
      name: session.agent.name,
      ...(session.agent.filePath ? { filePath: session.agent.filePath } : {}),
    },
    ...(typeof session.time?.created === 'number' ? { createdAt: session.time.created } : {}),
    layers,
    tools: toolRows,
    fileReads,
    traffic: (() => {
      const t = buildRunTraffic(parts);
      const toolResultChars = t.toolResults.reduce((sum, r) => sum + r.chars, 0);
      return {
        outputChars: t.outputChars,
        outputEstTokens: estimateTokens(t.outputChars),
        toolResultChars,
        toolResultEstTokens: estimateTokens(toolResultChars),
        toolResults: t.toolResults,
      };
    })(),
    totals: {
      chars: totalChars,
      estTokens: estimateTokens(totalChars),
      withFileReadsEstTokens: estimateTokens(totalChars + fileReadChars),
    },
    ...(tokens
      ? {
          measured: {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cacheRead: tokens.cache.read,
            cacheWrite: tokens.cache.write,
            ...(context ? { context } : {}),
          },
        }
      : {}),
    ...(context?.compacted ? { compacted: true } : {}),
  };
}
