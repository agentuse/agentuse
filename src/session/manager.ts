import { ulid } from 'ulid';
import { writeJSON, readJSON, sanitizeAgentName } from '../storage';
import type {
  SessionInfo,
  Part,
  Message,
  DeepPartial
} from './types';

export class SessionManager {
  private sessionID: string | null = null;
  private agentId: string | null = null;
  private parentPath: string | null = null; // For subagents: "{mainSessionID}-{mainAgentId}/subagent"
  private fullPath: string | null = null; // Full path to this session's directory

  // Write queues to prevent concurrent read-modify-write races
  // Key is the file path, value is a promise chain
  private writeQueues: Map<string, Promise<void>> = new Map();

  /**
   * Execute a write operation with serialization to prevent race conditions.
   * All writes to the same key are queued and executed in order.
   */
  private async serializedWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const currentQueue = this.writeQueues.get(key) ?? Promise.resolve();

    let result: T;
    const newQueue = currentQueue.then(async () => {
      result = await operation();
    }).catch(() => {
      // Don't let previous errors block the queue
    });

    this.writeQueues.set(key, newQueue);
    await newQueue;
    return result!;
  }

  /**
   * Build full session directory path
   * Uses agent.id (file-path-based identifier) for directory naming
   */
  private buildSessionPath(sessionID: string, agentId: string): string {
    const sanitizedAgentId = sanitizeAgentName(agentId);
    const sessionDir = `${sessionID}-${sanitizedAgentId}`;

    if (this.parentPath) {
      return `${this.parentPath}/${sessionDir}`;
    }
    return sessionDir;
  }

  /**
   * Create a new session
   */
  async createSession(info: Omit<SessionInfo, 'id' | 'time' | 'status'>): Promise<string> {
    const id = ulid();
    const now = Date.now();

    const session: SessionInfo = {
      ...info,
      id,
      status: 'running',
      time: {
        created: now,
        updated: now
      }
    };

    const sessionPath = this.buildSessionPath(id, info.agent.id);
    await writeJSON(`${sessionPath}/session`, session);

    this.sessionID = id;
    this.agentId = sanitizeAgentName(info.agent.id);
    this.fullPath = sessionPath;

    return id;
  }

  /**
   * Create a message exchange (user + assistant in one)
   */
  async createMessage(
    sessionID: string,
    agentId: string,
    data: {
      user: {
        prompt: {
          task: string;
          user?: string;
        };
      };
      assistant: {
        system: string[];
        modelID: string;
        providerID: string;
        mode: string;
        path: { cwd: string; root: string };
        cost: number;
        tokens: {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
      };
    }
  ): Promise<string> {
    const id = ulid();

    const message: Message = {
      id,
      sessionID,
      time: { created: Date.now() },
      ...data
    };

    const sessionPath = this.buildSessionPath(sessionID, agentId);
    // New path structure: {messageID}/message.json
    await writeJSON(`${sessionPath}/${id}/message`, message);
    return id;
  }

  /**
   * Add a part to a message
   * Accepts part data without base fields (id, sessionID, messageID) and adds them
   */
  async addPart(
    sessionID: string,
    agentId: string,
    messageID: string,
    partData: Omit<Part, 'id' | 'sessionID' | 'messageID'>
  ): Promise<string> {
    const id = ulid();
    const sessionPath = this.buildSessionPath(sessionID, agentId);

    // Add base fields to create complete Part
    const completePart: Part = {
      ...partData,
      id,
      sessionID,
      messageID,
    } as Part; // Type assertion needed due to discriminated union complexity

    // New path structure: {messageID}/part/{partID}.json
    await writeJSON(`${sessionPath}/${messageID}/part/${id}`, completePart);
    return id;
  }

  /**
   * Update an existing part
   * Uses serialized writes to prevent race conditions during concurrent updates
   */
  async updatePart(sessionID: string, agentId: string, messageID: string, partID: string, updates: Partial<Part>): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    // New path structure: {messageID}/part/{partID}.json
    const key = `${sessionPath}/${messageID}/part/${partID}`;

    await this.serializedWrite(key, async () => {
      const existing = await readJSON<Part>(key);
      if (existing) {
        const updated = { ...existing, ...updates };
        await writeJSON(key, updated);
      }
    });
  }

  /**
   * Update session info
   * Uses serialized writes to prevent race conditions during concurrent updates
   */
  async updateSession(sessionID: string, agentId: string, updates: Partial<Omit<SessionInfo, 'id'>>): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    const key = `${sessionPath}/session`;

    await this.serializedWrite(key, async () => {
      const session = await readJSON<SessionInfo>(key);
      if (session) {
        Object.assign(session, updates);
        session.time.updated = Date.now();
        await writeJSON(key, session);
      }
    });
  }

  /**
   * Update message (typically for updating assistant response data)
   * Uses serialized writes to prevent race conditions during concurrent updates
   */
  async updateMessage(
    sessionID: string,
    agentId: string,
    messageID: string,
    updates: DeepPartial<Omit<Message, 'id' | 'sessionID'>>
  ): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    // New path structure: {messageID}/message.json
    const key = `${sessionPath}/${messageID}/message`;

    await this.serializedWrite(key, async () => {
      const message = await readJSON<Message>(key);
      if (message) {
        // Deep merge for nested objects (time, assistant, user)
        if (updates.time) {
          message.time = { ...message.time, ...updates.time } as Message['time'];
        }
        if (updates.assistant) {
          const assistantUpdates = updates.assistant;
          // Deep merge tokens if provided
          if (assistantUpdates.tokens) {
            message.assistant.tokens = { ...message.assistant.tokens, ...assistantUpdates.tokens } as Message['assistant']['tokens'];
          }
          // Merge other assistant fields (excluding tokens which we handled above)
          const { tokens: _, ...otherAssistantUpdates } = assistantUpdates;
          message.assistant = { ...message.assistant, ...otherAssistantUpdates } as Message['assistant'];
        }
        if (updates.user) {
          message.user = { ...message.user, ...updates.user } as Message['user'];
        }
        await writeJSON(key, message);
      }
    });
  }

  /**
   * Get current session ID
   */
  getCurrentSessionID(): string | null {
    return this.sessionID;
  }

  /**
   * Get current agent name
   */
  getCurrentAgentName(): string | null {
    return this.agentId;
  }

  /**
   * Get session info
   */
  async getSession(sessionID: string, agentId: string): Promise<SessionInfo | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    return readJSON<SessionInfo>(`${sessionPath}/session`);
  }

  /**
   * Get message
   */
  async getMessage(sessionID: string, agentId: string, messageID: string): Promise<Message | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    // New path structure: {messageID}/message.json
    return readJSON<Message>(`${sessionPath}/${messageID}/message`);
  }

  /**
   * Get part
   */
  async getPart(sessionID: string, agentId: string, messageID: string, partID: string): Promise<Part | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    // New path structure: {messageID}/part/{partID}.json
    return readJSON<Part>(`${sessionPath}/${messageID}/part/${partID}`);
  }

  /**
   * Set parent path for subagent sessions
   * @param parentFullPath The full path of the parent session
   */
  setParentPath(parentFullPath: string): void {
    this.parentPath = `${parentFullPath}/subagent`;
  }

  /**
   * Set error on session (for failures before LLM calls - auth, MCP, etc.)
   */
  async setSessionError(
    sessionID: string,
    agentId: string,
    error: { message: string; code: string }
  ): Promise<void> {
    await this.updateSession(sessionID, agentId, {
      status: 'error',
      error: {
        ...error,
        time: Date.now()
      }
    });
  }

  /**
   * Mark session as completed successfully
   */
  async setSessionCompleted(sessionID: string, agentId: string): Promise<void> {
    await this.updateSession(sessionID, agentId, {
      status: 'completed'
    });
  }

  /**
   * Get the full path to this session's directory
   */
  getFullPath(): string | null {
    return this.fullPath;
  }
}
