import { useState } from 'preact/hooks';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';
import { shortenCommand } from '../lib/shorten-command';
import { formatTokens } from '../lib/format';
import { toolChipLabel } from './log-entry';
import type { SessionContextPayload } from '../../types';

/** How much of each list the prompt carries. A coding agent needs the shape of
 *  the problem and the worst offenders, not the whole diagnostic page. */
const TOP_LAYERS = 6;
const TOP_FILES = 6;
const TOP_TOOLS = 5;
const TOP_CALLS = 3;

/** Estimates, always marked as such, so nobody quotes them as measurements. */
function tokens(value: number): string {
  return `~${formatTokens(value)}`;
}

/**
 * The prompt a coding agent receives when the operator wants this run to cost
 * less. Unlike the debug prompt, which points at the session log and lets the
 * agent go looking, this one carries the measurements inline: the split between
 * the opening prompt and what the run added, then the heaviest layers, files,
 * and individual tool calls. Those numbers are the whole diagnosis, and an
 * agent that has them can propose real cuts on the first turn instead of
 * spending several re-deriving them.
 */
export function buildTokenTuningPrompt(ctx: SessionContextPayload, detail = ''): string {
  const lines: string[] = [];

  lines.push('Help me cut the token usage of this AgentUse agent without losing what it does.');
  lines.push('');
  lines.push('Use the `/agentuse` skill for AgentUse commands and workflows.');
  lines.push('Before editing any `.agentuse` file, run:');
  lines.push('  agentuse skills get core --full');
  lines.push('  agentuse skills get creator --full');
  lines.push('After editing, run `agentuse doctor <agent-file>`.');
  lines.push('');

  lines.push('Run:');
  lines.push(`- Session ID: ${ctx.sessionId}`);
  lines.push(`- Agent: ${ctx.agent.name}${ctx.agent.filePath ? ` (${ctx.agent.filePath})` : ''}`);
  if (ctx.model) lines.push(`- Model: ${ctx.model}`);
  const measured = ctx.measured;
  if (measured && measured.input > 0) {
    const cached = measured.cacheRead > 0 ? `, ${measured.cacheRead.toLocaleString()} cached` : '';
    lines.push(
      `- Provider-reported: ${measured.input.toLocaleString()} input tokens${cached}` +
      `, ${measured.output.toLocaleString()} output`
    );
  }
  const usage = measured?.context;
  if (usage?.contextLimit !== undefined) {
    lines.push(
      `- Peak window: ${usage.usagePercentage.toFixed(1)}% of ${formatTokens(usage.contextLimit)}`
    );
  }
  if (ctx.compacted) {
    lines.push('- This run compacted its context, so it outgrew the window at least once.');
  }
  lines.push('');

  // The split first: it decides which half of the problem is worth working on.
  // A bloated opening prompt and a chatty run are fixed by different edits.
  const fileTokens = ctx.fileReads.reduce((sum, f) => sum + f.estTokens, 0);
  const openingTokens = ctx.totals.estTokens;
  const runTokens = fileTokens + ctx.traffic.toolResultEstTokens + ctx.traffic.outputEstTokens;
  const total = openingTokens + runTokens;
  const pct = (value: number) => (total > 0 ? ` (${Math.round((value / total) * 100)}%)` : '');

  lines.push('Where the tokens went (estimated at 4 characters per token):');
  lines.push(`- Opening prompt: ${tokens(openingTokens)}${pct(openingTokens)}`);
  lines.push(`- Added by the run: ${tokens(runTokens)}${pct(runTokens)}`);
  if (fileTokens > 0) lines.push(`  - files read: ${tokens(fileTokens)}`);
  if (ctx.traffic.toolResultEstTokens > 0) {
    lines.push(`  - tool results: ${tokens(ctx.traffic.toolResultEstTokens)}`);
  }
  if (ctx.traffic.outputEstTokens > 0) {
    lines.push(`  - model output (replies, reasoning, tool arguments): ${tokens(ctx.traffic.outputEstTokens)}`);
  }
  lines.push('');

  const layers = [...ctx.layers].sort((a, b) => b.estTokens - a.estTokens).slice(0, TOP_LAYERS);
  if (layers.length > 0) {
    lines.push('Heaviest parts of the opening prompt:');
    for (const layer of layers) {
      const source = layer.source ? ` — ${layer.source}` : '';
      lines.push(`- ${layer.label} [${layer.kind}]${source} — ${tokens(layer.estTokens)}`);
    }
    // The tool catalog is one line above but is really N tools, and trimming it
    // means naming which ones to drop.
    const catalog = ctx.layers.find((l) => l.kind === 'tools');
    const heavyTools = [...ctx.tools].sort((a, b) => b.estTokens - a.estTokens).slice(0, TOP_TOOLS);
    if (catalog && heavyTools.length > 0) {
      lines.push(`  Biggest tool definitions, of ${ctx.tools.length} in the catalog:`);
      for (const tool of heavyTools) {
        lines.push(`  - ${tool.name} — ${tokens(tool.estTokens)}`);
      }
    }
    lines.push('');
  }

  const files = ctx.fileReads.slice(0, TOP_FILES);
  if (files.length > 0) {
    lines.push(`Files read into context (${ctx.fileReads.length} total, heaviest first):`);
    for (const file of files) {
      const repeat = file.reads > 1 ? ` — read ${file.reads}× (each read costs again)` : '';
      lines.push(`- ${file.path} — ${tokens(file.estTokens)}${repeat}`);
    }
    lines.push('');
  }

  const results = ctx.traffic.toolResults.filter((r) => !r.countedAsFiles).slice(0, TOP_TOOLS);
  if (results.length > 0) {
    lines.push('Heaviest tool results, with the individual calls behind them:');
    for (const stat of results) {
      const totalCalls = stat.calls + stat.failed + stat.pending;
      const failed = stat.failed > 0 ? `, ${stat.failed} failed` : '';
      lines.push(
        `- ${toolChipLabel(stat.tool)} — ${totalCalls} call${totalCalls === 1 ? '' : 's'}${failed}` +
        ` — ${tokens(stat.estTokens)}`
      );
      for (const call of (stat.callDetails ?? []).slice(0, TOP_CALLS)) {
        if (call.status !== 'ok') continue;
        lines.push(`  - ${tokens(call.estTokens)}: ${shortenCommand(call.label, 3, 160)}`);
      }
    }
    lines.push('');
  }

  lines.push('See the numbers yourself:');
  lines.push(`  agentuse sessions show ${ctx.sessionId} --full`);
  lines.push('');
  lines.push(
    'Work out where this run is actually wasting context, then propose specific edits. ' +
    'Things worth checking: tools the agent never calls but still pays for in the catalog, ' +
    'the same file read more than once, reads that pull a whole file when a range would do, ' +
    'skills or instructions that could be shorter without losing behaviour, and tool calls ' +
    'whose output could be narrowed at the source rather than filtered afterwards.'
  );
  lines.push('');
  lines.push(
    'For each change, tell me roughly what it saves and what it risks. Say so if a heavy ' +
    'part is earning its tokens and should be left alone — I want a shorter run, not a worse one.'
  );

  if (detail.trim()) {
    lines.push('');
    lines.push(`Focus on: ${detail.trim()}`);
  }

  return lines.join('\n');
}

/**
 * Opens the shared "Send to Coding Agent" dialog with the token-tuning prompt
 * for this run. Sits on the diagnostic page, where the numbers it embeds are
 * the same ones on screen.
 */
export function TokenPromptButton(props: { context: SessionContextPayload }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        class="debug-prompt-button"
        onClick={() => setOpen(true)}
        title="Hand these numbers to a coding agent (Claude Code, Codex…) to cut the run's token usage"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 20V10" />
          <path d="M10 20V4" />
          <path d="M16 20v-6" />
          <path d="M22 20H2" />
        </svg>
        <span>Send to Coding Agent…</span>
      </button>
      <SendToCodingAgentDialog
        open={open}
        buildPrompt={(detail) => buildTokenTuningPrompt(props.context, detail)}
        detailLabel="Give the agent more detail on what to tune"
        placeholder="e.g. keep the research step, just stop it re-reading the same files"
        onClose={() => setOpen(false)}
      />
    </>
  );
}
