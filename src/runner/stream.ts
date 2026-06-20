import type { LanguageModelUsage } from 'ai';
import type { ToolCallTrace } from '../plugin/types';
import type { DoomLoopDetector } from '../tools/index.js';
import type { SessionManager } from '../session';
import type { AgentPart } from '../types/parts';
import type { ToolStateCompleted, ToolStateError } from '../session/types';
import type { ActiveContextUsage } from '../session/types';
import { addLanguageModelUsage, usageToAssistantTokens, addAssistantTokens, type AssistantTokens } from '../session/usage';
import { logger } from '../utils/logger';
import { safeHttpUrl } from '../utils/url';
import { formatToolResultForDisplay } from '../utils/format-tool-result';
import { sendSlackApprovalRequest, sendSlackApprovalRequestToThread } from '../slack/approval';
import type { AgentChunk } from './types';

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
  try {
    const approvalRequest = {
      botToken,
      channelId,
      sessionId: options.sessionId,
      ...(process.env.AGENTUSE_PROJECT_ID && { projectId: process.env.AGENTUSE_PROJECT_ID }),
      ...(options.agentName && { agentName: options.agentName }),
      prompt: options.prompt,
      ...(typeof input.summary === 'string' && { summary: input.summary }),
      ...(typeof input.draft === 'string' && { draft: input.draft }),
      ...(draftUrl && { draftUrl }),
      ...(artifactUrl && { artifactUrl }),
      ...(typeof input.context === 'string' && { context: input.context }),
      ...(typeof input.risk === 'string' && { risk: input.risk }),
      resumeToken: options.resumeToken,
      approvalUrl: options.approvalUrl,
      interactive: Boolean(process.env.SLACK_APP_TOKEN),
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
  const pendingToolCalls = new Map<string, { name: string; startTime: number; addPartPromise?: Promise<string | undefined>; input?: unknown }>();
  let currentLlmCall: { model: string; startTime: number; firstTokenTime?: number } | null = null;
  let llmSegmentCount = 0;
  let hasTextOutput = false;
  const finishReasons: string[] = [];
  const parts: AgentPart[] = [];
  let contextUsage: ActiveContextUsage | undefined;
  let suspended = false;
  let suspendApprovalUrl: string | undefined;
  let hasTextSinceLastToolCall = false;

  // Track current text part for streaming updates with debouncing
  let currentTextPart: { partID?: string; text: string; startTime: number; createPromise?: Promise<void> } | null = null;
  let textUpdateTimer: NodeJS.Timeout | null = null;
  const TEXT_UPDATE_DEBOUNCE_MS = 500; // Write to disk every 500ms max

  // Track current reasoning (extended-thinking) part, keyed by the provider's
  // block id. Mirrors the text-part streaming/debounce so the model's reasoning
  // shows up live in the session trace.
  let currentReasoningPart: { partID?: string; text: string; startTime: number; createPromise?: Promise<void>; id?: string } | null = null;
  let reasoningUpdateTimer: NodeJS.Timeout | null = null;

  // Track pending session updates to ensure they complete before returning
  // Use Set with self-cleanup to avoid holding references to resolved promises
  const pendingSessionUpdates = new Set<Promise<unknown>>();
  const trackSessionUpdate = (promise: Promise<unknown>) => {
    pendingSessionUpdates.add(promise);
    promise.finally(() => pendingSessionUpdates.delete(promise));
  };

  // Helper to finalize current text part
  const finalizeTextPart = async () => {
    // Clear any pending debounced update
    if (textUpdateTimer) {
      clearTimeout(textUpdateTimer);
      textUpdateTimer = null;
    }

    if (currentTextPart && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
      const textPart = currentTextPart;
      if (textPart.createPromise) {
        await textPart.createPromise;
      }
      if (!textPart.partID) {
        currentTextPart = null;
        return;
      }
      try {
        await options.sessionManager.updatePart(
          options.sessionID,
          options.agentId,
          options.messageID,
          textPart.partID,
          {
            text: textPart.text.trimEnd(),
            time: {
              start: textPart.startTime,
              end: Date.now()
            }
          }
        );
      } catch (err) {
        logger.debug(`Failed to finalize text part: ${(err as Error).message}`);
      }
      currentTextPart = null;
    }
  };

  // Helper to finalize the current reasoning part (flush debounce + stamp end).
  const finalizeReasoningPart = async () => {
    if (reasoningUpdateTimer) {
      clearTimeout(reasoningUpdateTimer);
      reasoningUpdateTimer = null;
    }

    if (currentReasoningPart && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
      const reasoningPart = currentReasoningPart;
      if (reasoningPart.createPromise) {
        await reasoningPart.createPromise;
      }
      if (!reasoningPart.partID) {
        currentReasoningPart = null;
        return;
      }
      try {
        await options.sessionManager.updatePart(
          options.sessionID,
          options.agentId,
          options.messageID,
          reasoningPart.partID,
          {
            text: reasoningPart.text.trimEnd(),
            time: {
              start: reasoningPart.startTime,
              end: Date.now()
            }
          }
        );
      } catch (err) {
        logger.debug(`Failed to finalize reasoning part: ${(err as Error).message}`);
      }
      currentReasoningPart = null;
    }
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

    if (usage && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
      const updatePromise = options.sessionManager.updateMessage(options.sessionID, options.agentId, options.messageID, {
        assistant: {
          tokens: addAssistantTokens(options.priorTokens, usageToAssistantTokens(usage)),
          ...(contextUsage && { context: contextUsage })
        }
      }).catch(err => logger.debug(`Failed to persist interim usage: ${err.message}`));
      trackSessionUpdate(updatePromise);
    } else if (contextUsage && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
      const updatePromise = options.sessionManager.updateMessage(options.sessionID, options.agentId, options.messageID, {
        assistant: {
          context: contextUsage
        }
      }).catch(err => logger.debug(`Failed to persist interim context usage: ${err.message}`));
      trackSessionUpdate(updatePromise);
    }
  };

  for await (const chunk of generator) {
    switch (chunk.type) {
      case 'reasoning': {
        // End-of-block marker: finalize and stop.
        if (chunk.reasoningDone) {
          await finalizeReasoningPart();
          break;
        }
        const reasoningText = chunk.text;
        if (!reasoningText) break;
        // A different block id means the prior reasoning block ended.
        if (currentReasoningPart && currentReasoningPart.id !== chunk.reasoningId) {
          await finalizeReasoningPart();
        }

        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
          if (!currentReasoningPart) {
            // First delta of this block: create the part (await for partID).
            const startTime = Date.now();
            const reasoningPart: { partID?: string; text: string; startTime: number; createPromise?: Promise<void>; id?: string } = {
              text: reasoningText,
              startTime,
              ...(chunk.reasoningId !== undefined && { id: chunk.reasoningId })
            };
            currentReasoningPart = reasoningPart;
            const addPromise = options.sessionManager.addPart(options.sessionID, options.agentId, options.messageID, {
              type: 'reasoning',
              text: reasoningText,
              time: { start: startTime }
            } as any).then(partID => {
              reasoningPart.partID = partID;
            }).catch(err => logger.debug(`Failed to create reasoning part: ${err.message}`));
            reasoningPart.createPromise = addPromise;
            trackSessionUpdate(addPromise);
          } else {
            // Subsequent deltas: update in-memory now, debounce disk writes.
            const reasoningPart = currentReasoningPart;
            reasoningPart.text += reasoningText;

            if (reasoningUpdateTimer) {
              clearTimeout(reasoningUpdateTimer);
            }
            const getText = () => currentReasoningPart?.text || '';
            reasoningUpdateTimer = setTimeout(() => {
              if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
                const updatePromise = Promise.resolve()
                  .then(async () => {
                    if (reasoningPart.createPromise) {
                      await reasoningPart.createPromise;
                    }
                    if (!reasoningPart.partID) return;
                    await options.sessionManager!.updatePart(
                      options.sessionID!,
                      options.agentId!,
                      options.messageID!,
                      reasoningPart.partID,
                      { text: getText() }
                    );
                  })
                  .catch(err => logger.debug(`Failed to update reasoning part: ${err.message}`));
                trackSessionUpdate(updatePromise);
              }
              reasoningUpdateTimer = null;
            }, TEXT_UPDATE_DEBOUNCE_MS);
          }
        }
        break;
      }

      case 'text':
        // Reasoning always precedes the visible answer; close out any open
        // reasoning block before the text part begins.
        await finalizeReasoningPart();
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
        if (!options?.quiet) {
          logger.response(chunk.text!);
        }

        // Log to session with debounced writes to prevent race conditions
        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
          if (!currentTextPart) {
            // First text chunk: create new part (await to ensure partID is available)
            const startTime = Date.now();
            const textPart: { partID?: string; text: string; startTime: number; createPromise?: Promise<void> } = {
              text: chunk.text!,
              startTime
            };
            currentTextPart = textPart;
            const addPromise = options.sessionManager.addPart(options.sessionID, options.agentId, options.messageID, {
              type: 'text',
              text: chunk.text!,
              time: { start: startTime }
            } as any).then(partID => {
              textPart.partID = partID;
            }).catch(err => logger.debug(`Failed to create text part: ${err.message}`));
            textPart.createPromise = addPromise;
            trackSessionUpdate(addPromise);
          } else {
            // Subsequent chunks: update in-memory immediately, debounce disk writes
            if (currentTextPart) {
              const textPart = currentTextPart;
              textPart.text += chunk.text!;

              // Clear existing timer and schedule new debounced write
              if (textUpdateTimer) {
                clearTimeout(textUpdateTimer);
              }

              // Capture current state for the timeout callback
              const getText = () => currentTextPart?.text || '';

              textUpdateTimer = setTimeout(() => {
                if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
                  const updatePromise = Promise.resolve()
                    .then(async () => {
                      if (textPart.createPromise) {
                        await textPart.createPromise;
                      }
                      if (!textPart.partID) return;
                      await options.sessionManager!.updatePart(
                        options.sessionID!,
                        options.agentId!,
                        options.messageID!,
                        textPart.partID,
                        {
                          text: getText()
                        }
                      );
                    })
                    .catch(err => logger.debug(`Failed to update text part: ${err.message}`));
                  trackSessionUpdate(updatePromise);
                }
                textUpdateTimer = null;
              }, TEXT_UPDATE_DEBOUNCE_MS);
            }
          }
        }
        break;

      case 'llm-start':
        // Track the start of an LLM generation
        if (chunk.llmModel && !options?.quiet) {
          logger.llmStart(chunk.llmModel);
        }

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
          if (currentLlmCall.startTime && !options?.quiet) {
            const latency = chunk.llmFirstTokenTime - currentLlmCall.startTime;
            logger.llmFirstToken(currentLlmCall.model, latency);
          }
        }
        break;

      case 'tool-call':
        if (hasTextSinceLastToolCall && options?.doomLoopDetector) {
          options.doomLoopDetector.recordNonToolEvent();
        }
        hasTextSinceLastToolCall = false;

        // Check for doom loop (repeated identical tool calls)
        if (options?.doomLoopDetector) {
          // This will throw DoomLoopError if threshold exceeded
          options.doomLoopDetector.check(chunk.toolName!, chunk.toolInput);
        }

        // Finalize any pending reasoning/text part before tool call
        await finalizeReasoningPart();
        await finalizeTextPart();

        parts.push({
          type: 'tool-call',
          tool: chunk.toolName!,
          args: chunk.toolInput,
          timestamp: Date.now()
        });
        if (!options?.quiet) {
          logger.tool(chunk.toolName!, chunk.toolInput, undefined, chunk.isSubAgent);
        }
        if (options?.collectToolCalls) {
          toolCalls.push({ tool: chunk.toolName!, args: chunk.toolInput });
        }
        // Store info for this tool call using toolCallId as key
        if (chunk.toolCallId && chunk.toolName && chunk.toolStartTime) {
          pendingToolCalls.set(chunk.toolCallId, {
            name: chunk.toolName,
            startTime: chunk.toolStartTime,
            input: chunk.toolInput  // Store input for later use in completed state
          });
        }

        // Log to session and store the promise for later awaiting
        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId && chunk.toolCallId) {
          const addPartPromise = options.sessionManager.addPart(options.sessionID, options.agentId, options.messageID, {
            type: 'tool',
            callID: chunk.toolCallId,
            tool: chunk.toolName!,
            state: {
              status: 'running',
              input: chunk.toolInput,
              time: { start: chunk.toolStartTime || Date.now() }
            }
          } as any).catch(err => {
            logger.debug(`Failed to log tool-call part: ${err.message}`);
            return undefined; // Return undefined on error so partID check fails gracefully
          });
          trackSessionUpdate(addPartPromise);

          // Store the promise directly so tool-result can await it
          const pending = pendingToolCalls.get(chunk.toolCallId);
          if (pending) {
            pendingToolCalls.set(chunk.toolCallId, { ...pending, addPartPromise });
          }
        }
        break;

      case 'tool-result':
        // Use the new toolResult method with timing and metadata
        const toolDuration = chunk.toolDuration;
        let tokens: number | undefined;
        let isSubAgent = false;

        // Extract metadata and success status before logging
        let toolSuccess = true;
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
          // Check if tool explicitly returned success: false or has an error field
          if (rawResult.success === false || rawResult.error !== undefined) {
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

        // Log the result with timing info
        // For skill tools, show a simple message instead of the full content
        if (!options?.quiet) {
          if (chunk.toolName === 'tools__skill_load') {
            logger.toolResult('Skill loaded', {
              ...(toolDuration !== undefined && { duration: toolDuration }),
              success: toolSuccess
            });
            // Check for warnings in skill output and log them after "Skill loaded"
            const result = typeof chunk.toolResult === 'string' ? chunk.toolResult : '';
            const warningMatch = result.match(/> ⚠️ WARNING: (.+)/g);
            if (warningMatch) {
              for (const warning of warningMatch) {
                const msg = warning.replace(/^> ⚠️ WARNING: /, '');
                logger.warn(msg);
              }
            }
          } else if (chunk.toolName === 'tools__skill_read') {
            logger.toolResult('File read', {
              ...(toolDuration !== undefined && { duration: toolDuration }),
              success: toolSuccess
            });
          } else {
            logger.toolResult(chunk.toolResult ?? chunk.toolResultRaw ?? 'No result', {
              ...(toolDuration !== undefined && { duration: toolDuration }),
              success: toolSuccess,
              ...(tokens && { tokens })
            });
          }
        }

        // Find and complete the tool call trace using toolCallId
        if (chunk.toolCallId && chunk.toolDuration !== undefined) {
          const pending = pendingToolCalls.get(chunk.toolCallId);
          if (pending) {
            // Add tokens to subagent total if applicable
            if (tokens) {
              subAgentTokens += tokens;
            }

            toolCallTraces.push({
              name: pending.name,
              type: isSubAgent ? 'subagent' : 'tool',
              startTime: pending.startTime,
              duration: chunk.toolDuration,
              ...(tokens && { tokens }),
              success: toolSuccess,
              input: pending.input,
            });

            // Update the session storage part with completed state
            // Await the addPartPromise to ensure partID is available (fixes race condition for fast tools like skill_load)
            if (pending.addPartPromise && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
              const partID = await pending.addPartPromise;
              if (partID) {
                // Build state based on success/failure
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

                const updatePromise = options.sessionManager.updatePart(options.sessionID, options.agentId, options.messageID, partID, {
                  state: toolState
                }).catch(err => logger.debug(`Failed to update tool part: ${err.message}`));
                trackSessionUpdate(updatePromise);
              }
            }

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
        logger.warnWithTool(chunk.toolName || 'unknown', 'call', errorStr, chunk.toolCallId);
        if (prefix) logger.warn(prefix.trim()); // Show any prefix separately
        break;

      case 'suspended': {
        suspended = true;
        await finalizeReasoningPart();
        await finalizeTextPart();

        if (chunk.contextSnapshot) {
          contextUsage = chunk.contextSnapshot.usage;
          if (options?.sessionManager && options?.sessionID && options?.agentId) {
            try {
              await options.sessionManager.writeContextSnapshot(
                options.sessionID,
                options.agentId,
                {
                  ...chunk.contextSnapshot,
                  ...(options.messageID && { messageID: options.messageID }),
                }
              );
            } catch (err) {
              logger.debug(`Failed to persist suspension context snapshot: ${(err as Error).message}`);
            }
          }
        } else if (chunk.contextUsage) {
          contextUsage = chunk.contextUsage;
        }

        const suspendPayload = (chunk.toolResultRaw ?? {}) as Record<string, unknown>;
        if (typeof suspendPayload.approvalUrl === 'string') {
          suspendApprovalUrl = suspendPayload.approvalUrl;
        }

        if (chunk.toolCallId) {
          const pending = pendingToolCalls.get(chunk.toolCallId);
          if (pending?.addPartPromise && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentId) {
            const partID = await pending.addPartPromise;
            if (partID) {
              const payload = suspendPayload;
              let channelMessage = payload.channelMessage && typeof payload.channelMessage === 'object'
                ? payload.channelMessage as any
                : undefined;
              const suspendedAt = Math.max(
                Date.now(),
                (chunk.contextSnapshot?.updatedAt ?? 0) + 1
              );
              const buildPendingState = (activeChannelMessage?: any) => ({
                status: 'pending',
                input: pending.input,
                suspendedAt,
                resumePayload: {
                  kind: 'await_human',
                  ...(typeof payload.prompt === 'string' && { prompt: payload.prompt }),
                  ...(typeof payload.surface === 'string' && { surface: payload.surface }),
                  ...(typeof payload.approvalUrl === 'string' && { approvalUrl: payload.approvalUrl }),
                  ...(typeof payload.expiresAt === 'number' && { expiresAt: payload.expiresAt }),
                  ...(typeof payload.resumeToken === 'string' && { resumeToken: payload.resumeToken }),
                  ...(activeChannelMessage ? { channelMessage: activeChannelMessage } : {})
                }
              });
              const updatePromise = options.sessionManager.updatePart(options.sessionID, options.agentId, options.messageID, partID, {
                state: buildPendingState(channelMessage)
              } as any).catch(err => logger.debug(`Failed to mark tool part pending: ${err.message}`));
              trackSessionUpdate(updatePromise);
              await updatePromise;
              if (payload.kind === 'await_human') {
                const sentChannelMessage = await sendPersistedSlackApproval({
                  sessionId: options.sessionID,
                  ...(options.agentName && { agentName: options.agentName }),
                  ...(typeof payload.resumeToken === 'string' && { resumeToken: payload.resumeToken }),
                  ...(typeof payload.approvalUrl === 'string' && { approvalUrl: payload.approvalUrl }),
                  ...(typeof payload.prompt === 'string' && { prompt: payload.prompt }),
                  ...(typeof payload.expiresAt === 'number' && { expiresAt: payload.expiresAt }),
                  input: pending.input,
                  channelRequest: payload.channelRequest,
                  ...(options.slackRunChannelHandles && { slackRunChannelHandles: options.slackRunChannelHandles })
                });
                if (sentChannelMessage) {
                  channelMessage = sentChannelMessage;
                  await options.sessionManager.updatePart(options.sessionID, options.agentId, options.messageID, partID, {
                    state: buildPendingState(sentChannelMessage)
                  } as any);
                }
                await announceApprovalRequested({
                  sessionId: options.sessionID,
                  ...(typeof payload.resumeToken === 'string' && { resumeToken: payload.resumeToken }),
                  ...(typeof payload.approvalUrl === 'string' && { approvalUrl: payload.approvalUrl }),
                  ...(typeof payload.prompt === 'string' && { prompt: payload.prompt })
                });
              }
            }
          }
        }
        break;
      }

      case 'finish':
        // Finalize any pending reasoning/text part
        await finalizeReasoningPart();
        await finalizeTextPart();

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

        if (finalText.trim() && !options?.quiet) {
          logger.responseComplete();
        }
        break;

      case 'usage':
        recordUsage(chunk);
        break;

      case 'error':
        // Finalize any pending reasoning/text part before throwing error
        await finalizeReasoningPart();
        await finalizeTextPart();
        throw chunk.error;
    }
  }

  // Finalize any pending reasoning/text part before returning (safety fallback)
  await finalizeReasoningPart();
  await finalizeTextPart();

  // Wait for all pending session updates to complete before returning
  // This ensures tool states are persisted (e.g., "running" -> "completed")
  if (pendingSessionUpdates.size > 0) {
    await Promise.allSettled(pendingSessionUpdates);
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
