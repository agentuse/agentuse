import { ulid } from 'ulid';
import { writeJSON, readJSON } from '../storage/storage';
import type {
  SessionInfo,
  UserMessage,
  AssistantMessage,
  Part,
  Message
} from './types';

export class SessionManager {
  private sessionID: string | null = null;

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

    await writeJSON(`info/${id}`, session);
    this.sessionID = id;

    return id;
  }

  /**
   * Create a user message
   */
  async createUserMessage(sessionID: string): Promise<string> {
    const id = ulid();
    const message: UserMessage = {
      id,
      role: 'user',
      sessionID,
      time: { created: Date.now() }
    };

    await writeJSON(`message/${sessionID}/${id}`, message);
    return id;
  }

  /**
   * Create an assistant message
   */
  async createAssistantMessage(
    sessionID: string,
    data: Omit<AssistantMessage, 'id' | 'role' | 'sessionID' | 'time'> & { time: { created: number } }
  ): Promise<string> {
    const id = ulid();
    const message: AssistantMessage = {
      ...data,
      id,
      role: 'assistant',
      sessionID
    };

    await writeJSON(`message/${sessionID}/${id}`, message);
    return id;
  }

  /**
   * Add a part to a message
   */
  async addPart(sessionID: string, messageID: string, part: Part): Promise<string> {
    const id = ulid();
    await writeJSON(`part/${sessionID}/${messageID}/${id}`, part);
    return id;
  }

  /**
   * Update an existing part
   */
  async updatePart(sessionID: string, messageID: string, partID: string, updates: Partial<Part>): Promise<void> {
    const key = `part/${sessionID}/${messageID}/${partID}`;
    const existing = await readJSON<Part>(key);
    if (existing) {
      const updated = { ...existing, ...updates };
      await writeJSON(key, updated);
    }
  }

  /**
   * Update session info
   */
  async updateSession(sessionID: string, updates: Partial<Omit<SessionInfo, 'id'>>): Promise<void> {
    const session = await readJSON<SessionInfo>(`info/${sessionID}`);
    if (session) {
      Object.assign(session, updates);
      session.time.updated = Date.now();
      await writeJSON(`info/${sessionID}`, session);
    }
  }

  /**
   * Update assistant message
   */
  async updateAssistantMessage(
    sessionID: string,
    messageID: string,
    updates: Partial<Omit<AssistantMessage, 'id' | 'role' | 'sessionID'>>
  ): Promise<void> {
    const message = await readJSON<AssistantMessage>(`message/${sessionID}/${messageID}`);
    if (message) {
      Object.assign(message, updates);
      await writeJSON(`message/${sessionID}/${messageID}`, message);
    }
  }

  /**
   * Get current session ID
   */
  getCurrentSessionID(): string | null {
    return this.sessionID;
  }

  /**
   * Get session info
   */
  async getSession(sessionID: string): Promise<SessionInfo | null> {
    return readJSON<SessionInfo>(`info/${sessionID}`);
  }

  /**
   * Get message
   */
  async getMessage(sessionID: string, messageID: string): Promise<Message | null> {
    return readJSON<Message>(`message/${sessionID}/${messageID}`);
  }

  /**
   * Get part
   */
  async getPart(sessionID: string, messageID: string, partID: string): Promise<Part | null> {
    return readJSON<Part>(`part/${sessionID}/${messageID}/${partID}`);
  }
}
