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
  private agentName: string | null = null;
  private parentPath: string | null = null; // For subagents: "{mainSessionID}-{mainAgentName}/subagent"
  private fullPath: string | null = null; // Full path to this session's directory

  /**
   * Build full session directory path
   */
  private buildSessionPath(sessionID: string, agentName: string): string {
    const sanitizedAgentName = sanitizeAgentName(agentName);
    const sessionDir = `${sessionID}-${sanitizedAgentName}`;

    if (this.parentPath) {
      return `${this.parentPath}/${sessionDir}`;
    }
    return sessionDir;
  }

  /**
   * Create a new session
   */
  async createSession(info: Omit<SessionInfo, 'id' | 'time'>): Promise<string> {
    const id = ulid();
    const now = Date.now();

    const session: SessionInfo = {
      ...info,
      id,
      time: {
        created: now,
        updated: now
      }
    };

    const sessionPath = this.buildSessionPath(id, info.agent.name);
    await writeJSON(`${sessionPath}/session`, session);

    this.sessionID = id;
    this.agentName = sanitizeAgentName(info.agent.name);
    this.fullPath = sessionPath;

    return id;
  }

  /**
   * Create a message exchange (user + assistant in one)
   */
  async createMessage(
    sessionID: string,
    agentName: string,
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

    const sessionPath = this.buildSessionPath(sessionID, agentName);
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
    agentName: string,
    messageID: string,
    partData: Omit<Part, 'id' | 'sessionID' | 'messageID'>
  ): Promise<string> {
    const id = ulid();
    const sessionPath = this.buildSessionPath(sessionID, agentName);

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
   */
  async updatePart(sessionID: string, agentName: string, messageID: string, partID: string, updates: Partial<Part>): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    // New path structure: {messageID}/part/{partID}.json
    const key = `${sessionPath}/${messageID}/part/${partID}`;

    const existing = await readJSON<Part>(key);
    if (existing) {
      const updated = { ...existing, ...updates };
      await writeJSON(key, updated);
    }
  }

  /**
   * Update session info
   */
  async updateSession(sessionID: string, agentName: string, updates: Partial<Omit<SessionInfo, 'id'>>): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    const key = `${sessionPath}/session`;

    const session = await readJSON<SessionInfo>(key);
    if (session) {
      Object.assign(session, updates);
      session.time.updated = Date.now();
      await writeJSON(key, session);
    }
  }

  /**
   * Update message (typically for updating assistant response data)
   */
  async updateMessage(
    sessionID: string,
    agentName: string,
    messageID: string,
    updates: DeepPartial<Omit<Message, 'id' | 'sessionID'>>
  ): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    // New path structure: {messageID}/message.json
    const key = `${sessionPath}/${messageID}/message`;

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
    return this.agentName;
  }

  /**
   * Get session info
   */
  async getSession(sessionID: string, agentName: string): Promise<SessionInfo | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    return readJSON<SessionInfo>(`${sessionPath}/session`);
  }

  /**
   * Get message
   */
  async getMessage(sessionID: string, agentName: string, messageID: string): Promise<Message | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    // New path structure: {messageID}/message.json
    return readJSON<Message>(`${sessionPath}/${messageID}/message`);
  }

  /**
   * Get part
   */
  async getPart(sessionID: string, agentName: string, messageID: string, partID: string): Promise<Part | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
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
    agentName: string,
    error: { message: string; code: string }
  ): Promise<void> {
    await this.updateSession(sessionID, agentName, {
      error: {
        ...error,
        time: Date.now()
      }
    });
  }

  /**
   * Get the full path to this session's directory
   */
  getFullPath(): string | null {
    return this.fullPath;
  }
}
