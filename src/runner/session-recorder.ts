import type { SessionManager } from '../session';
import type { ActiveContextUsage, ContextSnapshot, ToolState } from '../session/types';
import type { AssistantTokens } from '../session/usage';
import { logger } from '../utils/logger';

interface SessionBinding {
  manager: SessionManager;
  sessionID: string;
  agentId: string;
}

export interface SessionRecorderOptions {
  sessionManager?: SessionManager;
  sessionID?: string;
  messageID?: string;
  agentId?: string;
  debounceMs?: number;
}

type StreamingPart = {
  partID?: string;
  text: string;
  startTime: number;
  createPromise?: Promise<void>;
};

type ReasoningStreamingPart = StreamingPart & { blockId?: string };

/**
 * The durable projection of normalized run events.
 *
 * This class is the only owner of streamed text/reasoning parts, tool lifecycle
 * states, usage updates, and context snapshots. It deliberately knows nothing
 * about terminal formatting, so a structured session event is recorded once
 * and rendered independently by each surface.
 */
export class SessionRecorder {
  private readonly binding?: SessionBinding;
  private readonly messageID: string | undefined;
  private readonly debounceMs: number;
  private readonly pendingUpdates = new Set<Promise<unknown>>();
  private readonly toolPartPromises = new Map<string, Promise<string | undefined>>();
  private currentTextPart: StreamingPart | null = null;
  private currentReasoningPart: ReasoningStreamingPart | null = null;
  private textUpdateTimer: NodeJS.Timeout | null = null;
  private reasoningUpdateTimer: NodeJS.Timeout | null = null;

  constructor(options: SessionRecorderOptions = {}) {
    const { sessionManager, sessionID, messageID, agentId } = options;
    if (sessionManager && sessionID && agentId) {
      this.binding = { manager: sessionManager, sessionID, agentId };
    }
    this.messageID = messageID;
    this.debounceMs = options.debounceMs ?? 500;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pendingUpdates.add(promise);
    void promise.finally(() => this.pendingUpdates.delete(promise));
    return promise;
  }

  async reasoningDelta(text: string, blockId?: string): Promise<void> {
    const binding = this.binding;
    const messageID = this.messageID;
    if (!binding || !messageID || !text) return;

    if (this.currentReasoningPart && this.currentReasoningPart.blockId !== blockId) {
      await this.finalizeReasoning();
    }

    if (!this.currentReasoningPart) {
      const part: ReasoningStreamingPart = {
        text,
        startTime: Date.now(),
        ...(blockId !== undefined && { blockId }),
      };
      this.currentReasoningPart = part;
      const createPromise = binding.manager.addPart(binding.sessionID, binding.agentId, messageID, {
        type: 'reasoning',
        text,
        time: { start: part.startTime },
      } as any).then((partID) => {
        part.partID = partID;
      }).catch((error) => {
        logger.debug(`Failed to create reasoning part: ${error.message}`);
      });
      part.createPromise = createPromise;
      this.track(createPromise);
      return;
    }

    const part = this.currentReasoningPart;
    part.text += text;
    if (this.reasoningUpdateTimer) clearTimeout(this.reasoningUpdateTimer);
    this.reasoningUpdateTimer = setTimeout(() => {
      const updatePromise = Promise.resolve().then(async () => {
        if (part.createPromise) await part.createPromise;
        if (!part.partID) return;
        await binding.manager.updatePart(binding.sessionID, binding.agentId, messageID, part.partID, {
          text: part.text,
        });
      }).catch((error) => logger.debug(`Failed to update reasoning part: ${error.message}`));
      this.track(updatePromise);
      this.reasoningUpdateTimer = null;
    }, this.debounceMs);
  }

  textDelta(text: string): void {
    const binding = this.binding;
    const messageID = this.messageID;
    if (!binding || !messageID || !text) return;

    if (!this.currentTextPart) {
      const part: StreamingPart = { text, startTime: Date.now() };
      this.currentTextPart = part;
      const createPromise = binding.manager.addPart(binding.sessionID, binding.agentId, messageID, {
        type: 'text',
        text,
        time: { start: part.startTime },
      } as any).then((partID) => {
        part.partID = partID;
      }).catch((error) => {
        logger.debug(`Failed to create text part: ${error.message}`);
      });
      part.createPromise = createPromise;
      this.track(createPromise);
      return;
    }

    const part = this.currentTextPart;
    part.text += text;
    if (this.textUpdateTimer) clearTimeout(this.textUpdateTimer);
    this.textUpdateTimer = setTimeout(() => {
      const updatePromise = Promise.resolve().then(async () => {
        if (part.createPromise) await part.createPromise;
        if (!part.partID) return;
        await binding.manager.updatePart(binding.sessionID, binding.agentId, messageID, part.partID, {
          text: part.text,
        });
      }).catch((error) => logger.debug(`Failed to update text part: ${error.message}`));
      this.track(updatePromise);
      this.textUpdateTimer = null;
    }, this.debounceMs);
  }

  async finalizeReasoning(): Promise<void> {
    if (this.reasoningUpdateTimer) {
      clearTimeout(this.reasoningUpdateTimer);
      this.reasoningUpdateTimer = null;
    }
    const binding = this.binding;
    const messageID = this.messageID;
    const part = this.currentReasoningPart;
    this.currentReasoningPart = null;
    if (!binding || !messageID || !part) return;
    if (part.createPromise) await part.createPromise;
    if (!part.partID) return;
    try {
      await binding.manager.updatePart(binding.sessionID, binding.agentId, messageID, part.partID, {
        text: part.text.trimEnd(),
        time: { start: part.startTime, end: Date.now() },
      });
    } catch (error) {
      logger.debug(`Failed to finalize reasoning part: ${(error as Error).message}`);
    }
  }

  async finalizeText(): Promise<void> {
    if (this.textUpdateTimer) {
      clearTimeout(this.textUpdateTimer);
      this.textUpdateTimer = null;
    }
    const binding = this.binding;
    const messageID = this.messageID;
    const part = this.currentTextPart;
    this.currentTextPart = null;
    if (!binding || !messageID || !part) return;
    if (part.createPromise) await part.createPromise;
    if (!part.partID) return;
    try {
      await binding.manager.updatePart(binding.sessionID, binding.agentId, messageID, part.partID, {
        text: part.text.trimEnd(),
        time: { start: part.startTime, end: Date.now() },
      });
    } catch (error) {
      logger.debug(`Failed to finalize text part: ${(error as Error).message}`);
    }
  }

  async finalizeStreaming(): Promise<void> {
    await this.finalizeReasoning();
    await this.finalizeText();
  }

  recordUsage(tokens?: AssistantTokens, context?: ActiveContextUsage): void {
    const binding = this.binding;
    const messageID = this.messageID;
    if (!binding || !messageID || (!tokens && !context)) return;
    const updatePromise = binding.manager.updateMessage(binding.sessionID, binding.agentId, messageID, {
      assistant: {
        ...(tokens && { tokens }),
        ...(context && { context }),
      },
    }).catch((error) => logger.debug(`Failed to persist interim ${tokens ? 'usage' : 'context usage'}: ${error.message}`));
    this.track(updatePromise);
  }

  toolStarted(options: { callID: string; tool: string; input: unknown; startTime: number }): void {
    const binding = this.binding;
    const messageID = this.messageID;
    if (!binding || !messageID) return;
    const addPartPromise = binding.manager.addPart(binding.sessionID, binding.agentId, messageID, {
      type: 'tool',
      callID: options.callID,
      tool: options.tool,
      state: {
        status: 'running',
        input: options.input,
        time: { start: options.startTime },
      },
    } as any).catch((error) => {
      logger.debug(`Failed to log tool-call part: ${error.message}`);
      return undefined;
    });
    this.toolPartPromises.set(options.callID, addPartPromise);
    this.track(addPartPromise);
  }

  async updateTool(callID: string, state: ToolState): Promise<boolean> {
    const binding = this.binding;
    const messageID = this.messageID;
    const partPromise = this.toolPartPromises.get(callID);
    if (!binding || !messageID || !partPromise) return false;
    const partID = await partPromise;
    if (!partID) return false;
    try {
      await binding.manager.updatePart(binding.sessionID, binding.agentId, messageID, partID, { state });
      return true;
    } catch (error) {
      logger.debug(`Failed to update tool part: ${(error as Error).message}`);
      return false;
    }
  }

  async writeContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    try {
      await binding.manager.writeContextSnapshot(binding.sessionID, binding.agentId, {
        ...snapshot,
        ...(this.messageID && { messageID: this.messageID }),
      });
    } catch (error) {
      logger.debug(`Failed to persist suspension context snapshot: ${(error as Error).message}`);
    }
  }

  async flush(): Promise<void> {
    await this.finalizeStreaming();
    while (this.pendingUpdates.size > 0) {
      await Promise.allSettled([...this.pendingUpdates]);
    }
  }
}
