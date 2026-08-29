import { completeText } from '../complete-text';
import type { AgentCompleteEvent, ToolCallTrace } from '../plugin/types';
import type { Learning, LearningCategory, LearningDraft } from './types';
import { logger } from '../utils/logger';
import { helperSystemPrompt } from '../utils/anthropic';
import { splitInstructions } from './contract';
import { generateLearningId } from './store';

/**
 * Stringify a tool input/output value for the evaluator, truncated to keep the
 * prompt bounded. Objects are JSON-encoded; strings pass through as-is so a tool
 * that already returns text isn't double-quoted.
 */
function formatTraceValue(value: unknown, limit: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return '';
  return str.length > limit ? `${str.slice(0, limit)}...` : str;
}

/**
 * Format tool calls with inputs AND outputs for evaluation. The output is what
 * makes a learning concrete ("when tool X returns Y, do Z"), so we surface it
 * alongside the input rather than relying on the raw console dump. Both are
 * truncated to avoid context bloat.
 */
function formatToolCalls(traces: ToolCallTrace[] | undefined): string {
  if (!traces || traces.length === 0) return 'No tool calls';

  return traces.map(t => {
    const status = t.success ? '✓' : '✗';
    const inputStr = t.input !== undefined
      ? `\n    Input: ${formatTraceValue(t.input, 500)}`
      : '';
    const outputStr = t.output !== undefined
      ? `\n    Output: ${formatTraceValue(t.output, 800)}`
      : '';
    return `- [${status}] ${t.name} (${t.duration}ms)${inputStr}${outputStr}`;
  }).join('\n');
}

interface RawLearning {
  category: 'tip' | 'warning' | 'pattern' | 'tool-usage' | 'error-fix';
  title: string;
  instruction: string;
  confidence: number;
  source?: 'auto' | 'approval';
  supersedes?: string;
}

/** The longest a captured rule may be. A rule the model cannot hold in view
 *  beside its peers cannot be compared against them, which is the one thing the
 *  reconcile step needs. Advisory in the prompt, not truncated in code: cutting
 *  an instruction mid-clause destroys the meaning the length was protecting. */
const MAX_INSTRUCTION_CHARS = 800;

/**
 * Render the rules the agent already carries, split by whether the evaluator is
 * allowed to touch them.
 *
 * Ids are shown for the revisable set and withheld from the permanent one. That
 * is the whole affordance: `supersedes` can only name something in the first
 * list, so listing the second without ids makes the illegal move unspeakable
 * rather than merely forbidden.
 */
function formatRulesInForce(active: Learning[], permanentText: string, cap: number): string {
  if (active.length === 0 && !permanentText) return '';

  const full = active.length >= cap;
  const sections: string[] = [];

  if (active.length > 0) {
    sections.push(`## Rules This Agent Already Carries (${active.length}/${cap} slots used)
These were in force during the run above, so the agent already had them. Every one can be revised, including rules that came from a reviewer: to replace one, return your learning with "supersedes" set to its id. Replacing is not discarding — the rule you name is archived, and your wording is expected to carry whatever it constrained.
${active.map(l => `- (id ${l.id}) [${l.category}] ${l.title}: ${l.instruction.slice(0, 200)}${l.instruction.length > 200 ? '...' : ''}`).join('\n')}`);
  }

  if (permanentText) {
    sections.push(`## Already Permanent (in the agent's own instructions)
These apply on every run and are NOT yours to revise — they live in the agent's own file, which only a human edits. Do not restate one, and do not return a learning that contradicts one; if this run makes you think one of them is wrong, say so in the instruction text rather than adding a rule that fights it.
${permanentText}`);
  }

  // The instruction that decides whether this list gets reconciled against or
  // merely deduped. "Do not duplicate" is a matching test, and it passes for two
  // rules that share no vocabulary and contradict each other outright — which is
  // exactly the failure this replaces: a rule listing forbidden shapes and a
  // rule requiring those shapes, captured weeks apart from separate rejections,
  // both scoring high, together leaving the agent no legal move.
  sections.push(`## Before You Add Anything
Read the list above as contextual guidance, not a checklist that applies to every run. Compare scope before comparing wording:
- Does it express the same guidance for the same situation, in better words? Return it with "supersedes" set to that learning's id.
- Does it contradict an existing learning WHEN BOTH APPLY TO THE SAME SITUATION? Return one scoped learning that resolves the collision, with "supersedes" set to the learning it replaces. Guidance for different situations may coexist even when its wording differs.
- Is it genuinely about a situation no existing learning covers? Add it.${full ? `

The set is FULL (${active.length}/${cap}), so there is no free slot and EVERY learning you return must set "supersedes" to the id of the learning it takes the place of. Automatic capture does not get a hidden extra slot; an appended learning that never reaches the agent has no value.

Pick the id this way:
- Guidance about the same situation? Name it, and write ONE scoped learning that preserves both intents.
- Nothing related? Name the LEAST valuable learning in the list and trade against it.

Never widen or weaken an existing human-authored learning to make a merge read more smoothly. Do not merge guidance whose trigger situations differ merely because the topics or vocabulary overlap.` : ''}`);

  return `\n${sections.join('\n\n')}\n`;
}

const LEARNING_CATEGORIES: LearningCategory[] = ['tip', 'warning', 'pattern', 'tool-usage', 'error-fix'];

/**
 * Turn a human "remember this" note into ONE contextual learning for future
 * runs. The human has already decided it should be remembered; this helper's
 * job is to preserve the intent while recovering the situation where it applies.
 *
 * This is grounded, not cosmetic: given the agent's current instructions and
 * what it actually did this run (the session transcript the reviewer saw), it
 * extracts the instruction that would close the gap the note points at — an
 * output issue, a process issue, or how a tool was used. It also sees the
 * already-saved instructions so it refines rather than duplicates.
 *
 * Unlike {@link evaluateExecution} it never JUDGES whether to keep the note (the
 * human opted in) — it always produces an instruction. Returns null on any model
 * or parse failure so the caller can store the note verbatim; a model hiccup
 * must never drop an explicit human instruction.
 */
export async function refineManualLearning(
  note: string,
  agentModel: string,
  context?: {
    agentInstructions?: string | undefined;
    sessionTranscript?: string | undefined;
    /** The rules this agent already carries, with ids, so the note can be
     *  reconciled against them instead of merely deduped. */
    existing?: Learning[] | undefined;
    /** How many rules the agent keeps. When the set is full the note has to
     *  replace one, exactly as a captured learning does. */
    cap?: number | undefined;
  },
): Promise<{ category: LearningCategory; title: string; instruction: string; supersedes?: string } | null> {
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n...(truncated)' : s);
  const instructionsBlock = context?.agentInstructions
    ? `\n\n## The agent's current instructions\n${trunc(context.agentInstructions, 2000)}`
    : '';
  const runBlock = context?.sessionTranscript
    ? `\n\n## What the agent actually did this run (what the reviewer was looking at)\n${trunc(context.sessionTranscript, 6000)}`
    : '';
  // Same reconcile contract as capture, for the same reason. A note typed with
  // --remember used to be shown the stored rules under "do not duplicate", which
  // is a matching test: it catches a restatement and is blind to a contradiction.
  // That is how a rule and the later note overruling it both survived, and the
  // manual path is the one people use precisely when they are correcting
  // something, so it is the LAST place that test belongs.
  const existing = (context?.existing ?? []).filter((l) => l.instruction?.trim());
  const cap = context?.cap;
  const full = cap !== undefined && existing.length >= cap;
  const existingBlock = existing.length > 0
    ? `\n\n## Rules this agent already carries${cap !== undefined ? ` (${existing.length}/${cap} slots used)` : ''}
Check the reviewer's note against these as contextual guidance:
- Says the same thing for the same situation, in better words? Return it with "supersedes" set to that learning's id.
- Contradicts one when both apply to the same situation? Return ONE scoped learning that preserves the reviewer's newer intent and whatever the older learning still gets right, with "supersedes" set to its id.
- Applies to a different situation? It may coexist; leave "supersedes" out.${full ? `

The set is FULL, so there is no free slot: you MUST set "supersedes" to the id of the learning this note replaces. If nothing is related, name the least valuable learning in the list.` : ''}
${existing.map((l) => `- (id ${l.id}) [${l.category}] ${l.title}: ${trunc(l.instruction, 300)}`).join('\n')}`
    : '';

  const prompt = `A human reviewer, after seeing this run, explicitly asked the agent to remember their comment. Turn it into ONE reusable learning for similar future situations.${instructionsBlock}${runBlock}${existingBlock}

## Reviewer's note
${note}

Write contextual guidance that would prevent the issue when a similar situation happens again.
Requirements:
- Preserve the reviewer's intent EXACTLY. Do not add, weaken, or invent constraints.
- Recover the trigger or situation where the guidance applies. Do not make it universal unless the reviewer explicitly made it universal.
- It must complement the agent's instructions and must not contradict or duplicate them.
- Ground it in what actually happened this run — target the real cause (the output, the process, or how a tool was used), not a surface reword of the note.
- Be specific and directly actionable. Do NOT decide whether it is worth keeping — always produce an instruction.
- Set "supersedes" per the rules above when this note replaces one the agent already carries. Superseding is combining, not choosing: the reviewer's intent wins outright, but anything the old rule constrained that the note does not contradict must survive into your wording.
- **Write concise guidance, not an explanation.** Prefer "When X, do Y" where scope matters. Use a few sentences under ${MAX_INSTRUCTION_CHARS} characters. State the behaviour and its trigger, not the incident that prompted it. Keep a threshold or the one example that defines the guidance; cut dates, ids, names and the quoted complaint. No preamble or justification.

Pick the best category: tip | warning | pattern | tool-usage | error-fix.
Respond with ONLY a JSON object, no other text ("supersedes" is optional):
{"category": "tip", "title": "short title (max 6 words)", "instruction": "the additional instruction", "supersedes": "id of the rule this replaces"}`;

  const system = helperSystemPrompt(
    agentModel,
    'You turn an explicitly saved human comment into concise, appropriately scoped guidance for similar future situations, grounded in the run, and reply with a JSON object only.',
  );

  const responseText = await completeText(agentModel, { ...system, prompt });
  try {
    const text = responseText.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const parsed = JSON.parse(jsonMatch[1] || text);
    const cleaned = typeof parsed?.instruction === 'string' ? parsed.instruction.trim() : '';
    if (!cleaned) return null;
    const category: LearningCategory = LEARNING_CATEGORIES.includes(parsed?.category) ? parsed.category : 'tip';
    const title = typeof parsed?.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : cleaned.split('\n')[0];
    // Only an id the model was actually shown may be superseded, so a
    // hallucinated one degrades to a plain insert rather than silently
    // retiring nothing while reporting a fold.
    const shown = new Set((context?.existing ?? []).map((l) => l.id));
    const supersedes = typeof parsed?.supersedes === 'string' && shown.has(parsed.supersedes)
      ? parsed.supersedes
      : undefined;
    return { category, title, instruction: cleaned, ...(supersedes ? { supersedes } : {}) };
  } catch {
    logger.debug(`[Learning] Failed to parse refined manual instruction: ${responseText.slice(0, 200)}`);
    return null;
  }
}

/**
 * Render the run itself — tool calls, console, output — as prompt evidence.
 * Shared by the built-in evaluator, the capture agent's task, and the vet's
 * grounding check, so all three judge the same record of what happened.
 */
export function renderRunEvidence(event: AgentCompleteEvent): string {
  // Truncate console output to avoid context bloat
  // Keep first 2000 and last 1000 chars for better context
  let consoleOutput = event.consoleOutput;
  if (consoleOutput.length > 5000) {
    const first = consoleOutput.slice(0, 2000);
    const last = consoleOutput.slice(-1000);
    consoleOutput = `${first}\n\n...(${consoleOutput.length - 3000} chars truncated)...\n\n${last}`;
  }

  return `## Execution Results
- Duration: ${event.result.duration.toFixed(2)}s
- Tool Calls: ${event.result.toolCalls}
- Finish Reason: ${event.result.finishReason || 'unknown'}

## Tool Calls (with inputs and outputs)
${formatToolCalls(event.result.toolCallTraces)}

## Console Output (logs and additional output)
${consoleOutput || '(No console output)'}

## Agent Text Output
${event.result.text || '(No text output)'}`;
}

export interface EvaluateExecutionOptions {
  event: AgentCompleteEvent;
  /** The COMPLETE effective agent instructions. Passed whole: the pre-0.19
   *  3,000-character body truncation blinded the evaluator to every rule past
   *  the cut on any real agent, which is how it "rediscovered" explicit
   *  contract rules as new learnings. */
  agentInstructions: string;
  model: string;
  /** Optional scope from `capture.custom`. Calling this evaluator is itself the
   * explicit opt-in to automatic execution observation. */
  freeform: { guidance?: string | undefined };
  existingLearnings?: Learning[];
  capacity?: { cap: number };
}

/**
 * Evaluate a completed run after the author explicitly enables automatic
 * free-form observation. Reviewer comments cannot enter through this API;
 * deliberate human learning uses `saveManualLearning` instead.
 */
export async function evaluateExecution(options: EvaluateExecutionOptions): Promise<LearningDraft[]> {
  const { event, agentInstructions, model, freeform } = options;
  const existingLearnings = options.existingLearnings ?? [];
  const capacity = options.capacity;

  const customCriteria = freeform.guidance
    ? `\n\nAdditional evaluation criteria (scope your execution-derived learnings to this):\n${freeform.guidance}`
    : '';

  // The permanent rules are excised and shown in full, separately from the
  // body — they live in a block appended to the END of the agent file, and
  // labeling them "already permanent" is what stops the evaluator restating
  // them. The body itself is passed COMPLETE: the old 3,000-character cut left
  // every later rule invisible (measured on one real agent: 46,063-character
  // file, block starting at 30,685), and an evaluator that cannot see the
  // contract cannot avoid duplicating or contradicting it.
  const { body: bodyOnly, permanentText } = splitInstructions(agentInstructions);

  const prompt = `You are evaluating a completed agent run to extract learnings for future runs. The agent author explicitly enabled automatic execution observation; reviewer comments are handled by a separate deliberate Learn path and are never inputs here.

## Agent Instructions
${bodyOnly.trim()}

${renderRunEvidence(event)}
${customCriteria}
${formatRulesInForce(existingLearnings, permanentText, capacity?.cap ?? existingLearnings.length)}

## Task
Extract actionable learnings that would improve future runs:

- source "auto" — a learning from the EXECUTION. Ground it in the ACTUAL tool outputs and agent output above (an empty result, an error shape, a format a tool returned), not just which tools were called.

Rules:
- Extract 0-5 learnings MAXIMUM. Prefer fewer, higher-quality learnings.
- If nothing is worth keeping, return an empty array []
- Only include learnings you're confident about (confidence ≥ 0.8).
- Each learning must be clear, specific, output-grounded guidance with an explicit trigger when it is not universal.
- Avoid generic or obvious learnings that wouldn't add value.
- Set "supersedes" to an existing rule's id whenever your learning restates, sharpens, or collides with that rule (see "Before You Add Anything" above). Omit it only for a learning that genuinely covers new ground.

## How to write the instruction

Write concise guidance, not an explanation. Prefer "When X, do Y" when the observation applies to one kind of situation. Keep it under ${MAX_INSTRUCTION_CHARS} characters, and usually far under.

- **One rule, one behaviour.** If the instruction needs headings, numbered sections, or the word "also", it is more than one rule. Return the most important one and drop the rest. A rule too long to hold beside the others cannot be checked against them, and a rule that is never checked is how two contradicting rules end up in force at once.
- **State the behaviour, not the incident.** "Cite the primary source, never a summary" is the rule. How it was discovered, who objected, which run it happened on, what the draft said instead, and how many attempts it took are not part of it. The agent reading this rule later was not there.
- **Keep only the specifics that change what the agent does**: a threshold, a trigger condition, an exception, or the single example that shows what the rule means in practice. Cut every other concrete detail. Dates, session ids, people's names and quoted complaints are almost never load-bearing.
- **No preamble, no justification.** Not "It is important to remember that..." — just the scoped guidance. The agent does not need to be sold on it.

If you cannot state it in a few sentences, you have not worked out what the rule is yet. Narrow it until you can.

Categories:
- tip: Positive guidance ("Do X for better results")
- warning: Things to avoid ("Don't do Y because...")
- pattern: Reusable approach ("When X happens, do Y")
- tool-usage: Tool-specific guidance
- error-fix: Error recovery patterns

Respond with ONLY a JSON array of learnings. No other text.
Example format ("supersedes" is optional and names the id of the rule this one replaces):
[
  {"source": "auto", "category": "tip", "title": "Short title", "instruction": "When the search tool returns no results, narrow the query before widening it.", "confidence": 0.9, "supersedes": "a1b2c3d4"}
]

If no learnings are applicable, respond with an empty array: []`;

  // Use completeText (streaming) so this works on the ChatGPT Codex backend,
  // which rejects the non-streaming generateText() path and silently 400s the
  // moment a Codex-authed user triggers learning. The role reaches Anthropic
  // models as a second system block rather than being dropped for the identity
  // line — see helperSystemPrompt.
  const system = helperSystemPrompt(
    model,
    'You extract concise, high-signal learnings from an agent run and reply with a JSON array only. Each learning is one instruction the agent can act on, stated in a sentence or two — never a document, and never a retelling of what happened.',
  );

  const responseText = await completeText(model, {
    ...system,
    prompt,
  });

  // Parse JSON from response
  let rawLearnings: RawLearning[] = [];
  try {
    const text = responseText.trim();
    // Handle markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonStr = jsonMatch[1] || text;
    rawLearnings = JSON.parse(jsonStr);
    if (!Array.isArray(rawLearnings)) {
      rawLearnings = [];
    }
  } catch (parseError) {
    logger.debug(`[Learning] Failed to parse response as JSON: ${responseText.slice(0, 200)}`);
    return [];
  }

  // Log raw learnings for debugging
  if (rawLearnings.length > 0) {
    logger.debug(`[Learning] Raw learnings: ${rawLearnings.map(l => `${l.title} (${l.source ?? 'auto'}, ${l.confidence})`).join(', ')}`);
  }

  // Only an id the model was actually shown can be superseded. A hallucinated or
  // stale id must fall through to the store's own capacity handling rather than
  // silently retiring nothing (a fold that quietly became an append is the exact
  // failure the reconcile step exists to prevent).
  const revisable = new Set(existingLearnings.map(l => l.id));

  const now = new Date().toISOString();
  const learnings: LearningDraft[] = [];
  for (const l of rawLearnings) {
    if (!l?.title || !l?.instruction || !l?.category) continue;
    // This API can only create execution-derived learnings. Model-authored
    // provenance cannot turn automatic observation into human teaching.
    if (!(l.confidence >= 0.8)) continue;
    const supersedes = typeof l.supersedes === 'string' && revisable.has(l.supersedes)
      ? l.supersedes
      : undefined;
    learnings.push({
      category: l.category as LearningCategory,
      title: l.title,
      instruction: l.instruction,
      confidence: l.confidence,
      // Collision-checked id, minted here so the vet can key its verdicts to
      // drafts before the store has seen them.
      id: generateLearningId(learnings.map((d) => d.id)),
      injectedCount: 0,
      extractedAt: now,
      source: 'auto',
      channel: 'custom',
      reasserted: 0,
      approvedRuns: 0,
      ...(supersedes ? { supersedes } : {}),
    });
  }
  return learnings;
}
