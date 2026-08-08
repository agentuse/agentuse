import { completeText } from '../complete-text';
import type { AgentCompleteEvent, ToolCallTrace } from '../plugin/types';
import type { ApprovalReview, Learning, LearningCategory, LearningDraft, LearningSource } from './types';
import { logger } from '../utils/logger';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic';
import { LEARNED_BLOCK_END, LEARNED_BLOCK_START } from './graduate';

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
Read the list above as one ruleset the agent must obey ALL of at once, and check your learning against it:
- Does it say the same thing as an existing rule, in better words? Return it with "supersedes" set to that rule's id.
- Does it CONTRADICT an existing rule, or narrow it so far the two cannot both be satisfied? That is the most important case and the easiest to miss — two rules can collide while sharing no wording at all. Return ONE rule that resolves the collision, with "supersedes" set to the rule it replaces.
- Is it genuinely about something no existing rule covers? Add it.${full ? `

The set is FULL (${active.length}/${cap}), so there is no free slot and EVERY learning you return must set "supersedes" to the id of the rule it takes the place of. This applies to reviewer-sourced learnings too — a correction that arrives with nowhere to go is the reason agents end up carrying dozens of rules none of which reach them.

Pick the id this way:
- A rule about the same subject? Name it, and write ONE rule that satisfies both. The point is to combine them, not to pick a winner: if the old rule constrains a case yours does not mention, your wording has to carry that case too, or it is lost.
- Nothing related? Name the LEAST valuable rule in the list and trade against it.

Never widen or weaken a reviewer's correction to make a merge read more smoothly. If two rules genuinely cannot be expressed as one without losing a constraint, say so by returning the sharper of the two as a replacement for the weaker.` : ''}`);

  return `\n${sections.join('\n\n')}\n`;
}

const LEARNING_CATEGORIES: LearningCategory[] = ['tip', 'warning', 'pattern', 'tool-usage', 'error-fix'];

/**
 * Turn a human "remember this" note into ONE additional instruction to append to
 * the agent's own instructions — the same thing a learning already is when
 * {@link buildLearningPrompt} injects it under "## Learned Guidelines".
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
Check the reviewer's note against these, as one ruleset the agent must obey all at once:
- Says the same thing as one of them, in better words? Return it with "supersedes" set to that rule's id.
- CONTRADICTS one, or narrows it so the two cannot both be followed? That is the most important case and the easiest to miss, because two rules can collide while sharing no wording at all. Return ONE rule that satisfies the reviewer's note AND carries whatever the old rule still gets right, with "supersedes" set to its id.
- Genuinely new ground? Leave "supersedes" out.${full ? `

The set is FULL, so there is no free slot: you MUST set "supersedes" to the id of the rule this note replaces. If nothing is related, name the least valuable rule in the list.` : ''}
${existing.map((l) => `- (id ${l.id}) [${l.category}] ${l.title}: ${trunc(l.instruction, 300)}`).join('\n')}`
    : '';

  const prompt = `A human reviewer, after seeing this run, wants to teach the agent so future runs go better. Turn their note into ONE additional instruction to APPEND to the agent's instructions.${instructionsBlock}${runBlock}${existingBlock}

## Reviewer's note
${note}

Write the additional instruction that, appended to the agent's instructions, would prevent the issue the note points at from happening again.
Requirements:
- Preserve the reviewer's intent EXACTLY. Do not add, weaken, or invent constraints.
- It must read as a natural extension of the agent's instructions (same voice), complement them, and NOT contradict or duplicate them.
- Ground it in what actually happened this run — target the real cause (the output, the process, or how a tool was used), not a surface reword of the note.
- Be specific and directly actionable. Do NOT decide whether it is worth keeping — always produce an instruction.
- Set "supersedes" per the rules above when this note replaces one the agent already carries. Superseding is combining, not choosing: the reviewer's intent wins outright, but anything the old rule constrained that the note does not contradict must survive into your wording.

Pick the best category: tip | warning | pattern | tool-usage | error-fix.
Respond with ONLY a JSON object, no other text ("supersedes" is optional):
{"category": "tip", "title": "short title (max 6 words)", "instruction": "the additional instruction", "supersedes": "id of the rule this replaces"}`;

  const instructions = isAnthropicModel(agentModel)
    ? ANTHROPIC_IDENTITY_PROMPT
    : 'You turn a human note into one concise additional agent instruction, grounded in the run, and reply with a JSON object only.';

  const responseText = await completeText(agentModel, { instructions, prompt });
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
 * Render reviewer feedback (resolved approval-gate comments + the work shown at
 * each gate) for the prompt. Indents the work so the model can tell comment from
 * artifact. Empty string when the run had no commented gates.
 */
function formatReviews(reviews: ApprovalReview[]): string {
  if (reviews.length === 0) return '';
  const blocks = reviews.map((r, idx) => {
    const work = r.work
      ? `\n   Work the reviewer was looking at:\n${r.work.split('\n').map(line => `   | ${line}`).join('\n')}`
      : '';
    return `${idx + 1}. Reviewer comment: ${r.comment}${work}`;
  });
  return blocks.join('\n\n');
}

/**
 * Evaluate a completed run and extract high-signal learnings from BOTH the
 * execution itself and any reviewer feedback left at approval gates, in a single
 * pass. Execution-derived learnings are tagged source="auto"; learnings that
 * capture the durable principle behind a reviewer comment are tagged
 * source="approval" (higher trust, ranked first when applied).
 */
export async function evaluateExecution(
  event: AgentCompleteEvent,
  agentInstructions: string,
  agentModel: string,
  criteria: string | undefined,
  existingLearnings: Learning[] = [],
  reviews: ApprovalReview[] = [],
  capacity?: { cap: number },
): Promise<LearningDraft[]> {
  const customCriteria = criteria
    ? `\n\nAdditional evaluation criteria:\n${criteria}`
    : '';

  // Truncate console output to avoid context bloat
  // Keep first 2000 and last 1000 chars for better context
  let consoleOutput = event.consoleOutput;
  if (consoleOutput.length > 5000) {
    const first = consoleOutput.slice(0, 2000);
    const last = consoleOutput.slice(-1000);
    consoleOutput = `${first}\n\n...(${consoleOutput.length - 3000} chars truncated)...\n\n${last}`;
  }

  // The permanent rules are excised and shown in full, separately from the
  // truncated body.
  //
  // They live in a block appended to the END of the agent file, and the body is
  // cut at 3000 characters, so on any real agent the block fell outside the cut
  // and this pass never saw it. Measured on one: 46,063-character file, block
  // starting at 30,685. That blindness is the only reason a duplicate copy of
  // every permanent rule had to be kept in the store and passed in alongside —
  // and a stored duplicate is what let a human's edits to the block be
  // overwritten. Reading the file fixes both.
  const blockStart = agentInstructions.indexOf(LEARNED_BLOCK_START);
  const blockEnd = agentInstructions.indexOf(LEARNED_BLOCK_END);
  const hasBlock = blockStart !== -1 && blockEnd > blockStart;
  const permanentText = hasBlock
    ? agentInstructions.slice(blockStart + LEARNED_BLOCK_START.length, blockEnd).trim()
    : '';
  const bodyOnly = hasBlock
    ? `${agentInstructions.slice(0, blockStart)}${agentInstructions.slice(blockEnd + LEARNED_BLOCK_END.length)}`
    : agentInstructions;
  const truncatedInstructions = bodyOnly.length > 3000
    ? bodyOnly.slice(0, 3000) + '\n...(truncated)'
    : bodyOnly;

  const hasReviews = reviews.length > 0;
  const reviewerSection = hasReviews
    ? `

## Reviewer Feedback (highest-signal — a human reviewed this run)
${formatReviews(reviews)}`
    : '';

  const prompt = `You are evaluating a completed agent run to extract learnings for future runs. Two sources of signal: the execution itself, and any human reviewer feedback left at approval gates.

## Agent Instructions
${truncatedInstructions}

## Execution Results
- Duration: ${event.result.duration.toFixed(2)}s
- Tool Calls: ${event.result.toolCalls}
- Finish Reason: ${event.result.finishReason || 'unknown'}

## Tool Calls (with inputs and outputs)
${formatToolCalls(event.result.toolCallTraces)}

## Console Output (logs and additional output)
${consoleOutput || '(No console output)'}

## Agent Text Output
${event.result.text || '(No text output)'}${reviewerSection}
${customCriteria}
${formatRulesInForce(existingLearnings, permanentText, capacity?.cap ?? existingLearnings.length)}

## Task
Extract actionable learnings that would improve future runs. Each learning is tagged with a "source":

- source "approval" — the durable principle behind a REVIEWER COMMENT above. Reviewer comments are the highest-signal feedback this agent gets; treat them as authoritative. Comments often point at the work ("this is too long", "cite a source here", "tone is off"): use the work shown to understand what they mean, then extract the GENERAL rule behind it. A comment about this run's specific content STILL counts if a reusable rule sits behind it (e.g. "this intro is too salesy" → "Keep intros factual; avoid promotional language"). ONLY skip a comment that is a pure one-off edit with nothing generalizable ("fix the typo in paragraph 2", "change the date to Tuesday").
- source "auto" — a learning from the EXECUTION. Ground it in the ACTUAL tool outputs and agent output above (an empty result, an error shape, a format a tool returned), not just which tools were called.

Rules:
- Extract 0-5 learnings MAXIMUM. Prefer fewer, higher-quality learnings. Capture every durable reviewer principle, but be sparing with "auto" learnings.
- If nothing is worth keeping, return an empty array []
- For "auto" learnings, only include ones you're confident about (confidence ≥ 0.8). For "approval" learnings, set confidence to 0.95.
- Each learning must be a clear, specific, output-grounded instruction (not a restatement of the comment).
- Keep each instruction under ${MAX_INSTRUCTION_CHARS} characters. A rule too long to hold beside the others cannot be checked against them.
- Avoid generic or obvious learnings that wouldn't add value.
- Set "supersedes" to an existing rule's id whenever your learning restates, sharpens, or collides with that rule (see "Before You Add Anything" above). Omit it only for a learning that genuinely covers new ground.

Categories:
- tip: Positive guidance ("Do X for better results")
- warning: Things to avoid ("Don't do Y because...")
- pattern: Reusable approach ("When X happens, do Y")
- tool-usage: Tool-specific guidance
- error-fix: Error recovery patterns

Respond with ONLY a JSON array of learnings. No other text.
Example format ("supersedes" is optional and names the id of the rule this one replaces):
[
  {"source": "approval", "category": "warning", "title": "Short title", "instruction": "Detailed instruction", "confidence": 0.95, "supersedes": "a1b2c3d4"},
  {"source": "auto", "category": "tip", "title": "Short title", "instruction": "Detailed instruction", "confidence": 0.9}
]

If no learnings are applicable, respond with an empty array: []`;

  // Use completeText (streaming) so this works on the ChatGPT Codex backend,
  // which rejects the non-streaming generateText() path and silently 400s the
  // moment a Codex-authed user triggers learning. For Anthropic OAuth the Claude
  // Code identity prompt must be the system prompt; other providers get a short
  // evaluator role (which also becomes Codex's required `instructions`).
  const instructions = isAnthropicModel(agentModel)
    ? ANTHROPIC_IDENTITY_PROMPT
    : 'You extract concise, high-signal learnings from an agent run and its reviewer feedback, and reply with a JSON array only.';

  const responseText = await completeText(agentModel, {
    instructions,
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
    // The model can only claim "approval" provenance when a reviewer actually
    // commented; otherwise everything is execution-derived. Human-sourced
    // learnings are trusted at a fixed high confidence and bypass the auto
    // confidence floor; execution learnings keep the ≥0.8 filter.
    const source: LearningSource = hasReviews && l.source === 'approval' ? 'approval' : 'auto';
    if (source === 'auto' && !(l.confidence >= 0.8)) continue;
    const supersedes = typeof l.supersedes === 'string' && revisable.has(l.supersedes)
      ? l.supersedes
      : undefined;
    learnings.push({
      category: l.category as LearningCategory,
      title: l.title,
      instruction: l.instruction,
      confidence: source === 'approval' ? 0.95 : l.confidence,
      id: Math.random().toString(36).slice(2, 10),
      appliedCount: 0,
      extractedAt: now,
      source,
      reasserted: 0,
      approvedRuns: 0,
      ...(supersedes ? { supersedes } : {}),
    });
  }
  return learnings;
}
