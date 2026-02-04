import type { LanguageModelUsage } from 'ai';
import type { ToolCallTrace } from '../plugin/types';
import type { DoomLoopDetector } from '../tools/index.js';
import type { SessionManager } from '../session';
import type { AgentPart } from '../types/parts';
import type { ToolStateCompleted } from '../session/types';
import { logger } from '../utils/logger';
import type { AgentChunk } from './types';

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
    agentName?: string;
    doomLoopDetector?: DoomLoopDetector;
    /** Suppress console output (for serve mode) */
    quiet?: boolean;
  }
): Promise<{
  text: string;
  usage?: LanguageModelUsage;
  toolCalls?: Array<{ tool: string; args: unknown }>;
  subAgentTokens?: number;
  toolCallTraces?: ToolCallTrace[];
  finishReason?: string;
  finishReasons?: string[];
  hasTextOutput: boolean;
  parts: AgentPart[];
}> {
  let finalText = '';
  let usage: LanguageModelUsage | null = null;
  const toolCalls: Array<{ tool: string; args: unknown }> = [];
  let subAgentTokens = 0;
  const toolCallTraces: ToolCallTrace[] = [];
  const pendingToolCalls = new Map<string, { name: string; startTime: number; addPartPromise?: Promise<string | undefined>; input?: unknown }>();
  let currentLlmCall: { model: string; startTime: number; firstTokenTime?: number } | null = null;
  let llmSegmentCount = 0;
  let hasTextOutput = false;
  const finishReasons: string[] = [];
  const parts: AgentPart[] = [];

  // Track current text part for streaming updates with debouncing
  let currentTextPart: { partID: string; text: string; startTime: number } | null = null;
  let textUpdateTimer: NodeJS.Timeout | null = null;
  const TEXT_UPDATE_DEBOUNCE_MS = 500; // Write to disk every 500ms max

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

    if (currentTextPart && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName) {
      try {
        await options.sessionManager.updatePart(
          options.sessionID,
          options.agentName,
          options.messageID,
          currentTextPart.partID,
          {
            text: currentTextPart.text.trimEnd(),
            time: {
              start: currentTextPart.startTime,
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

  for await (const chunk of generator) {
    switch (chunk.type) {
      case 'text':
        parts.push({
          type: 'text',
          text: chunk.text!,
          timestamp: Date.now()
        });
        finalText += chunk.text!;
        if (chunk.text && chunk.text.trim()) {
          hasTextOutput = true;
        }
        if (!options?.quiet) {
          logger.response(chunk.text!);
        }

        // Log to session with debounced writes to prevent race conditions
        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName) {
          if (!currentTextPart) {
            // First text chunk: create new part (await to ensure partID is available)
            const startTime = Date.now();
            const addPromise = options.sessionManager.addPart(options.sessionID, options.agentName, options.messageID, {
              type: 'text',
              text: chunk.text!,
              time: { start: startTime }
            } as any).then(partID => {
              currentTextPart = {
                partID,
                text: chunk.text!,
                startTime
              };
            }).catch(err => logger.debug(`Failed to create text part: ${err.message}`));
            trackSessionUpdate(addPromise);
          } else {
            // Subsequent chunks: update in-memory immediately, debounce disk writes
            // TypeScript can't track that currentTextPart is set in the async .then() above,
            // but in practice chunks arrive slowly enough that this is safe
            if (currentTextPart) {
              const textPart = currentTextPart as { partID: string; text: string; startTime: number };
              textPart.text += chunk.text!;

              // Clear existing timer and schedule new debounced write
              if (textUpdateTimer) {
                clearTimeout(textUpdateTimer);
              }

              // Capture current state for the timeout callback
              const partID = textPart.partID;
              const getText = () => currentTextPart?.text || '';

              textUpdateTimer = setTimeout(() => {
                if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName) {
                  const updatePromise = options.sessionManager.updatePart(
                    options.sessionID,
                    options.agentName,
                    options.messageID,
                    partID,
                    {
                      text: getText()
                    }
                  ).catch(err => logger.debug(`Failed to update text part: ${err.message}`));
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
        // Finalize any pending text part before tool call
        await finalizeTextPart();

        // Check for doom loop (repeated identical tool calls)
        if (options?.doomLoopDetector) {
          // This will throw DoomLoopError if threshold exceeded
          options.doomLoopDetector.check(chunk.toolName!, chunk.toolInput);
        }

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
        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName && chunk.toolCallId) {
          const addPartPromise = options.sessionManager.addPart(options.sessionID, options.agentName, options.messageID, {
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
          output: chunk.toolResult || 'No result',
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
            const result = chunk.toolResult || '';
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
            logger.toolResult(chunk.toolResult || 'No result', {
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
            if (pending.addPartPromise && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName) {
              const partID = await pending.addPartPromise;
              if (partID) {
                // Build completed state with required fields
                const completedState: ToolStateCompleted = {
                  status: 'completed',
                  input: pending.input || {},  // Use stored input from tool-call
                  output: chunk.toolResultRaw || chunk.toolResult,
                  time: {
                    start: pending.startTime,
                    end: Date.now()
                  },
                  ...(tokens && { metadata: { tokens } })
                };

                const updatePromise = options.sessionManager.updatePart(options.sessionID, options.agentName, options.messageID, partID, {
                  state: completedState
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
        logger.warnWithTool(chunk.toolName || 'unknown', 'call', errorStr);
        if (prefix) logger.warn(prefix.trim()); // Show any prefix separately
        break;

      case 'finish':
        // Finalize any pending text part
        await finalizeTextPart();

        // Only update usage on final finish (not intermediate segments)
        if (chunk.usage) {
          usage = chunk.usage;
        }

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

      case 'error':
        // Finalize any pending text part before throwing error
        await finalizeTextPart();
        throw chunk.error;
    }
  }

  // Finalize any pending text part before returning (safety fallback)
  await finalizeTextPart();

  // Wait for all pending session updates to complete before returning
  // This ensures tool states are persisted (e.g., "running" -> "completed")
  if (pendingSessionUpdates.size > 0) {
    await Promise.allSettled(pendingSessionUpdates);
  }

  return {
    text: finalText,
    ...(usage && { usage }),
    ...(options?.collectToolCalls && { toolCalls }),
    ...(subAgentTokens > 0 && { subAgentTokens }),
    ...(toolCallTraces.length > 0 && { toolCallTraces }),
    ...(finishReasons.length > 0 && { finishReasons, finishReason: finishReasons[finishReasons.length - 1] }),
    hasTextOutput,
    parts
  };
}
