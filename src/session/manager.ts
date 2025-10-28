import { ulid } from 'ulid';
import { writeJSON, readJSON, sanitizeAgentName } from '../storage';
import type {
  SessionInfo,
  UserMessage,
  AssistantMessage,
  Part,
  Message
} from './types';

export class SessionManager {
  private sessionID: string | null = null;
  private agentName: string | null = null;
  private parentPath: string | null = null; // For subagents: "{mainSessionID}-{mainAgentName}/subagent"

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

    return id;
  }

  /**
   * Create a user message
   */
  async createUserMessage(sessionID: string, agentName?: string): Promise<string> {
    const id = ulid();
    const effectiveAgentName = agentName || this.agentName;

    if (!effectiveAgentName) {
      throw new Error('Agent name is required for creating messages');
    }

    const message: UserMessage = {
      id,
      role: 'user',
      sessionID,
      time: { created: Date.now() }
    };

    const sessionPath = this.buildSessionPath(sessionID, effectiveAgentName);
    await writeJSON(`${sessionPath}/message/${id}`, message);
    return id;
  }

  /**
   * Create an assistant message
   */
  async createAssistantMessage(
    sessionID: string,
    agentName: string,
    data: Omit<AssistantMessage, 'id' | 'role' | 'sessionID' | 'time'> & { time: { created: number } }
  ): Promise<string> {
    const id = ulid();

    const message: AssistantMessage = {
      ...data,
      id,
      role: 'assistant',
      sessionID
    };

    const sessionPath = this.buildSessionPath(sessionID, agentName);
    await writeJSON(`${sessionPath}/message/${id}`, message);
    return id;
  }

  /**
   * Add a part to a message
   */
  async addPart(sessionID: string, agentName: string, messageID: string, part: Part): Promise<string> {
    const id = ulid();
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    await writeJSON(`${sessionPath}/part/${messageID}/${id}`, part);
    return id;
  }

  /**
   * Update an existing part
   */
  async updatePart(sessionID: string, agentName: string, messageID: string, partID: string, updates: Partial<Part>): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    const key = `${sessionPath}/part/${messageID}/${partID}`;

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
   * Update assistant message
   */
  async updateAssistantMessage(
    sessionID: string,
    agentName: string,
    messageID: string,
    updates: Partial<Omit<AssistantMessage, 'id' | 'role' | 'sessionID'>>
  ): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    const key = `${sessionPath}/message/${messageID}`;

    const message = await readJSON<AssistantMessage>(key);
    if (message) {
      Object.assign(message, updates);
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
    return readJSON<Message>(`${sessionPath}/message/${messageID}`);
  }

  /**
   * Get part
   */
  async getPart(sessionID: string, agentName: string, messageID: string, partID: string): Promise<Part | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentName);
    return readJSON<Part>(`${sessionPath}/part/${messageID}/${partID}`);
  }

  /**
   * Set parent context for subagent sessions
   */
  setParentContext(parentSessionID: string, parentAgentName: string): void {
    const sanitizedParentName = sanitizeAgentName(parentAgentName);
    this.parentPath = `${parentSessionID}-${sanitizedParentName}/subagent`;
  }
}
