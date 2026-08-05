import { ANTHROPIC_IDENTITY_PROMPT } from '../../utils/anthropic';
import type { Message, SessionInfo, ToolsSnapshot } from '../../session/types';
import type { ContextStackLayer, ContextToolRow, SessionContextPayload } from './types';

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

function makeLayer(
  kind: ContextStackLayer['kind'],
  id: string,
  label: string,
  text: string,
  extra: { source?: string; note?: string } = {}
): ContextStackLayer {
  return {
    id,
    kind,
    label,
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    chars: text.length,
    estTokens: estimateTokens(text.length),
    text,
  };
}

/**
 * Name a system message by its opening. These are the four the runtime can
 * emit (identity, core, manager, sandbox); anything unrecognised still gets a
 * layer, just a generic label.
 */
function describeSystemMessage(content: string, index: number): { label: string; note?: string } {
  if (content.startsWith(ANTHROPIC_IDENTITY_PROMPT)) {
    return { label: 'Anthropic identity', note: 'Prepended automatically for Anthropic models.' };
  }
  if (content.startsWith('You are an autonomous AI agent')) {
    return { label: 'AgentUse core instructions', note: 'Built in. Output style, tool discipline, and the report_complete contract.' };
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
}): SessionContextPayload {
  const { session, message, tools } = options;
  const layers: ContextStackLayer[] = [];

  for (const [i, content] of (message?.assistant.system ?? []).entries()) {
    const { label, note } = describeSystemMessage(content, i);
    layers.push(makeLayer('system', `system-${i}`, label, content, {
      ...(note ? { note } : {}),
    }));
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
        layers.push(makeLayer('learnings', 'learnings', 'Recent corrections', block, {
          note: 'Added because `learning.apply` is on. Captured from earlier runs of this agent.',
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
    totals: { chars: totalChars, estTokens: estimateTokens(totalChars) },
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
