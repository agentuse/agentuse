import { Command } from "commander";
import fs from "fs/promises";
import path from "path";
import * as dotenv from "dotenv";
import { getSessionStorageDir, getProjectDir, getXdgDataDir } from "../storage/paths";
import type { SessionInfo, Message, Part, SessionStatus } from "../session/types";
import { initStorage } from "../storage";
import { SessionManager } from "../session";
import { resolveProjectContext } from "../utils/project";
import { loadGlobalDefaults } from "../utils/global-config";
import { logger, LogLevel } from "../utils/logger";
import { parseAgent } from "../parser";
import { connectMCP } from "../mcp";
import { applyResumeToolResult, restoreResumeToolResult, runAgent, describeErrorPart } from "../runner";
import { describeLearningOutcome } from "../learning";
import { findServerForProject } from "../utils/server-registry";

interface SessionSummary {
  id: string;
  agentId: string;
  agentName: string;
  model: string;
  created: Date;
  isSubAgent: boolean;
  parentSessionID?: string;
  dirPath: string;
  projectRoot: string;
  status?: SessionStatus;
  errorCode?: string;
  errorMessage?: string;
}

interface SessionScope {
  kind: "project" | "all";
  projectRoot?: string;
}

interface SessionMatch {
  summary: SessionSummary;
  allSearchMatch: boolean;
}

interface ResumeExecutionContext {
  cwd: string;
  projectContext: {
    projectRoot: string;
    stateRoot: string;
    envFile: string;
    pluginDirs: string[];
  };
}

/**
 * Compute agent ID from file path and project root
 * Used for migrating old sessions that don't have agent.id
 */
function computeAgentId(filePath: string | undefined, projectRoot: string, agentName: string): string {
  if (filePath) {
    return path.relative(projectRoot, filePath).replace(/\.agentuse$/, '');
  }
  return agentName;
}

export function resolveResumeExecutionContext(
  session: SessionInfo,
  stateRoot: string,
  options: { directory?: string },
  fallbackCwd: string
): ResumeExecutionContext {
  const cwd = options.directory
    ? path.resolve(options.directory)
    : session.project.cwd || fallbackCwd;
  const executionContext = resolveProjectContext(cwd);

  return {
    cwd,
    projectContext: {
      ...executionContext,
      // Persisted session project.root is the storage/identity root. Keep it
      // separate from the cwd-derived execution root used for env/plugins/tools.
      stateRoot,
    },
  };
}

/**
 * Parse session directory name to extract ID and agent name
 * Format: {sessionID}-{agentName}
 */
function parseSessionDirName(dirName: string): { id: string; agentName: string } | null {
  // ULID is 26 characters
  const ulidLength = 26;
  if (dirName.length < ulidLength + 2) {
    return null;
  }

  const id = dirName.substring(0, ulidLength);
  const agentName = dirName.substring(ulidLength + 1); // Skip the hyphen

  // Validate ULID format (basic check)
  if (!/^[0-9A-Z]{26}$/i.test(id)) {
    return null;
  }

  return { id, agentName };
}

async function walkSessionDirs(sessionDir: string, relativeDir = ""): Promise<string[]> {
  const absoluteDir = path.join(sessionDir, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const results: string[] = entries.some((entry) => entry.isFile() && entry.name === "session.json")
    ? [relativeDir]
    : [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    results.push(...await walkSessionDirs(sessionDir, path.join(relativeDir, entry.name)));
  }

  return results;
}

function sessionSummaryFromInfo(sessionInfo: SessionInfo & { agent: { id?: string } }, dirPath: string, projectRoot: string): SessionSummary {
  const agentId = sessionInfo.agent.id
    ?? computeAgentId(sessionInfo.agent.filePath, sessionInfo.project.root, sessionInfo.agent.name);

  return {
    id: sessionInfo.id,
    agentId,
    agentName: sessionInfo.agent.name,
    model: sessionInfo.model,
    created: new Date(sessionInfo.time.created),
    isSubAgent: sessionInfo.agent.isSubAgent,
    ...(sessionInfo.parentSessionID && { parentSessionID: sessionInfo.parentSessionID }),
    dirPath,
    projectRoot: sessionInfo.project.root || projectRoot,
    status: sessionInfo.status,
    ...(sessionInfo.error?.code && { errorCode: sessionInfo.error.code }),
    ...(sessionInfo.error?.message && { errorMessage: sessionInfo.error.message }),
  };
}

/**
 * List all sessions from storage
 */
async function listSessions(projectRoot: string): Promise<SessionSummary[]> {
  const sessionDir = await getSessionStorageDir(projectRoot);
  const sessions: SessionSummary[] = [];

  try {
    const sessionDirs = await walkSessionDirs(sessionDir);

    for (const relativeDir of sessionDirs) {
      const dirName = path.basename(relativeDir);
      const parsed = parseSessionDirName(dirName);
      if (!parsed) continue;

      // Try to read session.json for more details
      const dirPath = path.join(sessionDir, relativeDir);
      const sessionJsonPath = path.join(dirPath, "session.json");
      try {
        const content = await fs.readFile(sessionJsonPath, "utf-8");
        // Use Partial for agent.id to handle old sessions that don't have it
        const sessionInfo = JSON.parse(content) as SessionInfo & { agent: { id?: string } };

        sessions.push(sessionSummaryFromInfo(sessionInfo, dirPath, projectRoot));
      } catch {
        // If session.json is missing or invalid, use parsed info
        sessions.push({
          id: parsed.id,
          agentId: parsed.agentName, // Use agentName as fallback for old sessions without session.json
          agentName: parsed.agentName,
          model: "unknown",
          created: new Date(0),
          isSubAgent: false,
          dirPath,
          projectRoot,
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
    return [];
  }

  // Sort by created date (newest first)
  sessions.sort((a, b) => b.created.getTime() - a.created.getTime());

  return sessions;
}

async function listAllProjectSessions(): Promise<SessionSummary[]> {
  const projectsDir = path.join(getXdgDataDir(), "agentuse", "project");
  const sessions: SessionSummary[] = [];

  const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const sessionDir = path.join(projectsDir, projectEntry.name, "session");
    const sessionDirs = await walkSessionDirs(sessionDir).catch(() => []);

    for (const relativeDir of sessionDirs) {
      const dirName = path.basename(relativeDir);
      const parsed = parseSessionDirName(dirName);
      if (!parsed) continue;

      const dirPath = path.join(sessionDir, relativeDir);
      const sessionJsonPath = path.join(dirPath, "session.json");
      try {
        const content = await fs.readFile(sessionJsonPath, "utf-8");
        const sessionInfo = JSON.parse(content) as SessionInfo & { agent: { id?: string } };
        const projectRoot = sessionInfo.project.root;
        sessions.push(sessionSummaryFromInfo(sessionInfo, dirPath, projectRoot));
      } catch {
        sessions.push({
          id: parsed.id,
          agentId: parsed.agentName,
          agentName: parsed.agentName,
          model: "unknown",
          created: new Date(0),
          isSubAgent: false,
          dirPath,
          projectRoot: projectEntry.name,
        });
      }
    }
  }

  sessions.sort((a, b) => b.created.getTime() - a.created.getTime());
  return sessions;
}

/**
 * Get session details including messages and parts
 */
async function getSessionDetails(
  sessionDir: string
): Promise<{
  session: SessionInfo | null;
  messages: Array<{ message: Message; parts: Part[] }>;
}> {
  const result: {
    session: SessionInfo | null;
    messages: Array<{ message: Message; parts: Part[] }>;
  } = {
    session: null,
    messages: [],
  };

  // Read session.json
  try {
    const sessionContent = await fs.readFile(
      path.join(sessionDir, "session.json"),
      "utf-8"
    );
    // Use Partial for agent.id to handle old sessions that don't have it
    const rawSession = JSON.parse(sessionContent) as SessionInfo & { agent: { id?: string } };

    // Migrate old sessions: compute agentId if missing
    if (!rawSession.agent.id) {
      rawSession.agent.id = computeAgentId(rawSession.agent.filePath, rawSession.project.root, rawSession.agent.name);
    }
    result.session = rawSession as SessionInfo;
  } catch {
    return result;
  }

  // List message directories (ULIDs)
  const entries = await fs.readdir(sessionDir, { withFileTypes: true });
  const messageDirs = entries.filter(
    (e) => e.isDirectory() && /^[0-9A-Z]{26}$/i.test(e.name)
  );

  for (const msgDir of messageDirs) {
    const msgPath = path.join(sessionDir, msgDir.name);

    // Read message.json
    let message: Message | null = null;
    try {
      const msgContent = await fs.readFile(
        path.join(msgPath, "message.json"),
        "utf-8"
      );
      message = JSON.parse(msgContent) as Message;
    } catch {
      continue;
    }

    // Read parts
    const parts: Part[] = [];
    const partDir = path.join(msgPath, "part");
    try {
      const partFiles = await fs.readdir(partDir);
      for (const partFile of partFiles) {
        if (!partFile.endsWith(".json")) continue;
        try {
          const partContent = await fs.readFile(
            path.join(partDir, partFile),
            "utf-8"
          );
          parts.push(JSON.parse(partContent) as Part);
        } catch {
          // Skip invalid part files
        }
      }
    } catch {
      // No parts directory
    }

    result.messages.push({ message, parts });
  }

  // Sort messages by created time
  result.messages.sort(
    (a, b) => a.message.time.created - b.message.time.created
  );

  return result;
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  if (date.getTime() === 0) return "unknown";
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } else if (days < 7) {
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } else {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.substring(0, len - 1) + "…";
}

function resolveProjectOption(project?: string | boolean): string {
  if (typeof project === "string" && project.length > 0) {
    return path.resolve(project);
  }
  return process.cwd();
}

function resolveSessionScope(options?: { all?: boolean; project?: string | boolean }): SessionScope {
  if (options?.all && options.project !== undefined) {
    throw new Error("--all and --project cannot be used together");
  }

  if (options?.all) {
    return { kind: "all" };
  }

  const projectContext = resolveProjectContext(resolveProjectOption(options?.project));
  return { kind: "project", projectRoot: projectContext.projectRoot };
}

function statusLabel(status?: SessionStatus, errorCode?: string): string {
  if (status === 'error' && errorCode === 'USER_STOPPED') return 'stopped';
  if (status === 'error' && errorCode === 'TIMEOUT') return 'timeout';
  return status === 'completed'
    ? 'done'
    : status === 'error'
      ? 'fail'
      : status === 'suspended'
        ? 'suspended'
        : 'running';
}

function projectLabel(projectRoot: string): string {
  if (/^[a-f0-9]{16}$/i.test(projectRoot)) return projectRoot;
  return path.basename(projectRoot) || projectRoot;
}

async function sessionsForScope(scope: SessionScope): Promise<SessionSummary[]> {
  if (scope.kind === "all") {
    return listAllProjectSessions();
  }
  return listSessions(scope.projectRoot!);
}

async function runSessionsAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

/**
 * Format value for full display (multi-line, indented)
 */
function formatValueFull(value: unknown, indent: string = "        "): string {
  if (value === null || value === undefined) {
    return `${indent}${String(value)}`;
  }

  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "object") {
    try {
      str = JSON.stringify(value, null, 2);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  // Indent each line
  return str
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * Format tool name for cleaner display
 * mcp__bash__run_bash -> Bash{run_bash}
 * mcp__notion__API-post-page -> Notion{API-post-page}
 */
function formatToolName(toolName: string): string {
  // Handle MCP tools: mcp__<server>__<method>
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.substring(5).split("__");
    if (parts.length >= 2) {
      const server = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      const method = parts.slice(1).join("__");
      return `${server}{${method}}`;
    }
  }
  return toolName;
}

/**
 * Extract main input value for inline display
 */
function extractMainInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;

  const obj = input as Record<string, unknown>;

  // Priority order for common input fields
  const priorityFields = ["command", "query", "url", "path", "file_path", "pattern", "text", "content"];

  for (const field of priorityFields) {
    if (obj[field] && typeof obj[field] === "string") {
      return obj[field] as string;
    }
  }

  // Fallback: use first string value
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.length < 200) {
      return value;
    }
  }

  return null;
}

/**
 * Extract output value for display (unwrap common wrapper patterns)
 */
function extractOutputValue(output: unknown): string {
  if (output === null || output === undefined) return String(output);

  if (typeof output === "string") return output;

  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;

    // Common wrapper patterns
    if (obj.output && typeof obj.output === "string") {
      return obj.output;
    }
    if (obj.result && typeof obj.result === "string") {
      return obj.result;
    }
    if (obj.content && typeof obj.content === "string") {
      return obj.content;
    }

    // Fallback to JSON
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  return String(output);
}

function parseToolResult(raw?: string): unknown {
  if (!raw) {
    throw new Error("Missing --tool-result JSON");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("--tool-result must be valid JSON");
  }
}

function decisionValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildApprovalToolResult(options: {
  approve?: string | boolean;
  reject?: string | boolean;
  comment?: string;
}): unknown | null {
  const decisions = [
    options.approve !== undefined ? "approve" : null,
    options.reject !== undefined ? "reject" : null,
    options.comment !== undefined ? "comment" : null,
  ].filter(Boolean);

  if (decisions.length === 0) return null;
  if (decisions.length > 1) {
    throw new Error("Choose only one of --approve, --reject, or --comment");
  }

  const status = decisions[0]!;
  const comment = status === "approve"
    ? decisionValue(options.approve)
    : status === "reject"
      ? decisionValue(options.reject)
      : options.comment;

  return {
    status,
    ...(comment && { comment }),
    reviewer: { username: "cli" }
  };
}

function lastAssistantText(details: { messages: Array<{ message: Message; parts: Part[] }> }): string | undefined {
  for (const entry of [...details.messages].reverse()) {
    const text = [...entry.parts].reverse().find((part): part is Part & { type: "text"; text: string } =>
      part.type === "text" && typeof (part as any).text === "string" && (part as any).text.trim().length > 0
    );
    if (text) return text.text.trim();
  }
  return undefined;
}

function buildContinuationPrompt(session: SessionInfo, details: { messages: Array<{ message: Message; parts: Part[] }> }, prompt?: string): string {
  const previous = lastAssistantText(details);
  return [
    `Continue from previous AgentUse session ${session.id}.`,
    `Previous session status: ${session.status}.`,
    previous ? `Previous final assistant output:\n${previous}` : undefined,
    prompt?.trim()
      ? `New instruction:\n${prompt.trim()}`
      : "New instruction:\nContinue from where the previous session left off.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Format tool output with truncation and line limits
 */
function formatToolOutput(output: string, maxLen: number = 200, maxLines: number = 5): string {
  const lines = output.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > maxLen) {
      line = line.substring(0, maxLen) + `… [${output.length} chars]`;
    }
    result.push(line);

    // Limit lines in non-full mode
    if (i >= maxLines - 1 && lines.length > maxLines) {
      result.push(`... (${lines.length - maxLines} more lines)`);
      break;
    }
  }

  return result.join("\n");
}

export function createSessionsCommand(): Command {
  const sessionsCmd = new Command("sessions")
    .description("Manage AgentUse sessions")
    .action(async () => runSessionsAction(async () => {
      const projectContext = resolveProjectContext(process.cwd());
      await listSessionsCommand({ kind: "project", projectRoot: projectContext.projectRoot }, { limit: "10" });
    }));

  // Add explicit list subcommand for clarity
  sessionsCmd
    .command("list")
    .alias("ls")
    .description("List sessions")
    .option("-s, --subagents", "Include subagent sessions")
    .option("-n, --limit <n>", "Limit number of sessions to show", "10")
    .option("-j, --json", "Output as JSON")
    .option("--all", "Show sessions across all projects")
    .option("--project [path]", "Show sessions for a project path; defaults to the current project")
    .action(async (options: { subagents?: boolean; limit?: string; json?: boolean; all?: boolean; project?: string | boolean }) => runSessionsAction(async () => {
      const scope = resolveSessionScope(options);
      await listSessionsCommand(scope, options);
    }));

  // Add show subcommand
  sessionsCmd
    .command("show <id>")
    .description("Show session details")
    .option("-j, --json", "Output as JSON")
    .option("-f, --full", "Show full tool input/output (not truncated)")
    .option("--project [path]", "Search a project path; defaults to the current project")
    .option("--all-search", "Search all projects if the session is not in the selected project")
    .action(async (id: string, options: { json?: boolean; full?: boolean; project?: string | boolean; allSearch?: boolean }) => runSessionsAction(async () => {
      const scope = resolveSessionScope(options);
      await showSession(scope, id, options);
    }));

  sessionsCmd
    .command("resume <id>")
    .description("Resume a suspended or ended session")
    .option("--approve [comment]", "Approve a suspended approval request")
    .option("--reject [comment]", "Reject a suspended approval request with an optional comment")
    .option("--comment <comment>", "Send a reviewer comment to a suspended approval request")
    .option("--tool-result <json>", "JSON result for a suspended non-approval await_* tool")
    .option("--prompt <text>", "Instruction for continuing an ended session")
    .option("--project [path]", "Search a project path; defaults to the current project")
    .option("--all-search", "Search all projects if the session is not in the selected project")
    .option("-C, --directory <path>", "Run as if agentuse was started in <path> instead of the current directory")
    .option("-d, --debug", "Enable debug logging")
    .action(async (id: string, options: {
      approve?: string | boolean;
      reject?: string | boolean;
      comment?: string;
      toolResult?: string;
      prompt?: string;
      project?: string | boolean;
      allSearch?: boolean;
      directory?: string;
      debug?: boolean;
    }) => runSessionsAction(async () => {
      await resumeSession(id, options);
    }));

  sessionsCmd
    .command("stop <id>")
    .alias("cancel")
    .description("Stop a running or suspended session and its subagent children")
    .option("--reason <text>", "Reason recorded on the stopped session")
    .option("--project [path]", "Search a project path; defaults to the current project")
    .option("--all-search", "Search all projects if the session is not in the selected project")
    .action(async (id: string, options: { reason?: string; project?: string | boolean; allSearch?: boolean }) => runSessionsAction(async () => {
      const scope = resolveSessionScope(options);
      await stopSession(scope, id, options);
    }));

  // Add path subcommand to show storage location
  sessionsCmd
    .command("path")
    .description("Show session storage path")
    .option("--project [path]", "Show storage path for a project path; defaults to the current project")
    .action(async (options: { project?: string | boolean }) => runSessionsAction(async () => {
      const projectContext = resolveProjectContext(resolveProjectOption(options.project));
      const projectDir = await getProjectDir(projectContext.projectRoot);
      const sessionDir = await getSessionStorageDir(projectContext.projectRoot);

      process.stdout.write(`Project:     ${projectContext.projectRoot}\n`);
      process.stdout.write(`Project dir: ${projectDir}\n`);
      process.stdout.write(`Sessions:    ${sessionDir}\n`);
    }));

  return sessionsCmd;
}

async function listSessionsCommand(
  scope: SessionScope,
  options?: { subagents?: boolean; limit?: string; json?: boolean }
): Promise<void> {
  let sessions = await sessionsForScope(scope);

  // Filter out subagents unless --subagents is specified
  if (!options?.subagents) {
    sessions = sessions.filter((s) => !s.isSubAgent);
  }

  // Apply limit
  const limit = parseInt(options?.limit || "10");
  if (limit > 0 && sessions.length > limit) {
    sessions = sessions.slice(0, limit);
  }

  if (sessions.length === 0) {
    if (scope.kind === "all") {
      process.stdout.write("No sessions found across all projects\n");
    } else {
      process.stdout.write(`No sessions for current project: ${scope.projectRoot}\n\n`);
      process.stdout.write("Use `agentuse sessions list --all` to search all projects.\n");
    }
    return;
  }

  if (options?.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    return;
  }

  // Calculate column widths
  const idWidth = 12; // First 12 chars of ULID
  const statusWidth = 9; // "suspended"
  const projectWidth = scope.kind === "all"
    ? Math.min(28, Math.max(...sessions.map((s) => projectLabel(s.projectRoot).length)))
    : 0;
  const agentWidth = Math.min(
    40,
    Math.max(...sessions.map((s) => s.agentId.length))
  );

  // Header
  if (scope.kind === "all") {
    process.stdout.write("All sessions\n\n");
    process.stdout.write(
      `${"ID".padEnd(idWidth)}  ${"STATUS".padEnd(statusWidth)}  ${"PROJECT".padEnd(projectWidth)}  ${"AGENT".padEnd(agentWidth)}  DATE\n`
    );
    process.stdout.write(`${"-".repeat(idWidth + statusWidth + projectWidth + agentWidth + 18)}\n`);
  } else {
    process.stdout.write(`Sessions for current project: ${scope.projectRoot}\n\n`);
    process.stdout.write(
      `${"ID".padEnd(idWidth)}  ${"STATUS".padEnd(statusWidth)}  ${"AGENT".padEnd(agentWidth)}  DATE\n`
    );
    process.stdout.write(`${"-".repeat(idWidth + statusWidth + agentWidth + 16)}\n`);
  }

  // Rows
  for (const session of sessions) {
    const shortId = session.id.substring(0, idWidth);
    const statusText = statusLabel(session.status, session.errorCode);
    const agent = truncate(session.agentId, agentWidth).padEnd(agentWidth);
    const date = formatDate(session.created);

    if (scope.kind === "all") {
      const project = truncate(projectLabel(session.projectRoot), projectWidth).padEnd(projectWidth);
      process.stdout.write(`${shortId}  ${statusText.padEnd(statusWidth)}  ${project}  ${agent}  ${date}\n`);
    } else {
      process.stdout.write(`${shortId}  ${statusText.padEnd(statusWidth)}  ${agent}  ${date}\n`);
    }
  }

  // Footer
  if (sessions.length > 0) {
    process.stdout.write(
      `\nShowing ${sessions.length} session(s). Use 'agentuse sessions show <id>' for details.\n`
    );
  }
}

async function showSession(
  scope: SessionScope,
  sessionId: string,
  options?: { json?: boolean; full?: boolean; allSearch?: boolean }
): Promise<void> {
  const match = await resolveSessionByScope(scope, sessionId, {
    ...(options?.allSearch !== undefined && { allSearch: options.allSearch })
  });
  const session = match.summary;
  const details = await getSessionDetails(session.dirPath);

  if (!details.session) {
    process.stderr.write(`Failed to read session: ${sessionId}\n`);
    process.exit(1);
  }

  const s = details.session;
  const childSessions = (await listSessions(session.projectRoot))
    .filter((child) => child.parentSessionID === s.id)
    .sort((a, b) => a.created.getTime() - b.created.getTime() || a.id.localeCompare(b.id));

  if (options?.json) {
    process.stdout.write(JSON.stringify({ ...details, projectRoot: session.projectRoot, childSessions }, null, 2) + "\n");
    return;
  }

  const showFull = options?.full ?? false;

  // Display session info

  process.stdout.write(`\n${"═".repeat(60)}\n`);
  process.stdout.write(`SESSION: ${s.id}\n`);
  process.stdout.write(`${"═".repeat(60)}\n\n`);

  if (match.allSearchMatch) {
    process.stdout.write(`Found in project: ${session.projectRoot}\n\n`);
  }

  process.stdout.write(`Agent:       ${s.agent.name}\n`);
  if (s.agent.description) {
    process.stdout.write(`Description: ${s.agent.description}\n`);
  }
  if (s.agent.filePath) {
    process.stdout.write(`File:        ${s.agent.filePath}\n`);
  }
  process.stdout.write(`Model:       ${s.model}\n`);
  process.stdout.write(`Started:     ${new Date(s.time.created).toLocaleString()}\n`);

  // Display session status
  const statusIcon = s.status === 'completed' ? '✓' : s.status === 'error' ? '✗' : s.status === 'suspended' ? '⏸' : '⋯';
  process.stdout.write(`Status:      ${statusIcon} ${s.status || 'unknown'}\n`);

  if (s.config.mcpServers && s.config.mcpServers.length > 0) {
    process.stdout.write(`MCP Servers: ${s.config.mcpServers.join(", ")}\n`);
  }

  process.stdout.write(`\nProject:     ${s.project.root}\n`);
  process.stdout.write(`Working Dir: ${s.project.cwd}\n`);

  if (childSessions.length > 0) {
    process.stdout.write(`\nSubagents:\n`);
    for (const child of childSessions) {
      process.stdout.write(
        `  - ${child.id.substring(0, 12)}  ${statusLabel(child.status, child.errorCode).padEnd(9)}  ${child.agentId}  ${formatDate(child.created)}\n`
      );
    }
    process.stdout.write(`    Inspect with: agentuse sessions show <subagent-id> --all-search\n`);
  }

  // Display session-level error (failures before LLM calls - auth, MCP, etc.)
  if (s.error) {
    process.stdout.write(`\n${"─".repeat(60)}\n`);
    const icon = s.error.code === 'USER_INTERRUPT' ? '⚠' : '✗';
    const label = s.error.code === 'USER_INTERRUPT' ? 'INTERRUPTED' : 'ERROR';
    process.stdout.write(`${icon} ${label}: ${s.error.code}\n`);
    process.stdout.write(`  ${s.error.message}\n`);
    if (typeof s.error.statusCode === 'number') {
      process.stdout.write(`  HTTP ${s.error.statusCode}${s.error.url ? ` @ ${s.error.url}` : ''}\n`);
    }
    if (s.error.detail) {
      process.stdout.write(`  Provider response: ${s.error.detail}\n`);
    }
    process.stdout.write(`  Time: ${new Date(s.error.time).toLocaleString()}\n`);
  }

  // Display messages
  if (details.messages.length > 0) {
    process.stdout.write(`\n${"─".repeat(60)}\n`);

    for (const { message, parts } of details.messages) {
      // Show message header only if multiple messages
      if (details.messages.length > 1) {
        process.stdout.write(`[Message ${message.id.substring(0, 8)}]\n`);
      }

      // Show user prompt (first line only for task, full for user input)
      const taskFirstLine = message.user.prompt.task.split("\n")[0];
      process.stdout.write(`Task: ${truncate(taskFirstLine, 80)}\n`);
      if (message.user.prompt.user) {
        process.stdout.write(`User: ${message.user.prompt.user}\n`);
      }

      // Show the full-rate spend split (non-cached input + output) so cheap,
      // re-counted cache reads don't inflate the headline; cached reads are
      // appended with a leading '+' to mark them as on-top, not inside, input.
      const tokens = message.assistant.tokens;
      const cached = Math.max(0, tokens.cache?.read ?? 0);
      const newInput = Math.max(0, tokens.input - cached);
      let statsLine = `Tokens: in ${newInput}, out ${tokens.output}`;
      statsLine += cached > 0 ? `, +${cached} cached` : '';

      // Add duration if completed timestamp exists
      if (message.time.completed) {
        const durationMs = message.time.completed - message.time.created;
        const durationSec = (durationMs / 1000).toFixed(1);
        statsLine += `  Duration: ${durationSec}s`;
      }
      process.stdout.write(statsLine + "\n");
      if (message.assistant.context) {
        const context = message.assistant.context;
        const compacted = context.compacted ? `, compacted ${context.compactions}x` : '';
        const left = context.contextLimit
          ? `${Math.max(0, 100 - context.usagePercentage).toFixed(1)}% left, `
          : '';
        const limit = context.contextLimit ? ` / ${context.contextLimit}` : '';
        process.stdout.write(
          `Context used: ${left}${context.activeTokens}${limit}${compacted}\n`
        );
      }

      // Show error if session failed
      if (message.assistant.error) {
        process.stdout.write(`\n✗ Error: ${message.assistant.error.message}\n`);
        if (message.assistant.error.type) {
          process.stdout.write(`  Type: ${message.assistant.error.type}\n`);
        }
      }

      // Count parts by type
      const partCounts: Record<string, number> = {};
      for (const part of parts) {
        partCounts[part.type] = (partCounts[part.type] || 0) + 1;
      }

      if (Object.keys(partCounts).length > 0) {
        const partSummary = Object.entries(partCounts)
          .map(([type, count]) => `${type}: ${count}`)
          .join(", ");
        process.stdout.write(`Parts: ${partSummary}\n`);
      }

      // Show tools summary
      const toolParts = parts.filter((p) => p.type === "tool") as Array<
        Part & {
          type: "tool";
          tool: string;
          state: {
            status: string;
            input?: unknown;
            output?: unknown;
            error?: string;
            time?: { start: number; end?: number };
          }
        }
      >;
      if (toolParts.length > 0) {
        // Count tools by name for summary
        const toolCounts: Record<string, number> = {};
        for (const tool of toolParts) {
          toolCounts[tool.tool] = (toolCounts[tool.tool] || 0) + 1;
        }
        const toolSummary = Object.entries(toolCounts)
          .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
          .join(", ");
        process.stdout.write(`Tools: ${toolParts.length} calls (${truncate(toolSummary, 60)})\n`);
      }

      // Show interleaved output (text and tool parts in chronological order)
      // Sort parts by ULID id (which is chronologically sortable)
      const displayParts = parts
        .filter((p) => p.type === "text" || p.type === "tool" || p.type === "compaction" || p.type === "learning" || p.type === "error" || p.type === "log")
        .sort((a, b) => a.id.localeCompare(b.id));

      if (displayParts.length > 0) {
        process.stdout.write(`\nOutput:\n`);

        for (const part of displayParts) {
          if (part.type === "text") {
            const textPart = part as Part & { type: "text"; text: string };
            if (textPart.text.trim()) {
              // Plain text output, no prefix
              process.stdout.write(`${textPart.text.trim()}\n`);
            }
          } else if (part.type === "tool") {
            const tool = part as Part & {
              type: "tool";
              tool: string;
              state: {
                status: string;
                input?: unknown;
                output?: unknown;
                error?: string;
                resumePayload?: {
                  kind?: string;
                  approvalUrl?: string;
                  channelMessage?: {
                    url?: string;
                  };
                };
                time?: { start: number; end?: number };
              }
            };

            const status =
              tool.state.status === "completed"
                ? "✓"
                : tool.state.status === "error"
                  ? "✗"
                  : "…";

            // Format tool name: mcp__bash__run_bash -> Bash{run_bash}
            const toolName = formatToolName(tool.tool);

            // Extract main input for inline display
            const mainInput = extractMainInput(tool.state.input);
            const inputDisplay = mainInput ? ` (${truncate(mainInput, 60)})` : "";

            // Show duration if available
            let durationStr = "";
            if (tool.state.time?.start && tool.state.time?.end) {
              const durationMs = tool.state.time.end - tool.state.time.start;
              durationStr = durationMs < 1000
                ? ` ${durationMs}ms`
                : ` ${(durationMs / 1000).toFixed(1)}s`;
            }

            // Visual indicator for tool call
            const header = `─── ${status} ${toolName}${inputDisplay}${durationStr} `;
            const padding = Math.max(0, 60 - header.length);
            process.stdout.write(`\n${header}${"─".repeat(padding)}\n`);

            // Show full input in --full mode
            if (showFull && tool.state.input !== undefined) {
              process.stdout.write(`Input:\n`);
              process.stdout.write(formatValueFull(tool.state.input, "  ") + "\n");
            }

            const approvalUrl = tool.state.resumePayload?.approvalUrl ?? tool.state.resumePayload?.channelMessage?.url;
            if (tool.state.status === "pending" && tool.state.resumePayload?.kind === "await_human") {
              process.stdout.write(`Approval: pending\n`);
              if (approvalUrl) {
                process.stdout.write(`Review URL: ${approvalUrl}\n`);
              }
            }

            // Show output or error
            if (tool.state.status === "error" && tool.state.error) {
              if (showFull) {
                process.stdout.write(`Error:\n`);
                process.stdout.write(formatValueFull(tool.state.error, "  ") + "\n");
              } else {
                const errorOutput = formatToolOutput(tool.state.error, 150);
                process.stdout.write(`${errorOutput}\n`);
              }
            } else if (tool.state.status === "completed" && tool.state.output !== undefined) {
              if (showFull) {
                process.stdout.write(`Result:\n`);
                process.stdout.write(formatValueFull(tool.state.output, "  ") + "\n");
              } else {
                const outputValue = extractOutputValue(tool.state.output);
                const formattedOutput = formatToolOutput(outputValue, 150);
                process.stdout.write(`${formattedOutput}\n`);
              }
            }

            // Closing separator
            process.stdout.write(`${"─".repeat(60)}\n`);
          } else if (part.type === "compaction") {
            const c = part as Part & {
              type: "compaction";
              reason: string;
              tokensBefore: number;
              tokensAfter: number;
            };
            const before = c.tokensBefore ?? 0;
            const after = c.tokensAfter ?? 0;
            const pct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
            const reasonLabel = c.reason === "approval"
              ? "approval gate"
              : c.reason === "step"
                ? "step boundary"
                : "context limit";
            const detail = before > 0
              ? `${formatTokenCountCli(before)} → ${formatTokenCountCli(after)} tokens (-${pct}%), ${reasonLabel}`
              : `at ${reasonLabel}`;
            process.stdout.write(`\n⇲ Context compacted: ${detail}\n`);
          } else if (part.type === "learning") {
            const l = part as Part & {
              type: "learning";
              status: "captured" | "none" | "failed";
              source: "auto" | "approval";
              count: number;
              titles?: string[];
              detail?: string;
            };
            const { title, message } = describeLearningOutcome({
              status: l.status,
              source: l.source,
              count: l.count ?? 0,
              titles: l.titles,
              detail: l.detail,
            });
            process.stdout.write(`\n✦ ${title}${message ? ` — ${message}` : ""}\n`);
          } else if (part.type === "error") {
            const e = part as Part & {
              type: "error";
              source: "agent" | "compaction";
              code?: string;
              message: string;
              detail?: string;
              statusCode?: number;
            };
            const { title, message } = describeErrorPart({
              source: e.source,
              code: e.code,
              message: e.message,
              detail: e.detail,
              statusCode: e.statusCode,
            });
            process.stdout.write(`\n✗ ${title}: ${truncate(message, 400)}\n`);
          } else if (part.type === "log") {
            const l = part as Part & { type: "log"; level: string; message: string };
            // Debug detail is reserved for the web view's "debug" toggle; keep the
            // CLI stream readable with only info/warn/error/system lines.
            if (l.level !== "debug") {
              process.stdout.write(`  [${l.level.toUpperCase()}] ${truncate(l.message, 400)}\n`);
            }
          }
        }
      }
    }
  }

  process.stdout.write(`\n`);
}

function formatTokenCountCli(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function renderSessionMatches(matches: SessionSummary[], includeProject = false): string {
  return matches
    .map((m) => {
      const project = includeProject ? `  ${projectLabel(m.projectRoot)}` : "";
      return `  ${m.id.substring(0, 12)}  ${m.agentName}${project}`;
    })
    .join("\n");
}

async function resolveSessionByScope(
  scope: SessionScope,
  sessionId: string,
  options: { allSearch?: boolean } = {}
): Promise<SessionMatch> {
  const selectedSessions = await sessionsForScope(scope);
  const selectedMatches = selectedSessions.filter((s) =>
    s.id.toLowerCase().startsWith(sessionId.toLowerCase())
  );

  if (selectedMatches.length === 1) {
    return { summary: selectedMatches[0], allSearchMatch: false };
  }

  if (selectedMatches.length > 1) {
    throw new Error(`Multiple sessions match '${sessionId}':\n${renderSessionMatches(selectedMatches, scope.kind === "all")}\n\nPlease use a more specific ID.`);
  }

  if (options.allSearch && scope.kind !== "all") {
    const allMatches = (await listAllProjectSessions()).filter((s) =>
      s.id.toLowerCase().startsWith(sessionId.toLowerCase())
    );

    if (allMatches.length === 1) {
      return { summary: allMatches[0], allSearchMatch: true };
    }

    if (allMatches.length > 1) {
      throw new Error(`Multiple sessions match '${sessionId}' across projects:\n${renderSessionMatches(allMatches, true)}\n\nPlease use a more specific ID or pass --project <path>.`);
    }
  }

  const scopeText = scope.kind === "all"
    ? "all projects"
    : `current project: ${scope.projectRoot}`;
  const suggestion = scope.kind === "all" || options.allSearch
    ? ""
    : "\n\nTry:\n  agentuse sessions list --all\n  agentuse sessions show " + sessionId + " --all-search";
  throw new Error(`Session ${sessionId} was not found in ${scopeText}.${suggestion}`);
}

async function stopSession(
  scope: SessionScope,
  sessionId: string,
  options: { reason?: string; allSearch?: boolean } = {}
): Promise<void> {
  const match = await resolveSessionByScope(scope, sessionId, {
    ...(options.allSearch !== undefined && { allSearch: options.allSearch })
  });
  const summary = match.summary;
  const serverStopped = await stopSessionViaServer(summary, options.reason);

  await initStorage(summary.projectRoot);
  const sessionManager = new SessionManager();
  const stopped = await sessionManager.stopSessionTree(summary.id, {
    message: options.reason ?? 'Session stopped by user'
  });

  if (stopped.length === 0) {
    throw new Error(`Session not found: ${summary.id}`);
  }

  const changed = stopped.filter((entry) => entry.stopped);
  if (changed.length === 0) {
    process.stdout.write(`Session ${summary.id} and its subagents were already ended.\n`);
    return;
  }

  process.stdout.write(`Stopped ${changed.length} session(s):\n`);
  if (serverStopped) {
    process.stdout.write(`  server: active worker was asked to abort\n`);
  }
  for (const entry of stopped) {
    const marker = entry.stopped ? '✓' : '-';
    const suffix = entry.stopped ? '' : ` (already ${entry.wasStatus})`;
    process.stdout.write(`  ${marker} ${entry.sessionId.substring(0, 12)}  ${entry.agentId}  was ${entry.wasStatus}${suffix}\n`);
  }
}

async function stopSessionViaServer(summary: SessionSummary, reason?: string): Promise<boolean> {
  const server = findServerForProject(summary.projectRoot);
  if (!server) return false;

  const project = server.projects?.find((entry) => path.resolve(entry.root) === path.resolve(summary.projectRoot))
    ?? server.projects?.find((entry) => path.resolve(summary.projectRoot).startsWith(path.resolve(entry.root) + path.sep))
    ?? server.projects?.[0];
  const host = server.host === '0.0.0.0' ? '127.0.0.1' : server.host;
  const url = `http://${host}:${server.port}/sessions/${encodeURIComponent(summary.id)}/stop`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(project?.id && { project: project.id }),
        ...(reason && { reason }),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function resumeSession(
  sessionId: string,
  options: {
    approve?: string | boolean;
    reject?: string | boolean;
    comment?: string;
    toolResult?: string;
    prompt?: string;
    project?: string | boolean;
    allSearch?: boolean;
    directory?: string;
    debug?: boolean;
  }
): Promise<void> {
  logger.configure({
    level: options.debug ? LogLevel.DEBUG : LogLevel.INFO,
    ...(options.debug && { enableDebug: true })
  });

  if (options.directory && options.project !== undefined) {
    throw new Error("--directory and --project cannot be used together");
  }

  const selectedCwd = options.directory
    ? path.resolve(options.directory)
    : resolveProjectOption(options.project);
  const selectedProjectContext = options.directory
    ? resolveProjectContext(selectedCwd, { projectRoot: selectedCwd })
    : resolveProjectContext(selectedCwd);
  const selectedScope: SessionScope = { kind: "project", projectRoot: selectedProjectContext.projectRoot };
  const resolved = await resolveSessionByScope(selectedScope, sessionId, {
    ...(options.allSearch !== undefined && { allSearch: options.allSearch })
  });
  const summary = resolved.summary;

  await initStorage(summary.projectRoot);
  const sessionManager = new SessionManager();
  const found = await sessionManager.findSession(summary.id);
  if (!found) {
    throw new Error(`Session not found: ${summary.id}`);
  }
  if (!found.session.agent.filePath) {
    throw new Error(`Session ${summary.id} does not record an agent file path`);
  }

  const fallbackCwd = resolved.allSearchMatch ? summary.projectRoot : selectedCwd;
  const { cwd, projectContext } = resolveResumeExecutionContext(
    found.session,
    summary.projectRoot,
    { ...(options.directory && { directory: options.directory }) },
    fallbackCwd
  );

  loadGlobalDefaults();
  if (projectContext.envFile) {
    try {
      dotenv.config({ path: projectContext.envFile, quiet: true });
    } catch {
      // Best-effort env loading, matching the rest of the CLI's forgiving posture.
    }
  }

  if (found.session.status === "running") {
    throw new Error(`Session ${summary.id} is already running`);
  }

  if (found.session.status === "suspended") {
    const pending = await sessionManager.findPendingTool(summary.id, found.agentId);
    if (!pending) {
      throw new Error(`Session ${summary.id} is suspended, but no pending tool was found`);
    }

    const pendingKind = pending.part.state.status === "pending"
      ? pending.part.state.resumePayload?.kind
      : undefined;

    if (pendingKind === "subagent_wait") {
      // This session is a manager parked on a delegated sub-agent's approval gate.
      // Resolving the gate + resuming the chain (the cascade) runs in the serve
      // worker, not this in-process single-session resume — applying the decision
      // here would wrongly complete the subagent_wait bookmark. Direct the operator
      // to the manager approval surface, which targets the real leaf gate.
      throw new Error(
        `Session ${summary.id} is waiting on a delegated sub-agent's approval gate. ` +
        `Approve it from the manager run's approval page (\`agentuse serve\` or the approval URL), ` +
        `not \`sessions resume\`.`
      );
    }

    const approvalResult = buildApprovalToolResult(options);
    const toolResult = approvalResult ?? (options.toolResult ? parseToolResult(options.toolResult) : undefined);

    if (!toolResult) {
      if (pendingKind === "await_human" || pending.part.tool === "await_human") {
        const input = pending.part.state.status === "pending" ? pending.part.state.input : undefined;
        const prompt = input && typeof input === "object" && typeof (input as Record<string, unknown>).prompt === "string"
          ? `\nPrompt: ${(input as Record<string, unknown>).prompt}`
          : "";
        throw new Error(`Session ${summary.id} is waiting for approval.${prompt}\nUse --approve, --reject, or --comment.`);
      }
      throw new Error(`Session ${summary.id} is waiting on ${pending.part.tool}. Use --tool-result <json>.`);
    }

    const resumed = await applyResumeToolResult({
      sessionManager,
      sessionId: summary.id,
      toolResult,
      skipTokenValidation: true
    });
    try {
      const agentPath = resumed.agentFilePath ?? found.session.agent.filePath;
      const agent = await parseAgent(agentPath);
      const mcp = await connectMCP(agent.config.mcpServers, options.debug ?? false, path.dirname(agentPath));

      const result = await runAgent(
        agent,
        mcp,
        options.debug ?? false,
        undefined,
        Date.now(),
        options.debug ?? false,
        agentPath,
        undefined,
        sessionManager,
        { projectRoot: projectContext.projectRoot, stateRoot: projectContext.stateRoot, cwd },
        undefined,
        undefined,
        false,
        undefined,
        true,
        summary.id
      );

      // Learning capture (execution + any reviewer comments) runs once inside
      // runAgent's post-run lifecycle, so nothing extra is needed here.

      process.stdout.write(JSON.stringify({
        success: true,
        sessionId: summary.id,
        status: result.status ?? "completed",
        result: {
          text: result.text,
          finishReason: result.finishReason,
          toolCalls: result.toolCallCount
        }
      }, null, 2) + "\n");
    } catch (err) {
      await restoreResumeToolResult({ sessionManager, rollback: resumed.rollback }).catch((restoreErr) => {
        logger.warn(`Failed to restore pending approval after resume error: ${(restoreErr as Error).message}`);
      });
      throw err;
    }
    return;
  }

  if (options.approve !== undefined || options.reject !== undefined || options.comment !== undefined || options.toolResult) {
    throw new Error(`Session ${summary.id} is ${found.session.status}; approval and tool-result flags only apply to suspended sessions`);
  }

  const details = await getSessionDetails(summary.dirPath);
  if (!details.session) {
    throw new Error(`Failed to read session: ${summary.id}`);
  }

  const agent = await parseAgent(found.session.agent.filePath);
  const mcp = await connectMCP(agent.config.mcpServers, options.debug ?? false, path.dirname(found.session.agent.filePath));
  const continuationPrompt = buildContinuationPrompt(found.session, details, options.prompt);
  const result = await runAgent(
    agent,
    mcp,
    options.debug ?? false,
    undefined,
    Date.now(),
    options.debug ?? false,
    found.session.agent.filePath,
    undefined,
    sessionManager,
    { projectRoot: projectContext.projectRoot, stateRoot: projectContext.stateRoot, cwd },
    continuationPrompt,
    undefined,
    false,
    undefined,
    true
  );

  process.stdout.write(JSON.stringify({
    success: true,
    continuedFrom: summary.id,
    status: result.status ?? "completed",
    result: {
      text: result.text,
      finishReason: result.finishReason,
      toolCalls: result.toolCallCount
    }
  }, null, 2) + "\n");
}
