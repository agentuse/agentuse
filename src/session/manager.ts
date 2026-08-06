import { decodeTime, ulid } from 'ulid';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { writeJSON, readJSON, listKeys, getStorageState, sanitizeAgentName, CorruptStorageError } from '../storage';
import { logger } from '../utils/logger';
import { currentProcessRef } from '../utils/process-info';
import { withOwnershipLock } from '../utils/ownership-lock';
import { dehydrateSnapshotMedia, rehydrateSnapshotMedia } from './media-cache';
import { computeSubagentActiveIds } from './subagent-active';
import type {
  SessionInfo,
  SessionTrigger,
  Part,
  Message,
  DeepPartial,
  ToolsSnapshot,
  ToolPart,
  ContextSnapshot,
  ToolOutputArtifactRef,
  ToolOutputArtifactStream
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
  /** Already-ended failed session acknowledged (dismissedAt stamped) instead of stopped. */
  dismissed?: boolean;
}

/** Compact, list-view-only record kept in the durable session index. */
export interface SessionListSummary {
  sessionId: string;
  parentSessionId?: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
    isSubAgent: boolean;
  };
  projectRoot?: string;
  status: SessionInfo['status'];
  trigger: SessionTrigger;
  createdAt: number;
  updatedAt: number;
  error?: { code?: string; message?: string };
  dismissedAt?: number;
  mock?: boolean;
  /** This session has participated in an approval/cascade lifecycle. */
  approvalRelevant?: boolean;
  /** Suspended parent parked on a running delegated child (a "running ·
   *  subagent" run, not one blocked on a human gate). Derived at list time from
   *  the full set, not persisted. See ./subagent-active. */
  subagentActive?: boolean;
  path: string;
}

interface SessionIndex {
  version: 1;
  generation: number;
  approvalGeneration?: number;
  sessions: Record<string, SessionListSummary>;
}

interface ReadSessionEntriesOptions {
  createdAfter?: number;
  relativeDir?: string;
  includeSubagents?: boolean;
}

function getPartOrder(part: Part): number {
  if (part.type === 'text') return part.time?.start ?? Number.MAX_SAFE_INTEGER;
  if (part.type === 'reasoning') return part.time.start;
  if (part.type === 'tool') {
    const state = part.state;
    if (state.status === 'pending') return state.suspendedAt ?? Number.MAX_SAFE_INTEGER;
    return state.time.start;
  }
  if (part.type === 'compaction' || part.type === 'corrections' || part.type === 'learning' || part.type === 'error' || part.type === 'log' || part.type === 'verify') return part.time.start;
  return Number.MAX_SAFE_INTEGER;
}

function partAffectsApprovalIndex(part: Part): boolean {
  if (part.type !== 'tool') return false;
  if (part.tool === 'await_human') return true;
  const state = part.state;
  const resumePayload = state.status === 'pending'
    ? state.resumePayload
    : ('metadata' in state && state.metadata && typeof state.metadata === 'object'
        ? (state.metadata as { resumePayload?: { kind?: string } }).resumePayload
        : undefined);
  return resumePayload && typeof resumePayload === 'object' && 'kind' in resumePayload
    ? resumePayload.kind === 'subagent_wait'
    : false;
}

function stringifyToolOutputArtifact(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === 'bigint') return nestedValue.toString();
    if (typeof nestedValue === 'function') return `[Function ${nestedValue.name || 'anonymous'}]`;
    if (typeof nestedValue === 'symbol') return nestedValue.toString();
    if (nestedValue && typeof nestedValue === 'object') {
      if (seen.has(nestedValue)) return '[Circular]';
      seen.add(nestedValue);
    }
    return nestedValue;
  }, 2);
  return serialized ?? String(value);
}

function measureToolOutputChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  const serialized = stringifyToolOutputArtifact(value);
  return serialized.length;
}

function buildToolOutputArtifactPath(
  sessionPath: string,
  messageID: string,
  toolName: string,
  extension: 'json' | 'txt'
): string {
  const safeToolName = sanitizeAgentName(toolName).slice(0, 48) || 'tool';
  return `${sessionPath}/${messageID}/artifact/tool-output-${safeToolName}-${ulid()}.${extension}`;
}

const SESSION_INDEX_DIR = '.index';
const SESSION_INDEX_KEY = `${SESSION_INDEX_DIR}/sessions.v1`;
const SESSION_INDEX_DIRTY_KEY = `${SESSION_INDEX_DIR}/dirty`;
const SESSION_INDEX_LOCK_MAX_AGE_MS = 30_000;
const SESSION_INDEX_LOCK_RETRY_DELAY_MS = 15;
// Long enough to outlast both a full index rebuild on a large store and the
// mtime steal age above. Session create/update writes used to be lock-free and
// could not fail on contention; a timeout shorter than the worst-case hold
// would turn those writes into hard failures (lost status flips, runs that
// crash at session creation).
const SESSION_INDEX_LOCK_MAX_ATTEMPTS = 2400;

function toSessionListSummary(session: SessionInfo, sessionPath: string): SessionListSummary {
  return {
    sessionId: session.id,
    ...(session.parentSessionID && { parentSessionId: session.parentSessionID }),
    agent: {
      id: session.agent.id,
      name: session.agent.name,
      ...(session.agent.description && { description: session.agent.description }),
      ...(session.agent.filePath && { filePath: session.agent.filePath }),
      isSubAgent: session.agent.isSubAgent,
    },
    ...(session.project?.root && { projectRoot: session.project.root }),
    status: session.status,
    trigger: session.trigger ?? 'manual',
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    ...(session.error && { error: { code: session.error.code, message: session.error.message } }),
    ...(session.dismissedAt !== undefined && { dismissedAt: session.dismissedAt }),
    ...(session.mock && { mock: true }),
    path: sessionPath,
  };
}

export class SessionManager {
  private static foundSessionPathCache: Map<string, string> = new Map();
  private static sessionIndexCache: Map<string, {
    mtimeMs: number;
    size: number;
    ino: number;
    index: SessionIndex;
  }> = new Map();

  private sessionID: string | null = null;
  private agentId: string | null = null;
  private parentPath: string | null = null; // For subagents: "{mainSessionID}-{mainAgentId}/subagent"
  private fullPath: string | null = null; // Full path to this session's directory
  private sessionPathCache: Map<string, string> = new Map();

  // Write queues to prevent concurrent read-modify-write races
  // Key is the file path, value is a promise chain
  private writeQueues: Map<string, Promise<void>> = new Map();

  /**
   * Execute a write operation with serialization to prevent race conditions.
   * All writes to the same key are queued and executed in order.
   */
  private async serializedWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const currentQueue = this.writeQueues.get(key) ?? Promise.resolve();

    const operationQueue = currentQueue.catch(() => {
      // Don't let previous errors block the next write.
    }).then(operation);

    const tail = operationQueue.then(() => undefined, () => undefined);
    this.writeQueues.set(key, tail);
    // Evict the key once this write settles and nothing newer has queued behind
    // it, so the map does not grow unbounded over a long-lived process lifetime.
    void tail.then(() => {
      if (this.writeQueues.get(key) === tail) {
        this.writeQueues.delete(key);
      }
    });
    return await operationQueue;
  }

  /**
   * Serialize index mutations across runner and serve processes. The lock is
   * deliberately tiny and the index itself is atomically renamed by writeJSON,
   * so readers never observe a partial catalog.
   */
  private async withSessionIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const state = await getStorageState();
    const indexDir = path.join(state.dir, SESSION_INDEX_DIR);
    const lockPath = path.join(indexDir, 'lock');
    return withOwnershipLock(lockPath, operation, {
      staleMs: SESSION_INDEX_LOCK_MAX_AGE_MS,
      retryMs: SESSION_INDEX_LOCK_RETRY_DELAY_MS,
      maxWaitMs: SESSION_INDEX_LOCK_MAX_ATTEMPTS * SESSION_INDEX_LOCK_RETRY_DELAY_MS,
      label: 'session-index',
    });
  }

  private async readSessionIndex(): Promise<SessionIndex | null> {
    try {
      const state = await getStorageState();
      const indexPath = path.join(state.dir, `${SESSION_INDEX_KEY}.json`);
      const stat = await fs.stat(indexPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return null;
      const cached = SessionManager.sessionIndexCache.get(indexPath);
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size &&
        cached.ino === stat.ino
      ) {
        return cached.index;
      }
      const index = await readJSON<SessionIndex>(SESSION_INDEX_KEY);
      if (!index || index.version !== 1 || typeof index.generation !== 'number' || !index.sessions || typeof index.sessions !== 'object') return null;
      SessionManager.sessionIndexCache.set(indexPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ino: stat.ino,
        index,
      });
      return index;
    } catch (error) {
      if (error instanceof CorruptStorageError) {
        logger.warn(`Rebuilding corrupt session index: ${error.message}`);
        return null;
      }
      throw error;
    }
  }

  private async writeSessionIndex(index: SessionIndex): Promise<void> {
    await writeJSON(SESSION_INDEX_KEY, index);
    const state = await getStorageState();
    const indexPath = path.join(state.dir, `${SESSION_INDEX_KEY}.json`);
    const stat = await fs.stat(indexPath);
    SessionManager.sessionIndexCache.set(indexPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      index,
    });
  }

  private async rebuildSessionIndex(): Promise<SessionIndex> {
    const entries = await this.readSessionEntries();
    const sessions: Record<string, SessionListSummary> = {};
    for (const entry of entries) {
      sessions[entry.session.id] = toSessionListSummary(entry.session, entry.path);
    }
    const index: SessionIndex = { version: 1, generation: Date.now(), sessions };
    await this.writeSessionIndex(index);
    return index;
  }

  private async updateSessionIndex(
    session: SessionInfo,
    sessionPath: string,
    options: { approvalRelevant?: boolean } = {}
  ): Promise<void> {
    const index = await this.readSessionIndex() ?? await this.rebuildSessionIndex();
    const previous = index.sessions[session.id];
    const approvalRelevant = options.approvalRelevant === true || previous?.approvalRelevant === true;
    const approvalChanged = options.approvalRelevant === true ||
      previous?.status === 'suspended' || session.status === 'suspended' ||
      (approvalRelevant && previous?.status !== session.status);
    const summary = toSessionListSummary(session, sessionPath);
    if (approvalRelevant) summary.approvalRelevant = true;
    const updated: SessionIndex = {
      ...index,
      generation: index.generation + 1,
      approvalGeneration: (index.approvalGeneration ?? index.generation) + (approvalChanged ? 1 : 0),
      sessions: {
        ...index.sessions,
        [session.id]: summary,
      },
    };
    await this.writeSessionIndex(updated);
  }

  /** Mark an update in progress so a crash is detected before a list read. */
  private async withSessionIndexMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.withSessionIndexLock(async () => {
      await writeJSON(SESSION_INDEX_DIRTY_KEY, { startedAt: Date.now(), pid: process.pid });
      let completed = false;
      try {
        const result = await operation();
        completed = true;
        return result;
      } finally {
        if (completed) {
          await fs.unlink(path.join((await getStorageState()).dir, `${SESSION_INDEX_DIRTY_KEY}.json`)).catch(() => undefined);
        }
      }
    });
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

  private sessionPathCacheKey(sessionID: string, agentId: string): string {
    return `${sessionID}:${sanitizeAgentName(agentId)}`;
  }

  private rememberSessionPath(sessionID: string, agentId: string, sessionPath: string): void {
    this.sessionPathCache.set(this.sessionPathCacheKey(sessionID, agentId), sessionPath);
    SessionManager.foundSessionPathCache.set(sessionID, sessionPath);
  }

  private async touchSessionDirectory(sessionPath: string): Promise<void> {
    const state = await getStorageState();
    const now = new Date();
    await fs.utimes(path.join(state.dir, sessionPath), now, now).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private knownSessionPath(sessionID: string, agentId: string): string {
    return this.sessionPathCache.get(this.sessionPathCacheKey(sessionID, agentId))
      ?? this.buildSessionPath(sessionID, agentId);
  }

  /**
   * Resolve the actual on-disk directory for a session.
   *
   * `buildSessionPath` only yields the correct location when this instance was
   * created with the matching `parentPath`. Subagent sessions are stored nested
   * under `{parent}/subagent/...`, so a fresh reader (e.g. the serve worker
   * answering a session-view request) computes a top-level path that does not
   * exist and reads nothing. When the direct path is empty, walk the store and
   * match by directory basename (`{sessionID}-{sanitizedAgentId}`).
   */
  private async resolveSessionDir(sessionID: string, agentId: string): Promise<string> {
    const cached = this.sessionPathCache.get(this.sessionPathCacheKey(sessionID, agentId));
    if (cached) return cached;

    const direct = this.buildSessionPath(sessionID, agentId);
    const directSession = await readJSON<SessionInfo>(`${direct}/session`);
    if (directSession) {
      this.rememberSessionPath(sessionID, agentId, direct);
      return direct;
    }

    const target = `${sessionID}-${sanitizeAgentName(agentId)}`;
    const state = await getStorageState();
    const dirs = await this.walkSessionDirs(state.dir);
    const resolved = dirs.find((dir) => path.basename(dir) === target) ?? direct;
    this.rememberSessionPath(sessionID, agentId, resolved);
    return resolved;
  }

  private async walkSessionDirs(
    baseDir: string,
    relativeDir = '',
    options: Pick<ReadSessionEntriesOptions, 'createdAfter' | 'includeSubagents'> = {}
  ): Promise<string[]> {
    const absoluteDir = path.join(baseDir, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    const sessionJson = entries.find((entry) => entry.isFile() && entry.name === 'session.json');
    const results: string[] = sessionJson ? [relativeDir] : [];
    const childDirs = sessionJson
      ? (options.includeSubagents === false
          ? []
          : entries.filter((entry) => entry.isDirectory() && entry.name === 'subagent'))
      : entries.filter((entry) => {
          if (!entry.isDirectory() || entry.name === SESSION_INDEX_DIR) return false;
          if (relativeDir === '' && options.includeSubagents === false && options.createdAfter !== undefined) {
            try {
              if (decodeTime(entry.name.split('-')[0]) < options.createdAfter) return false;
            } catch {
              // Non-ULID directory names fall through to the slower compatibility path.
            }
          }
          return true;
        });

    for (const entry of childDirs) {
      results.push(...await this.walkSessionDirs(baseDir, path.join(relativeDir, entry.name), options));
    }

    return results;
  }

  private async findSessionDirById(baseDir: string, sessionID: string, relativeDir = ''): Promise<string | null> {
    const absoluteDir = path.join(baseDir, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    const hasSessionJson = entries.some((entry) => entry.isFile() && entry.name === 'session.json');
    const dirName = path.basename(relativeDir);

    if (hasSessionJson && dirName.startsWith(`${sessionID}-`)) {
      const session = await readJSON<SessionInfo>(`${relativeDir}/session`);
      if (session?.id === sessionID) return relativeDir;
    }

    const childDirs = hasSessionJson
      ? entries.filter((entry) => entry.isDirectory() && entry.name === 'subagent')
      : entries.filter((entry) => entry.isDirectory());

    for (const entry of childDirs) {
      const found = await this.findSessionDirById(baseDir, sessionID, path.join(relativeDir, entry.name));
      if (found) return found;
    }

    return null;
  }

  private async findTopLevelSessionDirById(baseDir: string, sessionID: string): Promise<string | null> {
    const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
    const prefix = `${sessionID}-`;
    const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
    if (!match) return null;

    const sessionPath = match.name;
    const session = await readJSON<SessionInfo>(`${sessionPath}/session`);
    return session?.id === sessionID ? sessionPath : null;
  }

  private async readSessionEntries(options: ReadSessionEntriesOptions = {}): Promise<SessionEntry[]> {
    const state = await getStorageState();
    const dirs = await this.walkSessionDirs(state.dir, options.relativeDir ?? '', options);
    const results: SessionEntry[] = [];

    for (const dir of dirs) {
      const dirName = path.basename(dir);

      // Fast path for date-windowed scans: the directory is named
      // `${sessionID}-${agentId}` and sessionID is a (hyphen-free, 26-char) ULID,
      // so decode its creation time straight from the name and skip the
      // `session.json` read entirely for sessions older than the window. With
      // thousands of accumulated sessions this avoids reading every file on each
      // dashboard load. Behavior-preserving: when the name's ULID decodes below
      // the cutoff, `session.id` (the same string) decodes identically, so the
      // file-based check below would skip it too. Malformed names throw in
      // decodeTime and fall through to the original read-and-check path.
      if (options.createdAfter !== undefined) {
        try {
          if (decodeTime(dirName.split('-')[0]) < options.createdAfter) continue;
        } catch {
          // Not a decodable ULID prefix; fall through and read the file.
        }
      }

      // Cross-session scan: one corrupt session.json must not take down the
      // whole walk (which powers the dashboard, child-session lookups, and
      // stop-tree). Skip the bad file with a warning and keep going; a read of
      // the *requested* session goes through findSession/resolveSessionDir,
      // which still surfaces corruption as an error.
      let session: SessionInfo | null;
      try {
        session = await readJSON<SessionInfo>(`${dir}/session`);
      } catch (err) {
        if (err instanceof CorruptStorageError) {
          logger.warn(`Skipping unreadable session at ${dir}/session.json: ${err.message}`);
          continue;
        }
        throw err;
      }
      if (!session) continue;
      if (options.createdAfter !== undefined) {
        try {
          if (decodeTime(session.id) < options.createdAfter) continue;
        } catch {
          if (session.time.created < options.createdAfter) continue;
        }
      }
      const prefix = `${session.id}-`;
      const agentId = dirName.startsWith(prefix)
        ? dirName.slice(prefix.length)
        : sanitizeAgentName(session.agent.id);
      this.rememberSessionPath(session.id, agentId, dir);
      results.push({ session, agentId, path: dir });
    }

    return results;
  }

  private async updateSessionAtPath(
    sessionPath: string,
    updates: Partial<Omit<SessionInfo, 'id'>>,
    options: { approvalRelevant?: boolean } = {}
  ): Promise<void> {
    const key = `${sessionPath}/session`;

    await this.serializedWrite(key, () => this.withSessionIndexMutation(async () => {
      const session = await readJSON<SessionInfo>(key);
      if (!session) return;
      Object.assign(session, updates);
      session.time.updated = Date.now();
      await writeJSON(key, session);
      await this.updateSessionIndex(session, sessionPath, options);
    }));
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
    await this.touchSessionDirectory(sessionPath);
  }

  /**
   * Create a new session
   */
  async createSession(info: Omit<SessionInfo, 'id' | 'time' | 'status' | 'trigger'> & { trigger?: SessionTrigger; id?: string }): Promise<string> {
    // Callers may pre-assign the id (e.g. serve's detached run, which returns
    // the id to the client before the run has produced anything). Default to a
    // fresh ULID so every existing caller is unaffected.
    const id = info.id ?? ulid();
    const now = Date.now();

    const session: SessionInfo = {
      ...info,
      id,
      status: 'running',
      // Default 'manual' so every existing caller stays valid; serve sets
      // 'scheduled' / 'api' where it knows the origin.
      trigger: info.trigger ?? 'manual',
      owner: currentProcessRef(),
      time: {
        created: now,
        updated: now
      }
    };

    const sessionPath = this.buildSessionPath(id, info.agent.id);
    await this.withSessionIndexMutation(async () => {
      await writeJSON(`${sessionPath}/session`, session);
      await this.updateSessionIndex(session, sessionPath);
    });

    this.sessionID = id;
    this.agentId = sanitizeAgentName(info.agent.id);
    this.fullPath = sessionPath;
    this.rememberSessionPath(id, info.agent.id, sessionPath);

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

    // Honor the cached path resolved by createSession/findSession so a resumed
    // subagent (fresh manager, parentPath unset) writes into its nested dir
    // rather than a top-level path. Falls back to buildSessionPath when cold.
    const sessionPath = this.knownSessionPath(sessionID, agentId);
    // New path structure: {messageID}/message.json
    await writeJSON(`${sessionPath}/${id}/message`, message);
    await this.touchSessionDirectory(sessionPath);
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
    // Use the cached (possibly nested) path for the same reason as addMessage.
    const sessionPath = this.knownSessionPath(sessionID, agentId);

    // Add base fields to create complete Part
    const completePart: Part = {
      ...partData,
      id,
      sessionID,
      messageID,
    } as Part; // Type assertion needed due to discriminated union complexity

    // New path structure: {messageID}/part/{partID}.json
    await writeJSON(`${sessionPath}/${messageID}/part/${id}`, completePart);
    await this.touchSessionDirectory(sessionPath);
    if (partAffectsApprovalIndex(completePart)) {
      await this.updateSessionAtPath(sessionPath, {}, { approvalRelevant: true });
    }
    return id;
  }

  /**
   * Update an existing part
   * Uses serialized writes to prevent race conditions during concurrent updates
   *
   * A miss at the cached/derived path is NOT a silent no-op: nested (subagent)
   * sessions resolve to a wrong flat path when this instance's cache is cold,
   * and swallowing that write corrupts resume flows downstream (an approval
   * decision that never lands leaves a dangling tool call for the model). Fall
   * back to the store walk, and throw when the part is genuinely absent.
   */
  async updatePart(sessionID: string, agentId: string, messageID: string, partID: string, updates: Partial<Part>): Promise<void> {
    let sessionPath = this.knownSessionPath(sessionID, agentId);
    // New path structure: {messageID}/part/{partID}.json
    let key = `${sessionPath}/${messageID}/part/${partID}`;

    if (!(await readJSON<Part>(key))) {
      const resolved = await this.resolveSessionDir(sessionID, agentId);
      if (resolved !== sessionPath) {
        sessionPath = resolved;
        key = `${sessionPath}/${messageID}/part/${partID}`;
      }
    }

    await this.serializedWrite(key, async () => {
      const existing = await readJSON<Part>(key);
      if (!existing) {
        throw new Error(`PART_NOT_FOUND: cannot update part ${partID} of session ${sessionID} (resolved path: ${sessionPath})`);
      }
      const updated = { ...existing, ...updates } as Part;
      await writeJSON(key, updated);
      await this.touchSessionDirectory(sessionPath);
      if (partAffectsApprovalIndex(existing) || partAffectsApprovalIndex(updated)) {
        await this.updateSessionAtPath(sessionPath, {}, { approvalRelevant: true });
      }
    });
  }

  /**
   * Update session info
   * Uses serialized writes to prevent race conditions during concurrent updates
   */
  async updateSession(sessionID: string, agentId: string, updates: Partial<Omit<SessionInfo, 'id'>>): Promise<void> {
    const sessionPath = this.knownSessionPath(sessionID, agentId);
    const key = `${sessionPath}/session`;

    await this.serializedWrite(key, () => this.withSessionIndexMutation(async () => {
      const session = await readJSON<SessionInfo>(key);
      if (session) {
        Object.assign(session, updates);
        // Whichever process flips a session (back) to 'running' owns its
        // execution now; re-stamp so the orphan sweep probes the right process.
        if (updates.status === 'running') session.owner = currentProcessRef();
        session.time.updated = Date.now();
        await writeJSON(key, session);
        await this.updateSessionIndex(session, sessionPath);
      }
    }));
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
    const sessionPath = this.knownSessionPath(sessionID, agentId);
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
            const tokenUpdates = assistantUpdates.tokens;
            message.assistant.tokens = {
              ...message.assistant.tokens,
              ...tokenUpdates,
              cache: {
                ...message.assistant.tokens.cache,
                ...(tokenUpdates.cache ?? {}),
              },
            } as Message['assistant']['tokens'];
          }
          // Merge other assistant fields (excluding tokens which we handled above)
          const { tokens: _, ...otherAssistantUpdates } = assistantUpdates;
          message.assistant = { ...message.assistant, ...otherAssistantUpdates } as Message['assistant'];
        }
        if (updates.user) {
          message.user = { ...message.user, ...updates.user } as Message['user'];
        }
        await writeJSON(key, message);
        await this.touchSessionDirectory(sessionPath);
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
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    return readJSON<SessionInfo>(`${sessionPath}/session`);
  }

  /**
   * Get message
   */
  async getMessage(sessionID: string, agentId: string, messageID: string): Promise<Message | null> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    // New path structure: {messageID}/message.json
    return readJSON<Message>(`${sessionPath}/${messageID}/message`);
  }

  /**
   * Get part
   */
  async getPart(sessionID: string, agentId: string, messageID: string, partID: string): Promise<Part | null> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    // New path structure: {messageID}/part/{partID}.json
    return readJSON<Part>(`${sessionPath}/${messageID}/part/${partID}`);
  }

  /**
   * Locate a top-level session by ID without requiring the caller to know the
   * sanitized agent id. Resume endpoints only have the session id in the URL.
   */
  async findSession(sessionID: string): Promise<SessionEntry | null> {
    const state = await getStorageState();
    const cachedPath = SessionManager.foundSessionPathCache.get(sessionID);
    const cachedSession = cachedPath
      ? await readJSON<SessionInfo>(`${cachedPath}/session`)
      : null;
    const sessionPath = cachedSession?.id === sessionID
      ? cachedPath!
      : await this.findTopLevelSessionDirById(state.dir, sessionID)
        ?? await this.findSessionDirById(state.dir, sessionID);
    if (!sessionPath) return null;

    const session = await readJSON<SessionInfo>(`${sessionPath}/session`);
    if (!session) return null;

    const dirName = path.basename(sessionPath);
    const prefix = `${session.id}-`;
    const agentId = dirName.startsWith(prefix)
      ? dirName.slice(prefix.length)
      : sanitizeAgentName(session.agent.id);

    this.sessionID = session.id;
    this.agentId = agentId;
    this.fullPath = sessionPath;
    this.rememberSessionPath(session.id, agentId, sessionPath);

    return { session, agentId, path: sessionPath };
  }

  // A session's own message lives at `{sessionPath}/{messageID}/message`; each
  // direct child directory except `subagent/` is a message directory. A recursive
  // listing would also walk every part file and the entire nested subagent
  // subtree just to find these few keys, so enumerate the direct children with
  // one shallow readdir instead. This also keeps reads, and the token usage
  // aggregated from them, scoped to this session, not its subtree.
  private async listMessageKeysShallow(sessionPath: string): Promise<string[]> {
    const state = await getStorageState();
    const sessionDir = path.join(state.dir, sessionPath);

    try {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true });
      return entries
        .filter((entry) =>
          entry.isDirectory()
          && entry.name !== 'subagent'
          && !entry.name.startsWith('.')
        )
        .map((entry) => `${sessionPath}/${entry.name}/message`)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Return the first message in a session. Current sessions store one user /
   * assistant exchange, which is the exchange resume needs to continue.
   */
  async getPrimaryMessage(sessionID: string, agentId: string): Promise<Message | null> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    const messageKey = (await this.listMessageKeysShallow(sessionPath))[0];
    return messageKey ? readJSON<Message>(messageKey) : null;
  }

  async getSessionMessages(sessionID: string, agentId: string): Promise<Message[]> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    const messageKeys = await this.listMessageKeysShallow(sessionPath);
    const messages = await Promise.all(messageKeys.map(key => readJSON<Message>(key)));
    return messages
      .filter((message): message is Message => message !== null)
      .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  }

  /**
   * List all persisted parts for a message in creation order. Part files sit
   * flat in `{message}/part/`, so one non-recursive readdir is enough.
   */
  async getMessageParts(sessionID: string, agentId: string, messageID: string): Promise<Part[]> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    const state = await getStorageState();
    const partDir = path.join(state.dir, sessionPath, messageID, 'part');

    let partKeys: string[];
    try {
      const entries = await fs.readdir(partDir, { withFileTypes: true });
      partKeys = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => `${sessionPath}/${messageID}/part/${entry.name.replace(/\.json$/, '')}`)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parts = await Promise.all(partKeys.map(key => readJSON<Part>(key)));
    return parts
      .filter((part): part is Part => part !== null)
      .sort((a, b) => getPartOrder(a) - getPartOrder(b) || a.id.localeCompare(b.id));
  }

  /**
   * Return the most recent visible assistant text for a session. Continuations
   * append synthetic user text and another assistant part to the same durable
   * transcript, so search messages and parts newest-first rather than assuming
   * the first message contains the final answer.
   */
  async getLastAssistantText(sessionID: string, agentId: string): Promise<string | undefined> {
    const messages = await this.getSessionMessages(sessionID, agentId);
    for (const message of [...messages].reverse()) {
      const parts = await this.getMessageParts(sessionID, agentId, message.id);
      const text = [...parts].reverse().find((part): part is Extract<Part, { type: 'text' }> =>
        part.type === 'text' &&
        part.role !== 'user' &&
        part.text.trim().length > 0
      );
      if (text) return text.text.trim();
    }
    return undefined;
  }

  private async readApprovalToolPart(key: string): Promise<ToolPart | null> {
    const state = await getStorageState();
    const target = path.join(state.dir, `${key}.json`);

    let content: string;
    try {
      content = await fs.readFile(target, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    // Approval list scans touch many large non-approval tool outputs. A cheap
    // textual gate avoids paying JSON.parse for files that cannot be approvals.
    if (!/"tool"\s*:\s*"await_human"/.test(content)) return null;

    let part: Part;
    try {
      part = JSON.parse(content) as Part;
    } catch (error) {
      throw new CorruptStorageError(key, error);
    }

    return part.type === 'tool' && part.tool === 'await_human'
      ? part
      : null;
  }

  private async listPartKeysShallow(sessionPath: string): Promise<string[]> {
    const state = await getStorageState();
    const sessionDir = path.join(state.dir, sessionPath);

    let messageDirs: string[];
    try {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true });
      messageDirs = entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'subagent')
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const keysByMessage = await Promise.all(messageDirs.map(async (messageId) => {
      const partDir = path.join(sessionDir, messageId, 'part');
      try {
        const entries = await fs.readdir(partDir, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => `${sessionPath}/${messageId}/part/${entry.name.replace(/\.json$/, '')}`)
          .sort()
          .reverse();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }));

    return keysByMessage.flat();
  }

  /**
   * Return the latest await_human part in a session without reading message
   * records. Approval list pages only need the approval tool payload, and
   * large session stores make repeatedly loading messages noticeably slow.
   */
  async getLatestApprovalPart(sessionID: string, agentId: string): Promise<ToolPart | null> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    const partKeys = await this.listPartKeysShallow(sessionPath);

    for (const key of partKeys) {
      const part = await this.readApprovalToolPart(key);
      if (part) return part;
    }

    return null;
  }

  /** One-stat live-view change probe. Nested transcript writes touch the
   * session root, so pollers no longer recurse through every message and part
   * directory twice a second. */
  async getSessionChangeSignature(sessionPath: string): Promise<string | null> {
    const state = await getStorageState();
    try {
      const stat = await fs.stat(path.join(state.dir, sessionPath));
      return `${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
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
    options: Pick<ReadSessionEntriesOptions, 'createdAfter' | 'includeSubagents'> = {}
  ): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    const entries = await this.readSessionEntries(options);
    const results: Array<{ session: SessionInfo; agentId: string }> = [];

    for (const { session, agentId } of entries) {
      if (predicate && !predicate(session)) continue;
      results.push({ session, agentId });
    }

    return results;
  }

  async listChildSessions(
    parentSessionID: string,
    parentSessionPath?: string
  ): Promise<SessionEntry[]> {
    // Subagent sessions are stored nested under the parent's own
    // `{parent}/subagent/` directory (since the 2025-12 storage layout), so a
    // scoped read of that directory is authoritative. We deliberately do NOT
    // scan the whole project for orphaned children: that compatibility path only
    // existed to surface a handful of pre-2026-06-05 sessions that a since-fixed
    // resume bug wrote to the top level, and it cost an O(project) session-file
    // scan on every poll of a live session view.
    const scopePath = parentSessionPath ?? (await this.findSession(parentSessionID))?.path;
    if (!scopePath) return [];
    const entries = await this.readSessionEntries({ relativeDir: `${scopePath}/subagent` });
    return entries
      // The scoped read recurses into nested subagent dirs, so keep only direct
      // children — grandchildren carry a different parentSessionID.
      .filter((entry) => entry.session.parentSessionID === parentSessionID)
      .sort((a, b) =>
        a.session.time.created - b.session.time.created ||
        a.session.agent.id.localeCompare(b.session.agent.id) ||
        a.session.id.localeCompare(b.session.id)
      );
  }

  async stopSessionTree(
    sessionID: string,
    options: { message?: string; code?: string; dismissEnded?: boolean } = {}
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
      // dismissEnded (reviewer-initiated stops only): stopping an already-
      // failed run is the reviewer's "reviewed, wave it off" — stamp
      // dismissedAt so needs-attention surfaces drop it, but keep status/error
      // intact so the true outcome stays diagnosable. Sessions the reviewer
      // stopped themselves are excluded (never re-enter needs-attention), which
      // also keeps the CLI's post-daemon-stop local pass from re-stamping them.
      const shouldDismiss = options.dismissEnded === true
        && !shouldStop
        && wasStatus === 'error'
        && entry.session.error?.code !== 'USER_STOPPED'
        && entry.session.dismissedAt === undefined;
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
      } else if (shouldDismiss) {
        await this.updateSessionAtPath(entry.path, { dismissedAt: now });
      }
      if (shouldStopPendingParts) {
        await this.stopPendingPartsAtPath(entry.path, { message, time: now });
      }
      stopped.push({
        sessionId: entry.session.id,
        agentId: entry.agentId,
        agentName: entry.session.agent.name || entry.session.agent.id,
        wasStatus,
        stopped: shouldStop,
        ...(shouldDismiss && { dismissed: true })
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

  /**
   * Read the compact catalog used by the Web UI. Session files remain the
   * source of truth: an interrupted mutation leaves a dirty marker and causes
   * a one-time automatic rebuild before any stale catalog is returned.
   */
  async listSessionSummaries(options: Pick<ReadSessionEntriesOptions, 'createdAfter' | 'includeSubagents'> = {}): Promise<SessionListSummary[]> {
    const state = await getStorageState();
    const dirtyPath = path.join(state.dir, `${SESSION_INDEX_DIRTY_KEY}.json`);
    const hasDirtyMarker = async () => {
      try {
        await fs.access(dirtyPath);
        return true;
      } catch {
        return false;
      }
    };

    let index = await this.readSessionIndex();
    if (!index || await hasDirtyMarker()) {
      index = await this.withSessionIndexLock(async () => {
        const current = await this.readSessionIndex();
        if (current && !(await hasDirtyMarker())) return current;
        const rebuilt = await this.rebuildSessionIndex();
        await fs.unlink(dirtyPath).catch(() => undefined);
        return rebuilt;
      });
    }

    // Derive subagent-active over the FULL set (parents + subagents) before the
    // includeSubagents filter drops children: the running leaf that makes a
    // suspended manager "running · subagent" is exactly the row that gets
    // filtered, so computing after the filter would always miss it.
    const all = Object.values(index.sessions);
    const activeIds = computeSubagentActiveIds(all);

    return all
      .filter((session) => options.includeSubagents || (!session.parentSessionId && !session.agent.isSubAgent))
      .filter((session) => options.createdAfter === undefined || session.createdAt >= options.createdAfter)
      .sort((a, b) => b.createdAt - a.createdAt || b.sessionId.localeCompare(a.sessionId))
      .map((session) => activeIds.has(session.sessionId) ? { ...session, subagentActive: true } : session);
  }

  /** Generation token for the durable approval projection. Ordinary runs do
   * not invalidate it; approval/cascade part writes and suspended transitions do. */
  async getApprovalIndexGeneration(): Promise<number> {
    await this.listSessionSummaries({ includeSubagents: true });
    const index = await this.readSessionIndex();
    if (!index) throw new Error('Session index unavailable after rebuild');
    return index.approvalGeneration ?? index.generation;
  }

  async listSessionsCreatedAfter(
    createdAfter: number,
    options: Pick<ReadSessionEntriesOptions, 'includeSubagents'> = {}
  ): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    return this.scanSessions(undefined, {
      createdAfter,
      ...(options.includeSubagents !== undefined && { includeSubagents: options.includeSubagents }),
    });
  }

  async listSessionsUpdatedAfter(updatedAfter: number): Promise<Array<{ session: SessionInfo; agentId: string }>> {
    return this.scanSessions((session) => session.time.updated >= updatedAfter);
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
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    await writeJSON(`${sessionPath}/tools`, snapshot);
  }

  async readToolsSnapshot(sessionID: string, agentId: string): Promise<ToolsSnapshot | null> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    return readJSON<ToolsSnapshot>(`${sessionPath}/tools`);
  }

  async writeContextSnapshot(sessionID: string, agentId: string, snapshot: ContextSnapshot): Promise<void> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    // Externalize any inline base64 media to session-owned cache files before
    // persisting, so a snapshot that carried an image/PDF stays small (and does
    // not re-serialize megabytes of base64 on every suspension).
    const state = await getStorageState();
    const lean = await dehydrateSnapshotMedia(snapshot, path.join(state.dir, sessionPath));
    await writeJSON(`${sessionPath}/context`, lean);
  }

  /**
   * Read a persisted context snapshot. By default, media externalized by
   * {@link writeContextSnapshot} is restored inline so the messages are valid AI
   * SDK ModelMessages for replay. Callers that only need usage/metadata (not the
   * message bytes) can pass `{ rehydrateMedia: false }` to skip the cache reads.
   */
  async readContextSnapshot(
    sessionID: string,
    agentId: string,
    opts: { rehydrateMedia?: boolean } = {}
  ): Promise<ContextSnapshot | null> {
    const sessionPath = await this.resolveSessionDir(sessionID, agentId);
    const snapshot = await readJSON<ContextSnapshot>(`${sessionPath}/context`);
    if (!snapshot || opts.rehydrateMedia === false) return snapshot;
    const state = await getStorageState();
    return rehydrateSnapshotMedia(snapshot, path.join(state.dir, sessionPath));
  }

  async writeToolOutputArtifact(
    sessionID: string,
    agentId: string,
    messageID: string,
    toolName: string,
    output: unknown
  ): Promise<ToolOutputArtifactRef> {
    const state = await getStorageState();
    const sessionPath = this.knownSessionPath(sessionID, agentId);
    const relativePath = buildToolOutputArtifactPath(sessionPath, messageID, toolName, 'json');
    const absolutePath = path.join(state.dir, relativePath);
    const createdAt = Date.now();
    const artifact = {
      kind: 'tool-output',
      toolName,
      createdAt,
      sessionID,
      agentId,
      messageID,
      output,
    };
    const serialized = stringifyToolOutputArtifact(artifact);

    await this.serializedWrite(relativePath, async () => {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const tmp = `${absolutePath}.${process.pid}.${ulid()}.tmp`;
      try {
        await fs.writeFile(tmp, serialized, 'utf-8');
        await fs.rename(tmp, absolutePath);
      } catch (error) {
        try {
          await fs.unlink(tmp);
        } catch {
          // Ignore cleanup errors.
        }
        throw error;
      }
    });

    return {
      kind: 'tool-output',
      path: relativePath,
      absolutePath,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      originalChars: measureToolOutputChars(output),
    };
  }

  async createToolOutputArtifactStream(
    sessionID: string,
    agentId: string,
    messageID: string,
    toolName: string,
    metadata: Record<string, unknown> = {}
  ): Promise<ToolOutputArtifactStream> {
    const state = await getStorageState();
    const sessionPath = this.knownSessionPath(sessionID, agentId);
    const relativePath = buildToolOutputArtifactPath(sessionPath, messageID, toolName, 'txt');
    const absolutePath = path.join(state.dir, relativePath);
    const tmp = `${absolutePath}.${process.pid}.${ulid()}.tmp`;
    const createdAt = Date.now();

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const stream = createWriteStream(tmp, { encoding: 'utf8' });
    let bytes = 0;
    let chars = 0;
    let streamError: Error | undefined;
    let settled = false;
    const pendingWrites: Promise<void>[] = [];

    stream.on('error', (error) => {
      streamError = error;
    });

    const enqueueWrite = (chunk: string): void => {
      if (settled || chunk.length === 0) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      chars += chunk.length;
      const write = new Promise<void>((resolve, reject) => {
        stream.write(chunk, 'utf8', (error) => {
          if (error) reject(error);
          else resolve();
        });
      }).catch((error) => {
        if (!streamError) {
          streamError = error as Error;
        }
      });
      pendingWrites.push(write);
    };

    const header = [
      '# AgentUse Tool Output Artifact',
      `kind: tool-output`,
      `tool: ${toolName}`,
      `createdAt: ${new Date(createdAt).toISOString()}`,
      `sessionID: ${sessionID}`,
      `agentId: ${agentId}`,
      `messageID: ${messageID}`,
      Object.keys(metadata).length > 0
        ? `metadata: ${stringifyToolOutputArtifact(metadata)}`
        : undefined,
      '',
    ].filter((line): line is string => line !== undefined).join('\n');

    enqueueWrite(`${header}\n`);

    const closeStream = async (): Promise<void> => {
      await Promise.all(pendingWrites);
      if (streamError) throw streamError;
      await new Promise<void>((resolve, reject) => {
        stream.end(() => {
          if (streamError) reject(streamError);
          else resolve();
        });
      });
    };

    return {
      write(chunk: string): void {
        enqueueWrite(chunk);
      },
      async finalize(): Promise<ToolOutputArtifactRef> {
        if (settled) {
          throw new Error('Tool output artifact stream already settled');
        }
        settled = true;
        try {
          await closeStream();
          await fs.rename(tmp, absolutePath);
          return {
            kind: 'tool-output',
            path: relativePath,
            absolutePath,
            bytes,
            originalChars: chars,
          };
        } catch (error) {
          try {
            await fs.unlink(tmp);
          } catch {
            // Ignore cleanup errors.
          }
          throw error;
        }
      },
      async discard(): Promise<void> {
        if (settled) return;
        settled = true;
        await Promise.all(pendingWrites).catch(() => undefined);
        await new Promise<void>((resolve) => {
          stream.end(() => resolve());
        }).catch(() => undefined);
        try {
          await fs.unlink(tmp);
        } catch {
          // The stream may not have created the file yet, or it may already be gone.
        }
      },
    };
  }

  async getSessionDirectory(sessionID: string, agentId: string): Promise<string> {
    const state = await getStorageState();
    return path.join(state.dir, this.knownSessionPath(sessionID, agentId));
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
    error: { message: string; code: string; statusCode?: number; url?: string; detail?: string }
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
