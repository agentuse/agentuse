import { decodeTime, ulid } from 'ulid';
import fs from 'fs/promises';
import path from 'path';
import { writeJSON, readJSON, listKeys, getStorageState, sanitizeAgentName } from '../storage';
import type {
  SessionInfo,
  SessionTrigger,
  Part,
  Message,
  DeepPartial,
  ToolsSnapshot,
  ToolPart
} from './types';

export interface SessionEntry {
  session: SessionInfo;
  agentId: string;
  path: string;
}

export interface StoppedSession {
  sessionId: string;
  agentId: string;
  agentName: string;
  wasStatus: SessionInfo['status'];
  stopped: boolean;
}

function getPartOrder(part: Part): number {
  if (part.type === 'text') return part.time?.start ?? Number.MAX_SAFE_INTEGER;
  if (part.type === 'reasoning') return part.time.start;
  if (part.type === 'tool') {
    const state = part.state;
    if (state.status === 'pending') return state.suspendedAt ?? Number.MAX_SAFE_INTEGER;
    return state.time.start;
  }
  return Number.MAX_SAFE_INTEGER;
}

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

  private async walkSessionDirs(baseDir: string, relativeDir = ''): Promise<string[]> {
    const absoluteDir = path.join(baseDir, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    const sessionJson = entries.find((entry) => entry.isFile() && entry.name === 'session.json');
    const results: string[] = sessionJson ? [relativeDir] : [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      results.push(...await this.walkSessionDirs(baseDir, path.join(relativeDir, entry.name)));
    }

    return results;
  }

  private async readSessionEntries(options: { createdAfter?: number } = {}): Promise<SessionEntry[]> {
    const state = await getStorageState();
    const dirs = await this.walkSessionDirs(state.dir);
    const results: SessionEntry[] = [];

    for (const dir of dirs) {
      const session = await readJSON<SessionInfo>(`${dir}/session`);
      if (!session) continue;
      if (options.createdAfter !== undefined) {
        try {
          if (decodeTime(session.id) < options.createdAfter) continue;
        } catch {
          if (session.time.created < options.createdAfter) continue;
        }
      }
      const dirName = path.basename(dir);
      const prefix = `${session.id}-`;
      const agentId = dirName.startsWith(prefix)
        ? dirName.slice(prefix.length)
        : sanitizeAgentName(session.agent.id);
      results.push({ session, agentId, path: dir });
    }

    return results;
  }

  private async updateSessionAtPath(sessionPath: string, updates: Partial<Omit<SessionInfo, 'id'>>): Promise<void> {
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

  private async stopPendingPartsAtPath(sessionPath: string, options: { message: string; time: number }): Promise<void> {
    const partKeys = (await listKeys(sessionPath))
      .filter((key) => key.startsWith(`${sessionPath}/`) && key.includes('/part/'));

    await Promise.all(partKeys.map(async (key) => {
      await this.serializedWrite(key, async () => {
        const part = await readJSON<Part>(key);
        if (!part || part.type !== 'tool') return;
        const state = part.state;
        if (state.status !== 'pending' && state.status !== 'running') return;

        const input = 'input' in state ? state.input : undefined;
        const resumePayload = state.status === 'pending' ? state.resumePayload : undefined;
        const start = state.status === 'running'
          ? state.time.start
          : state.suspendedAt ?? options.time;

        await writeJSON(key, {
          ...part,
          state: {
            status: 'error',
            input: input ?? {},
            error: options.message,
            ...(resumePayload && { metadata: { resumePayload } }),
            time: {
              start,
              end: options.time
            }
          }
        } as Part);
      });
    }));
  }

  /**
   * Create a new session
   */
  async createSession(info: Omit<SessionInfo, 'id' | 'time' | 'status' | 'trigger'> & { trigger?: SessionTrigger }): Promise<string> {
    const id = ulid();
    const now = Date.now();

    const session: SessionInfo = {
      ...info,
      id,
      status: 'running',
      // Default 'manual' so every existing caller stays valid; serve sets
      // 'scheduled' / 'api' where it knows the origin.
      trigger: info.trigger ?? 'manual',
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
   * Locate a top-level session by ID without requiring the caller to know the
   * sanitized agent id. Resume endpoints only have the session id in the URL.
   */
  async findSession(sessionID: string): Promise<SessionEntry | null> {
    const entries = await this.readSessionEntries();
    return entries.find((entry) => entry.session.id === sessionID) ?? null;
  }

  /**
   * Return the first message in a session. Current sessions store one user /
   * assistant exchange, which is the exchange resume needs to continue.
   */
  async getPrimaryMessage(sessionID: string, agentId: string): Promise<Message | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    const keys = await listKeys(sessionPath);
    const messageKey = keys
      .filter(key => key.startsWith(`${sessionPath}/`) && key.endsWith('/message'))
      .sort()[0];
    return messageKey ? readJSON<Message>(messageKey) : null;
  }

  async getSessionMessages(sessionID: string, agentId: string): Promise<Message[]> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    const keys = await listKeys(sessionPath);
    const messageKeys = keys
      .filter(key => key.startsWith(`${sessionPath}/`) && key.endsWith('/message'))
      .sort();
    const messages = await Promise.all(messageKeys.map(key => readJSON<Message>(key)));
    return messages
      .filter((message): message is Message => message !== null)
      .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  }

  /**
   * List all persisted parts for a message in creation order.
   */
  async getMessageParts(sessionID: string, agentId: string, messageID: string): Promise<Part[]> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    const partPrefix = `${sessionPath}/${messageID}/part`;
    const keys = await listKeys(partPrefix);
    const parts = await Promise.all(
      keys
        .filter(key => key.startsWith(`${partPrefix}/`))
        .sort()
        .map(key => readJSON<Part>(key))
    );
    return parts
      .filter((part): part is Part => part !== null)
      .sort((a, b) => getPartOrder(a) - getPartOrder(b) || a.id.localeCompare(b.id));
  }

  /**
   * Return the latest await_human part in a session without reading message
   * records. Approval list pages only need the approval tool payload, and
   * large session stores make repeatedly loading messages noticeably slow.
   */
  async getLatestApprovalPart(sessionID: string, agentId: string): Promise<ToolPart | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    const keys = await listKeys(sessionPath);
    const partKeys = keys
      .filter(key => key.startsWith(`${sessionPath}/`) && key.includes('/part/'))
      .sort();

    const parts = await Promise.all(
      partKeys.map(async (key) => {
        const part = await readJSON<Part>(key);
        return part?.type === 'tool' && part.tool === 'await_human'
          ? part
          : null;
      })
    );

    return parts
      .filter((part): part is ToolPart => part !== null)
      .sort((a, b) => getPartOrder(b) - getPartOrder(a) || b.id.localeCompare(a.id))[0] ?? null;
  }

  /**
   * Mark session as suspended on an external event.
   */
  async setSessionSuspended(sessionID: string, agentId: string): Promise<void> {
    await this.updateSession(sessionID, agentId, {
      status: 'suspended'
    });
  }

  /**
   * Mark a suspended session as running while a resume worker continues it.
   */
  async setSessionRunning(sessionID: string, agentId: string): Promise<void> {
    await this.updateSession(sessionID, agentId, {
      status: 'running'
    });
  }

  private async scanSessions(
    predicate?: (session: SessionInfo) => boolean,
    options: { createdAfter?: number } = {}
  ): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    const entries = await this.readSessionEntries(options);
    const results: Array<{ session: SessionInfo; agentId: string }> = [];

    for (const { session, agentId } of entries) {
      if (predicate && !predicate(session)) continue;
      results.push({ session, agentId });
    }

    return results;
  }

  async listChildSessions(parentSessionID: string): Promise<SessionEntry[]> {
    const entries = await this.readSessionEntries();
    return entries
      .filter((entry) => entry.session.parentSessionID === parentSessionID)
      .sort((a, b) => a.session.time.created - b.session.time.created || a.session.id.localeCompare(b.session.id));
  }

  async stopSessionTree(
    sessionID: string,
    options: { message?: string; code?: string } = {}
  ): Promise<StoppedSession[]> {
    const entries = await this.readSessionEntries();
    const byParent = new Map<string, SessionEntry[]>();
    for (const entry of entries) {
      const parentId = entry.session.parentSessionID;
      if (!parentId) continue;
      const children = byParent.get(parentId) ?? [];
      children.push(entry);
      byParent.set(parentId, children);
    }

    const root = entries.find((entry) => entry.session.id === sessionID);
    if (!root) return [];

    const ordered: SessionEntry[] = [];
    const visit = (entry: SessionEntry) => {
      ordered.push(entry);
      for (const child of byParent.get(entry.session.id) ?? []) {
        visit(child);
      }
    };
    visit(root);

    const now = Date.now();
    const code = options.code ?? 'USER_STOPPED';
    const message = options.message ?? 'Session stopped by user';
    const stopped: StoppedSession[] = [];
    for (const entry of ordered) {
      const wasStatus = entry.session.status;
      const shouldStop = wasStatus === 'running' || wasStatus === 'suspended';
      const shouldStopPendingParts = shouldStop || entry.session.error?.code === code;
      if (shouldStop) {
        await this.updateSessionAtPath(entry.path, {
          status: 'error',
          error: {
            code,
            message,
            time: now
          }
        });
      }
      if (shouldStopPendingParts) {
        await this.stopPendingPartsAtPath(entry.path, { message, time: now });
      }
      stopped.push({
        sessionId: entry.session.id,
        agentId: entry.agentId,
        agentName: entry.session.agent.name || entry.session.agent.id,
        wasStatus,
        stopped: shouldStop
      });
    }

    return stopped;
  }

  async getSuspendedSessions(): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    return this.scanSessions((session) => session.status === 'suspended');
  }

  async listAllSessions(): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    return this.scanSessions();
  }

  async listSessionsCreatedAfter(createdAfter: number): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    return this.scanSessions(undefined, { createdAfter });
  }

  async findPendingTool(sessionID: string, agentId: string): Promise<{ message: Message; part: ToolPart } | null> {
    const message = await this.getPrimaryMessage(sessionID, agentId);
    if (!message) return null;

    const parts = await this.getMessageParts(sessionID, agentId, message.id);
    const pending = parts.find((part): part is ToolPart =>
      part.type === 'tool' && (part.state.status === 'pending' || part.state.status === 'running')
    );

    return pending ? { message, part: pending } : null;
  }

  async writeToolsSnapshot(sessionID: string, agentId: string, snapshot: ToolsSnapshot): Promise<void> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    await writeJSON(`${sessionPath}/tools`, snapshot);
  }

  async readToolsSnapshot(sessionID: string, agentId: string): Promise<ToolsSnapshot | null> {
    const sessionPath = this.buildSessionPath(sessionID, agentId);
    return readJSON<ToolsSnapshot>(`${sessionPath}/tools`);
  }

  async getSessionDirectory(sessionID: string, agentId: string): Promise<string> {
    const state = await getStorageState();
    return path.join(state.dir, this.buildSessionPath(sessionID, agentId));
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
