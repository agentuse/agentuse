/**
 * `capture.agent` — an .agentuse file replaces the built-in evaluator for
 * free-form observation capture, the same pattern as `verify.judge`.
 *
 * Replacing the evaluator does not buy a bypass: everything the capture agent
 * returns still passes the common vet, provenance stamping, and lifecycle
 * validation in extractLearnings. Deliberate human learning stays on the
 * Learn/--remember path and never depends on a user-supplied agent behaving.
 *
 * The built-in evaluator remains the default because capture runs after every
 * run: one cheap helper call, not a full subagent session spawned as a shadow
 * child of every run in the fleet.
 */

import { dirname, resolve } from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { parseAgent } from '../parser.js';
import { connectMCP, type MCPServersConfig } from '../mcp.js';
import { executeAgentCore } from '../runner/execution.js';
import { processAgentStream } from '../runner/stream.js';
import { loadAgentTools, type LoadedAgentTools } from '../runner/tools-loader.js';
import { buildSystemMessages } from '../runner/system-messages.js';
import { DoomLoopDetector } from '../tools/index.js';
import { resolveMaxSteps } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { AgentCompleteEvent } from '../plugin/types.js';
import type { Learning, LearningCategory, LearningDraft } from './types.js';
import { renderRunEvidence } from './evaluator.js';
import { generateLearningId } from './store.js';

const LEARNING_CATEGORIES = ['tip', 'warning', 'pattern', 'tool-usage', 'error-fix'] as const;

const SubmitLearningsSchema = z.object({
  learnings: z.array(z.object({
    category: z.enum(LEARNING_CATEGORIES).describe('The kind of learning'),
    title: z.string().min(1).describe('Short title (max 6 words)'),
    instruction: z.string().min(1).describe('Contextual guidance with its trigger where needed — a few sentences, never a document'),
    confidence: z.number().min(0).max(1).optional().describe('How confident you are this is durable, correctly scoped guidance (default 0.8)'),
    supersedes: z.string().optional().describe('Id of an existing active rule this one replaces (fold or trade), from the list in your task'),
  })).max(5).describe('0-5 candidate learnings; prefer fewer, higher-quality ones'),
});

/**
 * Run the capture agent over a completed run and return its candidates as
 * drafts (channel "agent", source "auto"). Throws on any execution failure so
 * the caller can surface a failed-capture marker instead of a silent no-op.
 */
export async function captureViaAgent(params: {
  event: AgentCompleteEvent;
  /** Path from `capture.agent`, resolved relative to the capturing agent's file. */
  captureAgentPath: string;
  agentFilePath: string;
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string } | undefined;
  /** Rules already in force, with ids, so the capture agent can reconcile. */
  existingLearnings: Learning[];
  cap: number;
}): Promise<LearningDraft[]> {
  const { event, captureAgentPath, agentFilePath, projectContext, existingLearnings, cap } = params;

  const resolvedPath = resolve(dirname(agentFilePath), captureAgentPath);
  const captureAgent = await parseAgent(resolvedPath);
  // A capture agent that itself captures or verifies would recurse a helper
  // pass into a tree of them; strip both, the same way verify strips nested
  // verify config off a judge.
  if (captureAgent.config.learning) {
    logger.debug(`[Learning] Ignoring nested learning config on capture agent ${captureAgent.name}`);
    delete captureAgent.config.learning;
  }
  if (captureAgent.config.verify) {
    logger.debug(`[Learning] Ignoring nested verify config on capture agent ${captureAgent.name}`);
    delete captureAgent.config.verify;
  }

  const captureDir = dirname(resolvedPath);
  let mcpConnections: Awaited<ReturnType<typeof connectMCP>> = [];
  let loadedTools: LoadedAgentTools | undefined;

  try {
    mcpConnections = captureAgent.config.mcpServers
      ? await connectMCP(
          captureAgent.config.mcpServers as MCPServersConfig,
          false,
          captureDir,
          projectContext?.cwd
        )
      : [];
    loadedTools = await loadAgentTools({
      agent: captureAgent,
      projectContext,
      agentDir: captureDir,
      agentFilePath: resolvedPath,
      mcpConnections,
      logPrefix: '[Learning] ',
    });
    const systemMessagesResult = await buildSystemMessages({
      agent: captureAgent,
      isSubAgent: true,
      agentFilePath: resolvedPath,
      projectRoot: projectContext?.projectRoot,
      stateRoot: projectContext?.stateRoot,
    });

    const existingBlock = existingLearnings.length > 0
      ? `\n\n## Learnings the agent already carries (${existingLearnings.length}/${cap} slots used)\nTreat these as contextual guidance. Do not restate one for the same situation; to replace one, set "supersedes" to its id. Guidance for a different situation may coexist.\n${existingLearnings
          .map((l) => `- (id ${l.id}) [${l.category}] ${l.title}: ${l.instruction.slice(0, 200)}`)
          .join('\n')}`
      : '';

    const captureTask = `A run of the agent "${event.agent.name}" just completed. Evaluate it per your own instructions and record the durable learnings future runs should carry.

${renderRunEvidence(event)}${existingBlock}

## Recording your result (required)
Call the \`submit_learnings\` tool exactly once with 0-5 candidate learnings (an empty list is a fine answer). Each learning is concise, appropriately scoped guidance for a similar future situation. Include the trigger when it is not universal; never return a document or a retelling of what happened. Your candidates will be vetted against the agent's own instructions before any of them takes effect.`;

    // The candidates arrive as validated tool args, not scraped prose — the
    // same reason verify's judge uses submit_verdict.
    let submitted: z.infer<typeof SubmitLearningsSchema> | undefined;
    const submitLearningsTool = tool({
      description: 'Record your candidate learnings and end the evaluation. Call this exactly once; an empty list means nothing durable was worth keeping.',
      inputSchema: SubmitLearningsSchema,
      execute: async (input: z.infer<typeof SubmitLearningsSchema>) => {
        submitted = input;
        return { recorded: true, count: input.learnings.length };
      },
    });
    const captureTools = { ...loadedTools.all, submit_learnings: submitLearningsTool };

    const result = await processAgentStream(
      executeAgentCore(captureAgent, captureTools, {
        userMessage: `${captureAgent.instructions}\n\n${captureTask}`,
        cacheableUserMessage: captureAgent.instructions,
        systemMessages: systemMessagesResult.messages,
        maxSteps: resolveMaxSteps(undefined, captureAgent.config.maxSteps),
        subAgentNames: new Set<string>(),
      }),
      {
        collectToolCalls: true,
        logPrefix: '[Learning] ',
        doomLoopDetector: new DoomLoopDetector({ threshold: 3, action: 'error' }),
        quiet: true,
      },
    );

    if (result.suspended) {
      throw new Error(`capture agent ${captureAgent.name} suspended on an approval gate; capture agents cannot suspend`);
    }
    if (!submitted) {
      throw new Error(`capture agent ${captureAgent.name} did not call submit_learnings`);
    }

    const now = new Date().toISOString();
    const revisable = new Set(existingLearnings.map((l) => l.id));
    const drafts: LearningDraft[] = [];
    for (const l of submitted.learnings) {
      const supersedes = l.supersedes && revisable.has(l.supersedes) ? l.supersedes : undefined;
      drafts.push({
        id: generateLearningId(drafts.map((d) => d.id)),
        category: l.category as LearningCategory,
        title: l.title,
        instruction: l.instruction,
        confidence: l.confidence ?? 0.8,
        injectedCount: 0,
        extractedAt: now,
        source: 'auto',
        channel: 'agent',
        reasserted: 0,
        approvedRuns: 0,
        ...(supersedes ? { supersedes } : {}),
      });
    }
    return drafts;
  } finally {
    try { await loadedTools?.sandboxInstance?.kill(); } catch { /* best-effort cleanup */ }
    try { await loadedTools?.store?.releaseLock(); } catch { /* best-effort cleanup */ }
    for (const conn of mcpConnections) {
      try { await conn.client.close(); } catch { /* best-effort cleanup */ }
    }
  }
}
