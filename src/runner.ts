import { streamText, stepCountIs, type ToolSet, type LanguageModelUsage } from 'ai';
import type { ParsedAgent } from './parser';
import type { MCPConnection } from './mcp';
import { getMCPTools } from './mcp';
import { createSubAgentTools } from './subagent';
import { getTools as getConfiguredTools, DoomLoopDetector, resolveSafeVariables, type PathResolverContext } from './tools/index.js';
import { createModel, AuthenticationError } from './models';
import { logger } from './utils/logger';
import { ContextManager } from './context-manager';
import { compactMessages } from './compactor';
import { dirname } from 'path';
import type { ToolCallTrace } from './plugin/types';
import { resolveMaxSteps, DEFAULT_MAX_STEPS } from './utils/config';
import type { AgentPart } from './types/parts';
import { SessionManager } from './session';
import { createSkillTool } from './skill/index.js';

// Constants
const MAX_RETRIES = 3;

/**
 * Build autonomous agent system prompt
 */
export function buildAutonomousAgentPrompt(todayDate: string, isSubAgent: boolean = false): string {
  const basePrompt = `You are an autonomous AI agent outputting to CLI/terminal. When given a task:
- Break it down into clear steps
- Execute each step thoroughly
- Iterate until the task is fully complete
- DO NOT narrate actions - never use "Let me...", "I'll...", "I'm going to..."
- Execute tools directly without announcing them
- Output only results and what changed, not process or intentions
- Format for terminal: use bullets and arrows, keep lines short
- When tools modify the system, explicitly state what changed:
  • Modified files (path and what changed)
  • Created/updated resources (e.g., Linear issues, GitHub PRs, Slack messages)
  • Executed commands and their results`;

  const subAgentAddition = isSubAgent ? '\n- Provide only essential summary when complete' : '';

  return `${basePrompt}${subAgentAddition}

Today's date: ${todayDate}`;
}

/**
 * Options for preparing agent execution
 */
export interface PrepareAgentOptions {
  agent: ParsedAgent;
  mcpClients: MCPConnection[];
  agentFilePath?: string | undefined;
  cliMaxSteps?: number | undefined;
  sessionManager?: SessionManager | undefined;
  projectContext?: { projectRoot: string; cwd: string } | undefined;
  userPrompt?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  verbose?: boolean | undefined;
}

/**
 * Result of preparing agent execution - contains everything needed to run the agent
 */
export interface PreparedAgentExecution {
  tools: ToolSet;
  systemMessages: Array<{ role: string; content: string }>;
  userMessage: string;
  maxSteps: number;
  subAgentNames: Set<string>;
  sessionID?: string | undefined;
  assistantMsgID?: string | undefined;
  doomLoopDetector: DoomLoopDetector;
}

/**
 * Prepare agent execution - shared setup logic for both streaming and non-streaming modes
 * This extracts the common setup code to avoid duplication between runAgent and serve.ts
 */
export async function prepareAgentExecution(options: PrepareAgentOptions): Promise<PreparedAgentExecution> {
  const {
    agent,
    mcpClients,
    agentFilePath,
    cliMaxSteps,
    sessionManager,
    projectContext,
    userPrompt,
    abortSignal,
    verbose = false
  } = options;

  // Convert MCP tools to AI SDK format
  const mcpTools = await getMCPTools(mcpClients);

  // Get configured builtin tools (filesystem, bash)
  const configuredTools = agent.config.tools && projectContext
    ? getConfiguredTools(agent.config.tools, {
        projectRoot: projectContext.projectRoot,
        agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
      } as PathResolverContext)
    : {};

  if (Object.keys(configuredTools).length > 0) {
    logger.debug(`Loaded ${Object.keys(configuredTools).length} configured tool(s): ${Object.keys(configuredTools).join(', ')}`);
  }

  // Resolve safe variables in instructions (${root}, ${agentDir}, ${tmpDir} - NOT ${env:*})
  const pathContext: PathResolverContext = {
    projectRoot: projectContext?.projectRoot ?? process.cwd(),
    agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
  };
  const resolvedInstructions = resolveSafeVariables(agent.instructions, pathContext);

  // Precedence: CLI > Agent YAML > Default
  const maxSteps = resolveMaxSteps(cliMaxSteps, agent.config.maxSteps);

  // Create doom loop detector to catch agents stuck in repetitive tool calls
  const doomLoopDetector = new DoomLoopDetector({ threshold: 3, action: 'error' });

  logger.debug(`Running agent with model: ${agent.config.model}`);

  // Build today's date for system prompt
  const todayDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Build system messages array
  const systemMessages: Array<{ role: string; content: string }> = [];

  // For Anthropic, add the Claude Code prompt as FIRST system message
  if (agent.config.model.includes('anthropic')) {
    systemMessages.push({
      role: 'system',
      content: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    });
    logger.debug("Using Anthropic system prompt: You are Claude Code...");
  }

  // Add main system prompt as second message
  systemMessages.push({
    role: 'system',
    content: buildAutonomousAgentPrompt(todayDate, false)
  });

  // Create session if session manager is provided
  let sessionID: string | undefined;
  let assistantMsgID: string | undefined;

  logger.debug(`Session manager available: ${!!sessionManager}, Project context available: ${!!projectContext}`);

  if (sessionManager && projectContext) {
    try {
      // Create session
      const agentConfig: {
        name: string;
        filePath?: string;
        description?: string;
        isSubAgent: boolean;
      } = {
        name: agent.name,
        isSubAgent: false
      };
      if (agentFilePath) agentConfig.filePath = agentFilePath;
      if (agent.description) agentConfig.description = agent.description;

      const sessionConfig: {
        timeout?: number;
        maxSteps?: number;
        mcpServers?: string[];
        subagents?: Array<{ path: string; name?: string }>;
      } = {};
      if (agent.config.timeout) sessionConfig.timeout = agent.config.timeout;
      if (maxSteps) sessionConfig.maxSteps = maxSteps;
      if (agent.config.mcpServers) sessionConfig.mcpServers = Object.keys(agent.config.mcpServers);
      if (agent.config.subagents) {
        sessionConfig.subagents = agent.config.subagents.map(sa => {
          const result: { path: string; name?: string } = { path: sa.path };
          if (sa.name) result.name = sa.name;
          return result;
        });
      }

      sessionID = await sessionManager.createSession({
        agent: agentConfig,
        model: agent.config.model,
        version: '0.1.4', // TODO: import from package.json
        config: sessionConfig,
        project: {
          root: projectContext.projectRoot,
          cwd: projectContext.cwd
        }
      });

      // Create message exchange (user + assistant in one)
      assistantMsgID = await sessionManager.createMessage(sessionID, agent.name, {
        user: {
          prompt: {
            task: resolvedInstructions,
            ...(userPrompt && { user: userPrompt })
          }
        },
        assistant: {
          system: systemMessages.map(m => m.content),
          modelID: agent.config.model,
          providerID: agent.config.model.split(':')[0],
          mode: 'build',
          path: { cwd: projectContext.cwd, root: projectContext.projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      });

      logger.debug(`Session created: ${sessionID}`);
    } catch (error) {
      logger.warn(`Failed to create session: ${(error as Error).message}`);
      if (verbose) {
        logger.debug(`Session creation error stack: ${(error as Error).stack}`);
      }
    }
  }

  // Load skill tool if project context is available
  let skillTools: Record<string, ToolSet[string]> = {};
  if (projectContext) {
    try {
      const { tool, skills } = await createSkillTool(projectContext.projectRoot, agent.config.tools);
      if (skills.length > 0) {
        skillTools['tools__skill'] = tool;
        logger.debug(`Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
      }
    } catch (error) {
      logger.warn(`Failed to load skills: ${(error as Error).message}`);
    }
  }

  // Load sub-agent tools if configured
  let subAgentTools: Record<string, ToolSet[string]> = {};
  if (agent.config.subagents && agent.config.subagents.length > 0) {
    const basePath = agentFilePath ? dirname(agentFilePath) : undefined;
    if (agentFilePath && verbose) {
      logger.debug(`[SubAgent] Agent file path: ${agentFilePath}`);
      logger.debug(`[SubAgent] Base path for sub-agents: ${basePath}`);
    }
    // Pass the parent's model to subagents so they inherit any model override
    subAgentTools = await createSubAgentTools(
      agent.config.subagents,
      basePath,
      agent.config.model,
      0,
      [],
      sessionManager,
      sessionID,
      agent.name,
      projectContext,
      abortSignal
    );

    if (verbose) {
      logger.debug(`[SubAgent] Loaded ${Object.keys(subAgentTools).length} sub-agent tool(s)`);
    }
  }

  // Merge all tools
  const tools = { ...mcpTools, ...configuredTools, ...skillTools, ...subAgentTools };

  if (Object.keys(tools).length > 0) {
    logger.debug(`Available tools: ${Object.keys(tools).join(', ')}`);
  }

  // Log step limit if it's non-default or in verbose mode
  if (maxSteps !== DEFAULT_MAX_STEPS || verbose) {
    logger.debug(`Max steps: ${maxSteps} (override via MAX_STEPS env var)`);
  }

  // Track subagent names for logging
  const subAgentNames = new Set(Object.keys(subAgentTools));

  // Build user message by concatenating task and user prompts
  const userMessage = userPrompt
    ? `${resolvedInstructions}\n\n${userPrompt}`
    : resolvedInstructions;

  return {
    tools,
    systemMessages,
    userMessage,
    maxSteps,
    subAgentNames,
    sessionID,
    assistantMsgID,
    doomLoopDetector
  };
}

export interface AgentChunk {
  type: 'text' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'error' | 'llm-start' | 'llm-first-token';
  text?: string;
  toolName?: string;
  toolCallId?: string;      // Tool call ID from AI SDK
  toolInput?: unknown;
  toolResult?: string;
  toolResultRaw?: unknown;
  error?: unknown;
  finishReason?: string;
  usage?: LanguageModelUsage;
  toolStartTime?: number;  // Track when tool started
  toolDuration?: number;    // Duration in ms
  isSubAgent?: boolean;     // Track if this tool is a subagent
  llmModel?: string;        // Model name for LLM traces
  llmStartTime?: number;    // When LLM call started
  llmFirstTokenTime?: number; // Time to first token
}

export interface RunAgentResult {
  text: string;
  usage?: LanguageModelUsage;
  toolCallCount: number;
  toolCallTraces?: ToolCallTrace[];
  finishReason?: string;
  finishReasons?: string[];
  hasTextOutput: boolean;
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
    agentName?: string;
    doomLoopDetector?: DoomLoopDetector;
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
  const pendingToolCalls = new Map<string, { name: string; startTime: number; partID?: string; input?: unknown }>();
  let currentLlmCall: { model: string; startTime: number; firstTokenTime?: number } | null = null;
  let llmSegmentCount = 0;
  let hasTextOutput = false;
  const finishReasons: string[] = [];
  const parts: AgentPart[] = [];

  // Track current text part for streaming updates with debouncing
  let currentTextPart: { partID: string; text: string; startTime: number } | null = null;
  let textUpdateTimer: NodeJS.Timeout | null = null;
  const TEXT_UPDATE_DEBOUNCE_MS = 500; // Write to disk every 500ms max

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
        logger.response(chunk.text!);

        // Log to session with debounced writes to prevent race conditions
        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName) {
          if (!currentTextPart) {
            // First text chunk: create new part (await to ensure partID is available)
            const startTime = Date.now();
            options.sessionManager.addPart(options.sessionID, options.agentName, options.messageID, {
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
                  options.sessionManager.updatePart(
                    options.sessionID,
                    options.agentName,
                    options.messageID,
                    partID,
                    {
                      text: getText()
                    }
                  ).catch(err => logger.debug(`Failed to update text part: ${err.message}`));
                }
                textUpdateTimer = null;
              }, TEXT_UPDATE_DEBOUNCE_MS);
            }
          }
        }
        break;
        
      case 'llm-start':
        // Track the start of an LLM generation
        if (chunk.llmModel) {
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
          if (currentLlmCall.startTime) {
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
        logger.tool(chunk.toolName!, chunk.toolInput, undefined, chunk.isSubAgent);
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

        // Log to session and track partID for later update
        if (options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName && chunk.toolCallId) {
          options.sessionManager.addPart(options.sessionID, options.agentName, options.messageID, {
            type: 'tool',
            callID: chunk.toolCallId,
            tool: chunk.toolName!,
            state: { status: 'pending' }  // Use discriminated union
          } as any).then(partID => {
            // Track partID so we can update it when result comes in
            const pending = pendingToolCalls.get(chunk.toolCallId!);
            if (pending) {
              pendingToolCalls.set(chunk.toolCallId!, { ...pending, partID });
            }
          }).catch(err => logger.debug(`Failed to log tool-call part: ${err.message}`));
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
        logger.toolResult(chunk.toolResult || 'No result', {
          ...(toolDuration !== undefined && { duration: toolDuration }),
          success: toolSuccess,
          ...(tokens && { tokens })
        });

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
              ...(tokens && { tokens })
            });

            // Update the session storage part with completed state
            if (pending.partID && options?.sessionManager && options?.sessionID && options?.messageID && options?.agentName) {
              // Build completed state with required fields
              const completedState: import('./session/types').ToolStateCompleted = {
                status: 'completed',
                input: pending.input || {},  // Use stored input from tool-call
                output: chunk.toolResultRaw || chunk.toolResult,
                time: {
                  start: pending.startTime,
                  end: Date.now()
                },
                ...(tokens && { metadata: { tokens } })
              };

              options.sessionManager.updatePart(options.sessionID, options.agentName, options.messageID, pending.partID, {
                state: completedState
              }).catch(err => logger.debug(`Failed to update tool part: ${err.message}`));
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
        
        if (finalText.trim()) {
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

/**
 * Core agent execution as an async generator
 */
export async function* executeAgentCore(
  agent: ParsedAgent,
  tools: ToolSet,
  options: {
    userMessage: string;
    systemMessages: Array<{role: string, content: string}>;
    maxSteps: number;
    abortSignal?: AbortSignal;
    subAgentNames?: Set<string>;  // Track which tools are subagents
  }
): AsyncGenerator<AgentChunk> {
  let model;
  try {
    model = await createModel(agent.config.model);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      // Re-throw with better message for the CLI to catch
      throw error;
    }
    throw error;
  }
  
  // Initialize context manager if enabled
  let contextManager: ContextManager | null = null;
  const initialMessages: any[] = [
    ...options.systemMessages,
    { role: 'user', content: options.userMessage }
  ];
  let messages = initialMessages;
  
  if (ContextManager.isEnabled()) {
    contextManager = new ContextManager(
      agent.config.model,
      async (messagesToCompact) => compactMessages(messagesToCompact, agent.config.model)
    );
    await contextManager.initialize();
    
    // Track initial messages
    for (const msg of messages) {
      contextManager.addMessage(msg);
    }
  }
  
  // Function to create stream with current messages
  const createStream = async () => {
    // Check if we need to compact before creating stream
    if (contextManager?.shouldCompact()) {
      messages = await contextManager.compact();
    }
    
    // Extract provider options based on model provider
    const provider = agent.config.model.split(':')[0];
    
    // Only include provider options if they exist and match the model provider
    let providerOptions: any = undefined;
    if (provider === 'openai' && agent.config.openai) {
      providerOptions = { openai: agent.config.openai };
    }
    // Future: Add other providers here
    // if (provider === 'anthropic' && agent.config.anthropic) {
    //   providerOptions = { anthropic: agent.config.anthropic };
    // }

    const streamConfig: any = {
      model,
      messages,
      maxRetries: MAX_RETRIES,
      toolChoice: 'auto' as const,
      stopWhen: stepCountIs(options.maxSteps),
      ...(options.abortSignal && { abortSignal: options.abortSignal }),
      ...(providerOptions && { providerOptions })
    };
    
    // Only add tools if there are any
    if (Object.keys(tools).length > 0) {
      streamConfig.tools = tools;
    }
    
    return streamText(streamConfig);
  };
  
  // Declare timing variables before use
  let accumulatedText = '';
  const toolStartTimes = new Map<string, number>();
  let llmGenerationStartTime: number | undefined;
  let llmFirstTokenTime: number | undefined;
  const currentLlmModel = agent.config.model;
  let stepCount = 0; // Track step count to detect when we're approaching limit
  
  let stream;
  try {
    // Track when we start the LLM generation
    llmGenerationStartTime = Date.now();
    yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };
    
    stream = await createStream();
  } catch (error: any) {
    // Handle initial stream creation errors
    const errorMessage = error?.message || String(error);
    const errorLower = errorMessage.toLowerCase();

    // Check for token limit errors
    if (
      errorLower.includes('context_length_exceeded') ||
      errorLower.includes('context length') ||
      errorLower.includes('maximum context') ||
      errorLower.includes('token limit') ||
      errorLower.includes('context window') ||
      errorLower.includes('too many tokens')
    ) {
      // Check if this is initial failure (no tool calls yet) vs mid-conversation
      const isInitialFailure = stepCount === 0;

      logger.error(isInitialFailure ? `
⚠️  INITIAL PROMPT TOO LARGE

Your initial prompt exceeds the model's context limit.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Reduce the size of your initial prompt/instructions
- Use a model with a larger context window (e.g., claude-sonnet-4-20250514)
- Split your task into multiple sequential steps

Error: ${errorMessage}` : `
⚠️  CONTEXT LIMIT EXCEEDED

The conversation history has grown too large for the model.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Lower the compaction threshold: COMPACTION_THRESHOLD=0.6 (current: 0.7)
- Keep fewer recent messages: COMPACTION_KEEP_RECENT=2 (current: 3)
- Use a model with a larger context window

Error: ${errorMessage}`);
    } else {
      logger.error('Failed to create stream:', error);
    }

    yield { type: 'error', error };
    return;
  }
  
  try {
    for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case 'tool-call': {
          stepCount++; // Each tool call counts as a step

          // Warn when approaching step limit
          if (stepCount >= options.maxSteps * 0.9 && stepCount < options.maxSteps) {
            logger.warn(`⚠️  Approaching step limit: ${stepCount}/${options.maxSteps} steps used`);
          } else if (stepCount >= options.maxSteps) {
            logger.warn(`⚠️  Step limit reached: ${stepCount}/${options.maxSteps} steps. Generation may be incomplete.`);
          }

          // Complete the current LLM generation segment before tool call
          if (llmGenerationStartTime) {
            const llmDuration = Date.now() - llmGenerationStartTime;
            // Emit a finish event for the LLM segment
            yield {
              type: 'finish',
              finishReason: 'tool-call' as any,
              toolStartTime: llmGenerationStartTime,
              toolDuration: llmDuration
            };
            llmGenerationStartTime = undefined;
            llmFirstTokenTime = undefined;
          }

          const startTime = Date.now();
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          toolStartTimes.set(toolCallId, startTime);

          yield {
            type: 'tool-call',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolInput: (chunk as any).input || (chunk as any).args,
            toolStartTime: startTime,
            ...(options.subAgentNames?.has(chunk.toolName!) && { isSubAgent: true })
          };
          break;
        }
          
        case 'tool-result': {
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;
          
          // Track tool results in context
          if (contextManager) {
            // Use simple format for tool message
            const toolResultMessage: any = {
              role: 'tool',
              content: [{
                type: 'tool-result',
                toolCallId,
                toolName: chunk.toolName,
                output: parseToolResult(chunk)
              }]
            };
            contextManager.addMessage(toolResultMessage);
          }
          
          yield {
            type: 'tool-result',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolResult: parseToolResult(chunk),
            toolResultRaw: (chunk as any).result || (chunk as any).output,
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration })
          };
          
          // Clean up
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }
          
          // Start tracking new LLM generation segment after tool result
          llmGenerationStartTime = Date.now();
          llmFirstTokenTime = undefined;
          yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };
          break;
        }
          
        case 'tool-error': {
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;
          
          // Pass tool errors as structured results to let AI decide on retry
          const errorMessage = (chunk as any).error?.message || (chunk as any).error || 'Unknown error';
          yield {
            type: 'tool-result',  // Treat as result so AI sees it
            toolName: chunk.toolName,
            toolResult: JSON.stringify({
              success: false,
              error: {
                type: classifyError(errorMessage),
                message: errorMessage,
                retryable: isRetryable(errorMessage),
                suggestions: getSuggestions(errorMessage)
              }
            }),
            toolResultRaw: { error: errorMessage },
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration })
          };
          
          // Clean up
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }
          break;
        }
          
        case 'text-delta':
          const textContent = (chunk as any).text || (chunk as any).textDelta || (chunk as any).delta || (chunk as any).content;
          if (textContent && typeof textContent === 'string') {
            // Track time to first token
            if (!llmFirstTokenTime && llmGenerationStartTime) {
              llmFirstTokenTime = Date.now();
              yield { type: 'llm-first-token', llmFirstTokenTime };
            }
            accumulatedText += textContent;
            yield { type: 'text', text: textContent };
          }
          break;
          
        case 'finish':
          // Track the assistant's message
          if (contextManager && accumulatedText) {
            const assistantMessage: any = {
              role: 'assistant',
              content: accumulatedText
            };
            contextManager.addMessage(assistantMessage);
            accumulatedText = '';
          }

          // Update usage if available
          const usage = (chunk as any).totalUsage || (chunk as any).usage;
          if (contextManager && usage) {
            contextManager.updateUsage(usage);
          }

          // Log finish reason for debugging and warnings
          const finishReason = chunk.finishReason;
          if (finishReason === 'length') {
            logger.warn(`
⚠️  OUTPUT LENGTH LIMIT REACHED

The model reached its maximum output token limit. The response was truncated.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Use a model with a larger output limit
- Ask the agent to be more concise in its responses

Current step: ${stepCount}/${options.maxSteps}`);
          } else if (finishReason === 'content-filter') {
            logger.warn(`⚠️  Content filter triggered. Response may be incomplete.`);
          } else if (finishReason === 'error') {
            logger.warn(`⚠️  Generation stopped due to an error.`);
          }
          // Note: We can't directly detect step limit from finishReason, as AI SDK uses 'stop'
          
          // Complete final LLM segment if exists
          if (llmGenerationStartTime) {
            const llmDuration = Date.now() - llmGenerationStartTime;
            yield {
              type: 'finish',
              finishReason: chunk.finishReason,
              usage,
              toolStartTime: llmGenerationStartTime,
              toolDuration: llmDuration
            };
            llmGenerationStartTime = undefined;
            llmFirstTokenTime = undefined;
          } else {
            yield {
              type: 'finish',
              finishReason: chunk.finishReason,
              usage
            };
          }
          
          // We can't directly detect step limit from finishReason alone
          // since AI SDK just reports 'stop' when stepCountIs condition is met
          // But we can check our step count
          if (stepCount >= options.maxSteps && chunk.finishReason === 'stop') {
            logger.warn(`
⚠️  Agent stopped at step limit (${options.maxSteps} steps).
   To increase the limit, set MAX_STEPS environment variable:
   MAX_STEPS=2000 agentuse run <agent-file>`);
          }
          break;
          
        case 'error':
          yield { type: 'error', error: chunk.error };
          break;

        case 'abort':
          logger.warn(`⚠️  Stream aborted - likely due to timeout or cancellation (${stepCount} steps completed)`);
          // Create an AbortError to properly signal timeout
          const abortError = new Error('Stream aborted - execution timeout or manual cancellation');
          abortError.name = 'AbortError';
          yield { type: 'error', error: abortError };
          return;

        // Handle other AI SDK chunk types that we don't need to process but shouldn't warn about
        case 'finish-step':
        case 'start-step':
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
        case 'text-start':
        case 'text-end':
          // AI SDK streaming events for text generation boundaries (not tool-related)
          // These indicate when the LLM starts/stops generating text content
          // Safe to ignore as they don't require processing
          break;

        default:
          logger.debug(`[STREAM] Unknown chunk type received: ${chunk.type}`);
          break;
      }
    }

  } catch (error: any) {
    // Check for token limit errors first
    const errorMessage = error?.message || String(error);
    const errorLower = errorMessage.toLowerCase();

    if (
      errorLower.includes('context_length_exceeded') ||
      errorLower.includes('context length') ||
      errorLower.includes('maximum context') ||
      errorLower.includes('token limit') ||
      errorLower.includes('context window') ||
      errorLower.includes('too many tokens')
    ) {
      logger.error(`
⚠️  CONTEXT LIMIT EXCEEDED

The conversation history has grown too large for the model.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Lower the compaction threshold: COMPACTION_THRESHOLD=0.6 (current: 0.7)
- Keep fewer recent messages: COMPACTION_KEEP_RECENT=2 (current: 3)
- Use a model with a larger context window

Current step: ${stepCount}
Error: ${errorMessage}`);
      yield { type: 'error', error };
      return;
    }

    // Handle AI SDK errors gracefully
    if (error.name === 'AI_NoSuchToolError' || error.message?.includes('unavailable tool')) {
      // Extract tool name from the error message
      const toolNameMatch = error.message?.match(/tool '([^']+)'/);
      const toolName = toolNameMatch ? toolNameMatch[1] : 'unknown';
      
      logger.warn(`AI tried to call non-existent tool: ${toolName}`);
      
      // Return this as a tool result so the AI can adapt
      yield {
        type: 'tool-result',
        toolName: toolName,
        toolResult: JSON.stringify({
          success: false,
          error: {
            type: 'tool_not_found',
            message: `The tool '${toolName}' does not exist. Available tools: ${Object.keys(tools).join(', ')}`,
            retryable: false,
            suggestions: [
              'Check the available tools list',
              'Use a different tool with similar functionality',
              'Proceed without this tool'
            ]
          }
        }),
        toolResultRaw: { error: error.message }
      };
      
      // Continue execution - don't terminate the agent
      // The AI will receive the error as a tool result and can adapt
      
    } else {
      // For other errors, still try to handle gracefully
      logger.error('Stream processing error:', error);
      yield { type: 'error', error };
    }
  }
}

/**
 * Classify error type for intelligent retry decisions
 */
function classifyError(error: string): string {
  const errorLower = error.toLowerCase();
  if (errorLower.includes('no such tool') || errorLower.includes('unavailable tool') || errorLower.includes('tool not found')) {
    return 'tool_not_found';
  }
  if (errorLower.includes('500') || errorLower.includes('502') || errorLower.includes('503') || errorLower.includes('service unavailable')) {
    return 'server_error';
  }
  if (errorLower.includes('429') || errorLower.includes('rate limit')) {
    return 'rate_limit';
  }
  if (errorLower.includes('timeout') || errorLower.includes('timed out')) {
    return 'timeout';
  }
  if (errorLower.includes('401') || errorLower.includes('403') || errorLower.includes('unauthorized') || errorLower.includes('forbidden')) {
    return 'auth_error';
  }
  if (errorLower.includes('404') || errorLower.includes('not found')) {
    return 'not_found';
  }
  if (errorLower.includes('network') || errorLower.includes('connection')) {
    return 'network_error';
  }
  return 'unknown';
}

/**
 * Determine if error is retryable
 */
function isRetryable(error: string): boolean {
  const type = classifyError(error);
  return ['server_error', 'rate_limit', 'timeout', 'network_error'].includes(type);
}

/**
 * Get recovery suggestions based on error type
 */
function getSuggestions(error: string): string[] {
  const type = classifyError(error);
  switch (type) {
    case 'tool_not_found':
      return ['Check the available tools list', 'Use a different tool with similar functionality', 'Proceed without this tool'];
    case 'server_error':
      return ['Wait a moment and retry', 'Try alternative approach', 'Proceed with available information'];
    case 'rate_limit':
      return ['Wait before retrying', 'Use different tool', 'Reduce request frequency'];
    case 'timeout':
      return ['Retry with simpler request', 'Break into smaller tasks', 'Try alternative tool'];
    case 'auth_error':
      return ['Check credentials', 'Use different service', 'Proceed without this data'];
    case 'not_found':
      return ['Verify parameters', 'Try different search terms', 'Resource may not exist'];
    case 'network_error':
      return ['Check connection and retry', 'Try alternative service', 'Wait and retry'];
    default:
      return ['Review error details', 'Try alternative approach', 'Proceed with caution'];
  }
}

/**
 * Parse tool result from various formats
 */
function parseToolResult(chunk: any): string {
  let output = chunk.result || chunk.output;
  
  if (typeof output === 'object' && output !== null) {
    if (output.output) {
      output = output.output;
    } else if (output.content) {
      // Handle MCP content array format
      if (Array.isArray(output.content)) {
        output = output.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('\n\n');
      } else {
        output = output.content;
      }
    } else if (output.result) {
      output = output.result;
    } else {
      output = JSON.stringify(output);
    }
  }
  
  const resultStr = typeof output === 'string' ? output : JSON.stringify(output);
  
  // Detect if the result looks like an error message
  if (resultStr && typeof resultStr === 'string') {
    const errorPatterns = [
      /^Error:/i,
      /^Error executing/i,
      /^Failed to/i,
      /authentication.*failed/i,
      /unauthorized/i,
      /permission denied/i,
      /not found/i,
      /invalid.*token/i,
      /invalid.*api.*key/i
    ];
    
    for (const pattern of errorPatterns) {
      if (pattern.test(resultStr)) {
        // Extract operation from error message or use generic "operation"
        let operation = 'operation';
        
        // Try to extract operation context from error message
        const commandMatch = resultStr.match(/['"`]([^'"`]+)['"`]/);
        const fileMatch = resultStr.match(/(?:file|path|directory)\s+['"`]?([^\s'"`]+)/i);
        const actionMatch = resultStr.match(/(?:failed to|cannot|unable to)\s+(\w+)/i);
        
        if (commandMatch) {
          operation = commandMatch[1];
        } else if (fileMatch) {
          operation = fileMatch[1];
        } else if (actionMatch) {
          operation = actionMatch[1];
        }
        
        logger.warnWithTool(chunk.toolName || 'unknown', operation, resultStr);
        break;
      }
    }
  }
  
  return resultStr;
}

/**
 * Run an agent with AI and MCP tools
 * @param agent Parsed agent configuration
 * @param mcpClients Connected MCP clients
 * @param debug Enable debug logging
 * @param abortSignal Optional abort signal for cancellation
 * @param startTime Optional start time for timing
 * @param verbose Enable verbose logging
 * @param agentFilePath Optional path to the agent file for resolving sub-agent paths
 * @param cliMaxSteps Optional CLI override for max steps
 */
export async function runAgent(
  agent: ParsedAgent,
  mcpClients: MCPConnection[],
  _debug: boolean = false,
  abortSignal?: AbortSignal,
  startTime?: number,
  verbose: boolean = false,
  agentFilePath?: string,
  cliMaxSteps?: number,
  sessionManager?: SessionManager,
  projectContext?: { projectRoot: string; cwd: string },
  userPrompt?: string,
  preparedExecution?: PreparedAgentExecution
): Promise<RunAgentResult> {
  try {
    // Log initialization time if verbose
    if (verbose && startTime) {
      const initTime = Date.now() - startTime;
      logger.info(`Initialization completed in ${initTime}ms`);
    }

    // Use shared preparation logic (allow caller to precompute to avoid duplicate work)
    const preparation = preparedExecution ?? await prepareAgentExecution({
      agent,
      mcpClients,
      agentFilePath,
      cliMaxSteps,
      sessionManager,
      projectContext,
      userPrompt,
      abortSignal,
      verbose
    });

    const {
      tools,
      systemMessages,
      userMessage,
      maxSteps,
      subAgentNames,
      sessionID,
      assistantMsgID,
      doomLoopDetector
    } = preparation;

    // Execute using the core generator
    const coreOptions = {
      userMessage,
      systemMessages,
      maxSteps,
      subAgentNames,
      ...(abortSignal && { abortSignal })
    };

    const result = await processAgentStream(
      executeAgentCore(agent, tools, coreOptions),
      sessionManager && sessionID && assistantMsgID ? {
        collectToolCalls: true,
        sessionManager,
        sessionID,
        messageID: assistantMsgID,
        agentName: agent.name,
        doomLoopDetector
      } : {
        collectToolCalls: true,
        doomLoopDetector
      }
    );
    
    logger.debug(`Agent finish reasons: ${result.finishReasons?.join(', ') ?? 'none'}`);
    logger.debug(`Agent produced text output: ${result.hasTextOutput}`);
    
    // Display execution summary
    const mainTokens = result.usage?.totalTokens || 0;
    const subTokens = result.subAgentTokens || 0;
    const totalTokens = mainTokens + subTokens;
    const durationMs = startTime ? Date.now() - startTime : 0;
    const toolCallCount = result.toolCalls?.length || 0;

    logger.separator();
    logger.summary({
      success: true,
      durationMs,
      ...(totalTokens > 0 && { tokensUsed: totalTokens }),
      ...(toolCallCount > 0 && { toolCallCount }),
    });

    // Update session message with final token usage
    if (sessionManager && sessionID && assistantMsgID && result.usage) {
      try {
        await sessionManager.updateMessage(sessionID, agent.name, assistantMsgID, {
          time: { completed: Date.now() },
          assistant: {
            tokens: {
              input: result.usage.inputTokens || 0,
              output: result.usage.outputTokens || 0
            }
          }
        });
      } catch (error) {
        logger.debug(`Failed to update message with token usage: ${(error as Error).message}`);
      }
    }

    // Return metrics for plugin system
    return {
      text: result.text,
      ...(result.usage && { usage: result.usage }),
      toolCallCount: result.toolCalls?.length || 0,
      ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces }),
      ...(result.finishReason && { finishReason: result.finishReason }),
      ...(result.finishReasons && { finishReasons: result.finishReasons }),
      hasTextOutput: result.hasTextOutput
    };
  } catch (error: unknown) {
    // Check if it's an abort error from timeout
    if ((error instanceof Error && error.name === 'AbortError') || (abortSignal && abortSignal.aborted)) {
      // Timeout already handled by caller
      throw error;
    }
    logger.error('Agent execution failed', error as Error);
    throw error;
  } finally {
    // Clean up MCP clients (like opencode does)
    for (const connection of mcpClients) {
      try {
        await connection.client.close();
        if (connection.rawClient) {
          await connection.rawClient.close();
        }
        logger.debug(`Closed MCP client: ${connection.name}`);
      } catch (error) {
        // Ignore errors when closing MCP clients
      }
    }
  }
}
