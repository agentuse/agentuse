import type { LanguageModelUsage } from 'ai';
import type { ToolCallTrace } from '../plugin/types';
import type { DoomLoopDetector } from '../tools/index.js';
import type { SessionManager } from '../session';
import type { AgentPart } from '../types/parts';
import type { ToolState, ToolStateCompleted, ToolStateError } from '../session/types';
import type { ActiveContextUsage } from '../session/types';
import { addLanguageModelUsage, usageToAssistantTokens, addAssistantTokens, type AssistantTokens } from '../session/usage';
import { repairEscapedText } from '../utils/display-text';
import { logger } from '../utils/logger';
import { safeHttpUrl } from '../utils/url';
import { formatToolResultForDisplay } from '../utils/format-tool-result';
import { sendSlackApprovalRequest, sendSlackApprovalRequestToThread } from '../slack/approval';
import type { AgentChunk } from './types';
import { SessionRecorder } from './session-recorder';
import { withoutToolIntent } from './tool-intent';
import { defaultTerminalPresenter, type TerminalPresenter } from './terminal-presenter';

type SlackRunChannelHandle = {
  channel: string;
  ts: string;
  channelId?: string;
  events?: Array<'approval' | 'completion' | 'failure'>;
};

async function announceApprovalRequested(options: {
  sessionId?: string;
  resumeToken?: string;
  approvalUrl?: string;
  prompt?: string;
}): Promise<void> {
  if (!options.sessionId || !options.resumeToken || !options.approvalUrl || typeof fetch !== 'function') return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    const url = new URL(options.approvalUrl);
    const project = url.searchParams.get('project') ?? undefined;
    // LEGACY ROUTE: canonical path is `/api/approvals/:id/requested`. Kept on the
    // legacy path for back-compat; switch here when the legacy routes are removed.
    url.pathname = `/approvals/${encodeURIComponent(options.sessionId)}/requested`;
    url.search = '';

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        resumeToken: options.resumeToken,
        approvalUrl: options.approvalUrl,
        ...(project && { project }),
        ...(options.prompt && { prompt: options.prompt })
      })
    });
    clearTimeout(timeout);
  } catch {
    // Approval execution must not fail just because serve is unavailable,
    // restarted, or running an older build without this endpoint.
  }
}

async function sendPersistedSlackApproval(options: {
  sessionId?: string;
  agentName?: string;
  resumeToken?: string;
  approvalUrl?: string;
  prompt?: string;
  input?: unknown;
  expiresAt?: number;
  channelRequest?: unknown;
  slackRunChannelHandles?: SlackRunChannelHandle[];
}): Promise<{ type: 'slack-message'; channel: string; ts: string; actionTs?: string; url: string } | undefined> {
  const request = options.channelRequest && typeof options.channelRequest === 'object'
    ? options.channelRequest as Record<string, unknown>
    : undefined;
  if (request?.type !== 'slack-message') return undefined;

  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = typeof request.channel === 'string' ? request.channel : process.env.SLACK_APPROVAL_CHANNEL;
  if (!botToken || !channelId || !options.sessionId || !options.resumeToken || !options.approvalUrl || !options.prompt) {
    logger.warn('Slack approval channel skipped: missing bot token, channel, session id, resume token, approval URL, or prompt');
    return undefined;
  }

  const input = options.input && typeof options.input === 'object'
    ? options.input as Record<string, unknown>
    : {};
  const draftUrl = safeHttpUrl(input.draft_url);
  const artifactUrl = safeHttpUrl(input.artifact_url);
  // Slack has no dedicated slot for the structured `changes` field, so surface
  // the verbatim actions at the top of the draft block the card already renders.
  const changesText = Array.isArray(input.changes)
    ? input.changes
      .map((entry) => {
        const rec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const content = typeof rec.content === 'string' ? repairEscapedText(rec.content.trim()) : '';
        if (!content) return '';
        const label = typeof rec.label === 'string' && rec.label.trim() ? `**${rec.label.trim()}**\n` : '';
        return `${label}${content}`;
      })
      .filter(Boolean)
      .join('\n\n')
    : '';
  // Options gates need a pick, which Slack's Approve/Reject buttons can't
  // express, so render the menu as text and route the decision to the web page.
  const optionEntries = Array.isArray(input.options)
    ? input.options
      .map((entry) => {
        const rec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const id = typeof rec.id === 'string' ? rec.id.trim() : '';
        const label = typeof rec.label === 'string' ? repairEscapedText(rec.label.trim()) : '';
        if (!id || !label) return '';
        const marker = rec.recommended === true ? ' (recommended)' : '';
        return `• ${label}${marker}`;
      })
      .filter(Boolean)
    : [];
  const optionsText = optionEntries.length >= 2
    ? `**Pick one on the approval page:**\n${optionEntries.join('\n')}`
    : '';
  const slackDraft = [optionsText, changesText, typeof input.draft === 'string' ? repairEscapedText(input.draft) : '']
    .filter(Boolean)
    .join('\n\n');
  try {
    const approvalRequest = {
      botToken,
      channelId,
      sessionId: options.sessionId,
      ...(process.env.AGENTUSE_PROJECT_ID && { projectId: process.env.AGENTUSE_PROJECT_ID }),
      ...(options.agentName && { agentName: options.agentName }),
      prompt: options.prompt,
      ...(typeof input.summary === 'string' && { summary: repairEscapedText(input.summary) }),
      ...(slackDraft && { draft: slackDraft }),
      ...(draftUrl && { draftUrl }),
      ...(artifactUrl && { artifactUrl }),
      ...(typeof input.context === 'string' && { context: repairEscapedText(input.context) }),
      ...(typeof input.risk === 'string' && { risk: repairEscapedText(input.risk) }),
      resumeToken: options.resumeToken,
      approvalUrl: options.approvalUrl,
      interactive: Boolean(process.env.SLACK_APP_TOKEN) && optionEntries.length < 2,
      ...(options.expiresAt !== undefined && { expiresAt: new Date(options.expiresAt).toISOString() })
    };
    const root = options.slackRunChannelHandles?.find((handle) =>
      handle.channel === channelId || handle.channelId === channelId || (handle.channelId === undefined && handle.channel === channelId)
    );
    const message = root
      ? await sendSlackApprovalRequestToThread(approvalRequest, root)
      : await sendSlackApprovalRequest(approvalRequest);

    return {
      type: 'slack-message',
      channel: message.channel,
      ts: message.ts,
      ...(message.actionTs && { actionTs: message.actionTs }),
      url: options.approvalUrl
    };
  } catch (err) {
    logger.warn(`Slack approval channel failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Process agent stream chunks and handle output/logging
 */
export async function processAgentStream(
  generator: AsyncGenerator<AgentChunk>,
  options?: {
    collectToolCalls?: boolean;
    logPrefix?: string;
    sessionManager?: SessionManager;
    sessionID?: string;
    messageID?: string;
    agentId?: string;
    /** Display name for Slack approval cards. */
    agentName?: string;
    doomLoopDetector?: DoomLoopDetector;
    slackRunChannelHandles?: SlackRunChannelHandle[];
    /** Cumulative tokens from prior invocations (resume); folded into usage writes. */
    priorTokens?: AssistantTokens;
    /** Suppress console output (for serve mode) */
    quiet?: boolean;
    /** Ephemeral renderer for normalized events; defaults to the CLI terminal. */
    terminalPresenter?: TerminalPresenter;
  }
): Promise<{
  text: string;
  usage?: LanguageModelUsage;
  usageKind?: 'cumulative';
  toolCalls?: Array<{ tool: string; args: unknown }>;
  subAgentTokens?: number;
  toolCallTraces?: ToolCallTrace[];
  finishReason?: string;
  finishReasons?: string[];
  hasTextOutput: boolean;
  suspended?: boolean;
  approvalUrl?: string;
  contextUsage?: ActiveContextUsage;
  parts: AgentPart[];
}> {
  let finalText = '';
  let usage: LanguageModelUsage | null = null;
  let usageKind: 'cumulative' | undefined;
  const toolCalls: Array<{ tool: string; args: unknown }> = [];
  let subAgentTokens = 0;
  const toolCallTraces: ToolCallTrace[] = [];
  const pendingToolCalls = new Map<string, { name: string; startTime: number; input?: unknown }>();
  const toolStates = new Map<string, ToolState>();
  const currentStepToolCallIds = new Set<string>();
  let currentLlmCall: { model: string; startTime: number; firstTokenTime?: number } | null = null;
  let llmSegmentCount = 0;
  let hasTextOutput = false;
  const finishReasons: string[] = [];
  const parts: AgentPart[] = [];
  let contextUsage: ActiveContextUsage | undefined;
  let suspended = false;
  let suspendApprovalUrl: string | undefined;
  let hasTextSinceLastToolCall = false;
  const recorder = new SessionRecorder(options);
  const terminal = options?.quiet ? undefined : (options?.terminalPresenter ?? defaultTerminalPresenter);

  // Tool results can arrive before the AI SDK emits finish-step usage. Keep the
  // latest full state in memory so the later usage update can enrich a completed,
  // failed, or suspended tool without losing its output or approval payload.
  const persistToolState = async (callID: string, nextState: ToolState): Promise<boolean> => {
    const previousMetadata = toolStates.get(callID)?.metadata;
    const metadata = { ...previousMetadata, ...nextState.metadata };
    const state = Object.keys(metadata).length > 0
      ? { ...nextState, metadata } as ToolState
      : nextState;
    toolStates.set(callID, state);
    return recorder.updateTool(callID, state);
  };

  const persistCurrentStepToolUsage = async (chunk: AgentChunk): Promise<void> => {
    if (chunk.usageKind !== 'step' || !chunk.usage || currentStepToolCallIds.size === 0) return;

    const callIDs = [...currentStepToolCallIds];
    const tokens = usageToAssistantTokens(chunk.usage);
    const modelStepUsage = {
      input: tokens.input,
      output: tokens.output,
      cachedInput: tokens.cache.read,
      sharedCalls: callIDs.length,
    };

    await Promise.all(callIDs.map(async (callID) => {
      const state = toolStates.get(callID);
      if (!state) return;
      await persistToolState(callID, {
        ...state,
        metadata: { ...state.metadata, modelStepUsage },
      } as ToolState);
    }));
    currentStepToolCallIds.clear();
  };

  const recordUsage = (chunk: AgentChunk) => {
    // Normalize AI SDK usage semantics. `totalUsage` arrives here as
    // usageKind=cumulative and replaces the running total; fallback
    // `usage` arrives as usageKind=step and must be accumulated.
    if (chunk.usage) {
      usage = chunk.usageKind === 'step'
        ? addLanguageModelUsage(usage ?? undefined, chunk.usage)
        : chunk.usage;
      usageKind = 'cumulative';
    }
    if (chunk.contextUsage) {
      contextUsage = chunk.contextUsage;
    }

    recorder.recordUsage(
      usage ? addAssistantTokens(options?.priorTokens, usageToAssistantTokens(usage)) : undefined,
      contextUsage,
    );
  };

  try {
    for await (const chunk of generator) {
      switch (chunk.type) {
      case 'reasoning': {
        // End-of-block marker: finalize and stop.
        if (chunk.reasoningDone) {
          await recorder.finalizeReasoning();
          break;
        }
        const reasoningText = chunk.text;
        if (!reasoningText) break;
        await recorder.reasoningDelta(reasoningText, chunk.reasoningId);
        break;
      }

      case 'text':
        // Reasoning always precedes the visible answer; close out any open
        // reasoning block before the text part begins.
        await recorder.finalizeReasoning();
        parts.push({
          type: 'text',
          text: chunk.text!,
          timestamp: Date.now()
        });
        finalText += chunk.text!;
        if (chunk.text && chunk.text.trim()) {
          hasTextOutput = true;
          hasTextSinceLastToolCall = true;
        }
        terminal?.text(chunk.text!);
        recorder.textDelta(chunk.text!);
        break;

      case 'llm-start':
        // Track the start of an LLM generation
        if (chunk.llmModel) terminal?.llmStarted(chunk.llmModel);

        if (chunk.llmModel && chunk.llmStartTime) {
          currentLlmCall = {
            model: chunk.llmModel,
            startTime: chunk.llmStartTime
          };
          llmSegmentCount++;
        }
        break;

      case 'llm-first-token':
        // Track time to first token
        if (currentLlmCall && chunk.llmFirstTokenTime) {
          currentLlmCall.firstTokenTime = chunk.llmFirstTokenTime;
          if (currentLlmCall.startTime) {
            const latency = chunk.llmFirstTokenTime - currentLlmCall.startTime;
            terminal?.llmFirstToken(currentLlmCall.model, latency);
          }
        }
        break;

      case 'tool-call':
        if (chunk.postSuspend) {
          logger.warn(`Tool ${chunk.toolName} was dispatched in the same turn as a pending approval gate; it has been aborted/journaled, not silently dropped.`);
        }
        if (hasTextSinceLastToolCall && options?.doomLoopDetector) {
          options.doomLoopDetector.recordNonToolEvent();
        }
        hasTextSinceLastToolCall = false;

        // Check for doom loop (repeated identical tool calls). Compare without
        // the injected intent phrase: a model stuck in a loop may vary the
        // wording while repeating the exact same call.
        //
        // Skip postSuspend calls: a tool dispatched in the same turn as a
        // pending approval gate is aborted, not executed, and the model is
        // explicitly told to re-issue it after approval. Counting the aborted
        // sibling plus its forced re-issue reads as a loop and kills an
        // otherwise-approved run right after the gate.
        if (options?.doomLoopDetector && !chunk.postSuspend) {
          // This will throw DoomLoopError if threshold exceeded
          options.doomLoopDetector.check(chunk.toolName!, withoutToolIntent(chunk.toolInput));
        }

        // Finalize any pending reasoning/text part before tool call
        await recorder.finalizeStreaming();

        parts.push({
          type: 'tool-call',
          tool: chunk.toolName!,
          args: chunk.toolInput,
          timestamp: Date.now()
        });
        terminal?.toolStarted(chunk.toolName!, chunk.toolInput, chunk.isSubAgent);
        if (options?.collectToolCalls) {
          toolCalls.push({ tool: chunk.toolName!, args: chunk.toolInput });
        }
        // Store info for this tool call using toolCallId as key
        if (chunk.toolCallId && chunk.toolName) {
          const startTime = chunk.toolStartTime || Date.now();
          pendingToolCalls.set(chunk.toolCallId, {
            name: chunk.toolName,
            startTime,
            input: chunk.toolInput  // Store input for later use in completed state
          });
          toolStates.set(chunk.toolCallId, {
            status: 'running',
            input: chunk.toolInput,
            time: { start: startTime },
          });
          currentStepToolCallIds.add(chunk.toolCallId);
          recorder.toolStarted({
            callID: chunk.toolCallId,
            tool: chunk.toolName!,
            input: chunk.toolInput,
            startTime,
          });
        }
        break;

      case 'tool-result':
        // Use the new toolResult method with timing and metadata
        const toolDuration = chunk.toolDuration;
        let tokens: number | undefined;
        let isSubAgent = false;

        // Extract metadata and success status before logging
        let toolSuccess = chunk.toolSuccess ?? true;
        let rawResult: Record<string, unknown> | null = null;
        let toolMetadata: Record<string, unknown> | null = null;

        // Try to get rawResult as object - handles multiple nesting levels
        // toolResultRaw can be:
        // 1. A string with JSON: '{"success":false,...}'
        // 2. An object with error: {error: "message"}
        // 3. An object with output containing JSON: {output: '{"success":false,...}'}
        // 4. An object with output string and metadata: {output: "...", metadata: {exitCode: 1}}
        if (chunk.toolResultRaw) {
          const raw = chunk.toolResultRaw;

          // First, extract metadata if present (for case 4)
          const rawObj = raw as Record<string, unknown>;
          if (typeof raw === 'object' && raw !== null && 'metadata' in raw && typeof rawObj.metadata === 'object') {
            toolMetadata = rawObj.metadata as Record<string, unknown>;
          }

          let toCheck: unknown = raw;

          // If it's an object with .output string, use that for parsing
          if (typeof toCheck === 'object' && toCheck !== null && 'output' in toCheck && typeof (toCheck as Record<string, unknown>).output === 'string') {
            toCheck = (toCheck as Record<string, unknown>).output;
          }

          // Now parse if it's a string
          if (typeof toCheck === 'string') {
            try {
              const parsed = JSON.parse(toCheck);
              if (typeof parsed === 'object' && parsed !== null) {
                rawResult = parsed;
              }
            } catch {
              // Not valid JSON, ignore
            }
          } else if (typeof toCheck === 'object' && toCheck !== null) {
            rawResult = toCheck as Record<string, unknown>;
          }
        }

        // Check for failure conditions
        if (rawResult) {
          // Check if tool explicitly returned success: false or has an error field.
          // Use != null so a tool returning `{ error: null }` (no error) isn't
          // mislabeled as failed in the trace/session log.
          if (rawResult.success === false || rawResult.error != null) {
            toolSuccess = false;
          }
          if (rawResult.metadata && typeof rawResult.metadata === 'object') {
            const metadata = rawResult.metadata as Record<string, unknown>;
            if (typeof metadata.tokensUsed === 'number') {
              tokens = metadata.tokensUsed;
            }
            if (metadata.agent) {
              isSubAgent = true;
            }
          }
        }

        // Check metadata for non-zero exit code (bash tool returns this)
        if (toolMetadata) {
          if (typeof toolMetadata.exitCode === 'number' && toolMetadata.exitCode !== 0) {
            toolSuccess = false;
          }
          if (typeof toolMetadata.tokensUsed === 'number') {
            tokens = toolMetadata.tokensUsed;
          }
          if (toolMetadata.agent) {
            isSubAgent = true;
          }
        }

        parts.push({
          type: 'tool-result',
          tool: chunk.toolName!,
          output: chunk.toolResult ?? 'No result',
          duration: toolDuration || 0,
          success: toolSuccess,
          timestamp: Date.now()
        });

        // Present the result with timing info
        // For skill tools, show a simple message instead of the full content
        if (chunk.toolName === 'tools__skill_load') {
          terminal?.toolFinished('Skill loaded', {
            ...(toolDuration !== undefined && { duration: toolDuration }),
            success: toolSuccess
          });
          // Check for warnings in skill output and present them after "Skill loaded"
          const result = typeof chunk.toolResult === 'string' ? chunk.toolResult : '';
          const warningMatch = result.match(/> ⚠️ WARNING: (.+)/g);
          if (warningMatch) {
            for (const warning of warningMatch) {
              const msg = warning.replace(/^> ⚠️ WARNING: /, '');
              terminal?.warning(msg);
            }
          }
        } else if (chunk.toolName === 'tools__skill_read') {
          terminal?.toolFinished('File read', {
            ...(toolDuration !== undefined && { duration: toolDuration }),
            success: toolSuccess
          });
        } else {
          terminal?.toolFinished(chunk.toolResult ?? chunk.toolResultRaw ?? 'No result', {
            ...(toolDuration !== undefined && { duration: toolDuration }),
            success: toolSuccess,
            ...(tokens && { tokens })
          });
        }

        // Find and complete the tool call trace using toolCallId
        if (chunk.toolCallId && chunk.toolDuration !== undefined) {
          const pending = pendingToolCalls.get(chunk.toolCallId);
          if (pending) {
            // Add tokens to subagent total if applicable
            if (tokens) {
              subAgentTokens += tokens;
            }

            const traceOutput = chunk.toolResultRaw ?? chunk.toolResult;
            toolCallTraces.push({
              name: pending.name,
              type: isSubAgent ? 'subagent' : 'tool',
              startTime: pending.startTime,
              duration: chunk.toolDuration,
              ...(tokens && { tokens }),
              success: toolSuccess,
              input: pending.input,
              ...(traceOutput !== undefined && { output: traceOutput }),
            });

            const endTime = Date.now();
            const toolState: ToolStateCompleted | ToolStateError = toolSuccess
              ? {
                  status: 'completed',
                  input: pending.input || {},
                  output: chunk.toolResultRaw || chunk.toolResult,
                  time: { start: pending.startTime, end: endTime },
                  ...(tokens && { metadata: { tokens } })
                }
              : {
                  status: 'error',
                  input: pending.input || {},
                  error: rawResult?.error
                    ? formatToolResultForDisplay(rawResult.error, { preferError: true })
                    : formatToolResultForDisplay(chunk.toolResult ?? chunk.toolResultRaw ?? 'Unknown error', { preferError: true }),
                  time: { start: pending.startTime, end: endTime },
                  ...(tokens && { metadata: { tokens } })
                };
            await persistToolState(chunk.toolCallId, toolState);

            pendingToolCalls.delete(chunk.toolCallId);
          }
        }
        break;

      case 'tool-error':
        // Tool errors are now passed as tool-result in executeAgentCore
        // This case shouldn't occur but keep for safety
        const prefix = options?.logPrefix || '';
        const errorStr = typeof chunk.error === 'string'
          ? chunk.error
          : ((chunk.error as any)?.message || 'Unknown error');
        terminal?.toolFinished(errorStr, { success: false });
        if (prefix) terminal?.warning(prefix.trim());
        break;

      case 'suspended': {
        suspended = true;
        await recorder.finalizeStreaming();

        if (chunk.contextSnapshot) {
          contextUsage = chunk.contextSnapshot.usage;
          await recorder.writeContextSnapshot(chunk.contextSnapshot);
        } else if (chunk.contextUsage) {
          contextUsage = chunk.contextUsage;
        }

        const suspendPayload = (chunk.toolResultRaw ?? {}) as Record<string, unknown>;
        if (typeof suspendPayload.approvalUrl === 'string') {
          suspendApprovalUrl = suspendPayload.approvalUrl;
        }

        if (chunk.toolCallId) {
          const pending = pendingToolCalls.get(chunk.toolCallId);
          if (pending) {
            const payload = suspendPayload;
            const channelMessage = payload.channelMessage && typeof payload.channelMessage === 'object'
              ? payload.channelMessage as any
              : undefined;
            const suspendedAt = Math.max(
              Date.now(),
              (chunk.contextSnapshot?.updatedAt ?? 0) + 1
            );
            // A 'subagent_wait' is a parent step parked on a delegated child's gate:
            // store only the pointer down (childSessionID) so the cascade can descend.
            // It carries no human-facing fields and triggers no Slack/announce (gated
            // below to 'await_human'), so the parent suspends silently while the real
            // gate stays on the leaf and surfaces once at the root.
            const buildPendingState = (activeChannelMessage?: any) => ({
              status: 'pending',
              input: pending.input,
              suspendedAt,
              resumePayload: payload.kind === 'subagent_wait'
                ? {
                    kind: 'subagent_wait',
                    ...(typeof payload.childSessionID === 'string' && { childSessionID: payload.childSessionID }),
                    ...(typeof payload.childAgentName === 'string' && { childAgentName: payload.childAgentName }),
                  }
                : {
                    kind: 'await_human',
                    ...(typeof payload.prompt === 'string' && { prompt: payload.prompt }),
                    ...(typeof payload.surface === 'string' && { surface: payload.surface }),
                    ...(typeof payload.approvalUrl === 'string' && { approvalUrl: payload.approvalUrl }),
                    ...(typeof payload.expiresAt === 'number' && { expiresAt: payload.expiresAt }),
                    ...(typeof payload.resumeToken === 'string' && { resumeToken: payload.resumeToken }),
                    ...(Array.isArray(payload.artifactSnapshots) && payload.artifactSnapshots.length > 0 && { artifactSnapshots: payload.artifactSnapshots }),
                    ...(activeChannelMessage ? { channelMessage: activeChannelMessage } : {})
                  }
            });
            const persisted = await persistToolState(chunk.toolCallId, buildPendingState(channelMessage) as ToolState);
            if (persisted && payload.kind === 'await_human') {
              const sentChannelMessage = await sendPersistedSlackApproval({
                ...(options?.sessionID && { sessionId: options.sessionID }),
                ...(options?.agentName && { agentName: options.agentName }),
                ...(typeof payload.resumeToken === 'string' && { resumeToken: payload.resumeToken }),
                ...(typeof payload.approvalUrl === 'string' && { approvalUrl: payload.approvalUrl }),
                ...(typeof payload.prompt === 'string' && { prompt: payload.prompt }),
                ...(typeof payload.expiresAt === 'number' && { expiresAt: payload.expiresAt }),
                input: pending.input,
                channelRequest: payload.channelRequest,
                ...(options?.slackRunChannelHandles && { slackRunChannelHandles: options.slackRunChannelHandles })
              });
              if (sentChannelMessage) {
                await persistToolState(chunk.toolCallId, buildPendingState(sentChannelMessage) as ToolState);
              }
              await announceApprovalRequested({
                ...(options?.sessionID && { sessionId: options.sessionID }),
                ...(typeof payload.resumeToken === 'string' && { resumeToken: payload.resumeToken }),
                ...(typeof payload.approvalUrl === 'string' && { approvalUrl: payload.approvalUrl }),
                ...(typeof payload.prompt === 'string' && { prompt: payload.prompt })
              });
            }
          }
        }
        break;
      }

      case 'finish':
        // Finalize any pending reasoning/text part
        await recorder.finalizeStreaming();

        await persistCurrentStepToolUsage(chunk);
        recordUsage(chunk);

        finishReasons.push(chunk.finishReason ?? 'unknown');

        // Complete the LLM call trace for this segment
        if (currentLlmCall && currentLlmCall.startTime) {
          const duration = Date.now() - currentLlmCall.startTime;
          const segmentName = llmSegmentCount > 1 ?
            `${currentLlmCall.model}_segment_${llmSegmentCount}` :
            currentLlmCall.model;

          const llmTrace: ToolCallTrace = {
            name: segmentName,
            type: 'llm',
            startTime: currentLlmCall.startTime,
            duration,
            // Only add tokens for final segment with usage data
            ...(chunk.usage && chunk.usage.totalTokens && {
              tokens: chunk.usage.totalTokens
            })
          };
          toolCallTraces.push(llmTrace);
          currentLlmCall = null;
        }

        if (finalText.trim()) terminal?.responseComplete();
        break;

      case 'usage':
        await persistCurrentStepToolUsage(chunk);
        recordUsage(chunk);
        break;

      case 'error':
        // Finalize any pending reasoning/text part before throwing error
        await recorder.finalizeStreaming();
        throw chunk.error;
      }
    }
  } finally {
    await recorder.flush();
  }

  return {
    text: finalText,
    ...(usage ? { usage } : {}),
    ...(usageKind ? { usageKind } : {}),
    ...(options?.collectToolCalls && { toolCalls }),
    ...(subAgentTokens > 0 && { subAgentTokens }),
    ...(toolCallTraces.length > 0 && { toolCallTraces }),
    ...(finishReasons.length > 0 && { finishReasons, finishReason: finishReasons[finishReasons.length - 1] }),
    hasTextOutput,
    ...(suspended && { suspended }),
    ...(suspendApprovalUrl && { approvalUrl: suspendApprovalUrl }),
    ...(contextUsage && { contextUsage }),
    parts
  };
}
