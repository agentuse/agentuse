import { Command } from "commander";
import fs from "fs/promises";
import path from "path";
import { getSessionStorageDir, getProjectDir } from "../storage/paths";
import type { SessionInfo, Message, Part } from "../session/types";
import { resolveProjectContext } from "../utils/project";

interface SessionSummary {
  id: string;
  agentName: string;
  model: string;
  created: Date;
  isSubAgent: boolean;
  dirPath: string;
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

/**
 * List all sessions from storage
 */
async function listSessions(projectRoot: string): Promise<SessionSummary[]> {
  const sessionDir = await getSessionStorageDir(projectRoot);
  const sessions: SessionSummary[] = [];

  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const parsed = parseSessionDirName(entry.name);
      if (!parsed) continue;

      // Try to read session.json for more details
      const sessionJsonPath = path.join(sessionDir, entry.name, "session.json");
      try {
        const content = await fs.readFile(sessionJsonPath, "utf-8");
        const sessionInfo = JSON.parse(content) as SessionInfo;

        sessions.push({
          id: sessionInfo.id,
          agentName: sessionInfo.agent.name,
          model: sessionInfo.model,
          created: new Date(sessionInfo.time.created),
          isSubAgent: sessionInfo.agent.isSubAgent,
          dirPath: path.join(sessionDir, entry.name),
        });
      } catch {
        // If session.json is missing or invalid, use parsed info
        sessions.push({
          id: parsed.id,
          agentName: parsed.agentName,
          model: "unknown",
          created: new Date(0),
          isSubAgent: false,
          dirPath: path.join(sessionDir, entry.name),
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
    result.session = JSON.parse(sessionContent) as SessionInfo;
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

/**
 * Format model name for display (shorter)
 */
function formatModel(model: string): string {
  // anthropic:claude-sonnet-4-0 -> claude-sonnet-4
  const parts = model.split(":");
  if (parts.length < 2) return model;

  let modelName = parts[1];

  // Remove trailing version numbers like -0, -1
  modelName = modelName.replace(/-\d+$/, "");

  return truncate(modelName, 20);
}

export function createSessionsCommand(): Command {
  const sessionsCmd = new Command("sessions")
    .description("View session logs")
    .argument("[id]", "Session ID to show details (supports partial match)")
    .option("-s, --subagents", "Include subagent sessions")
    .option("-n, --limit <n>", "Limit number of sessions to show", "10")
    .option("-j, --json", "Output as JSON")
    .option("-f, --full", "Show full tool input/output (not truncated)")
    .action(async (sessionId?: string, options?: { subagents?: boolean; limit?: string; json?: boolean; full?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());

      if (sessionId) {
        // Show specific session
        const showOptions: { json?: boolean; full?: boolean } = {};
        if (options?.json) showOptions.json = options.json;
        if (options?.full) showOptions.full = options.full;
        await showSession(projectContext.projectRoot, sessionId, showOptions);
      } else {
        // List sessions
        await listSessionsCommand(projectContext.projectRoot, options);
      }
    });

  // Add explicit list subcommand for clarity
  sessionsCmd
    .command("list")
    .alias("ls")
    .description("List all sessions")
    .option("-s, --subagents", "Include subagent sessions")
    .option("-n, --limit <n>", "Limit number of sessions to show", "10")
    .option("-j, --json", "Output as JSON")
    .action(async (options: { subagents?: boolean; limit?: string; json?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());
      await listSessionsCommand(projectContext.projectRoot, options);
    });

  // Add show subcommand
  sessionsCmd
    .command("show <id>")
    .description("Show session details")
    .option("-j, --json", "Output as JSON")
    .option("-f, --full", "Show full tool input/output (not truncated)")
    .action(async (id: string, options: { json?: boolean; full?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());
      await showSession(projectContext.projectRoot, id, options);
    });

  // Add path subcommand to show storage location
  sessionsCmd
    .command("path")
    .description("Show session storage path")
    .action(async () => {
      const projectContext = resolveProjectContext(process.cwd());
      const projectDir = await getProjectDir(projectContext.projectRoot);
      const sessionDir = await getSessionStorageDir(projectContext.projectRoot);

      process.stdout.write(`Project dir: ${projectDir}\n`);
      process.stdout.write(`Sessions:    ${sessionDir}\n`);
    });

  return sessionsCmd;
}

async function listSessionsCommand(
  projectRoot: string,
  options?: { subagents?: boolean; limit?: string; json?: boolean }
): Promise<void> {
  let sessions = await listSessions(projectRoot);

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
    process.stdout.write("No sessions found\n");
    return;
  }

  if (options?.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    return;
  }

  // Calculate column widths
  const idWidth = 12; // First 12 chars of ULID
  const agentWidth = Math.min(
    20,
    Math.max(...sessions.map((s) => s.agentName.length))
  );
  const modelWidth = 20;

  // Header
  process.stdout.write(
    `${"ID".padEnd(idWidth)}  ${"AGENT".padEnd(agentWidth)}  ${"MODEL".padEnd(modelWidth)}  DATE\n`
  );
  process.stdout.write(`${"-".repeat(idWidth + agentWidth + modelWidth + 20)}\n`);

  // Rows
  for (const session of sessions) {
    const shortId = session.id.substring(0, idWidth);
    const agent = truncate(session.agentName, agentWidth).padEnd(agentWidth);
    const model = formatModel(session.model).padEnd(modelWidth);
    const date = formatDate(session.created);

    process.stdout.write(`${shortId}  ${agent}  ${model}  ${date}\n`);
  }

  // Footer
  if (sessions.length > 0) {
    process.stdout.write(
      `\nShowing ${sessions.length} session(s). Use 'agentuse sessions <id>' for details.\n`
    );
  }
}

async function showSession(
  projectRoot: string,
  sessionId: string,
  options?: { json?: boolean; full?: boolean }
): Promise<void> {
  // Find session by partial ID match
  const sessions = await listSessions(projectRoot);
  const matches = sessions.filter((s) =>
    s.id.toLowerCase().startsWith(sessionId.toLowerCase())
  );

  if (matches.length === 0) {
    process.stderr.write(`No session found matching: ${sessionId}\n`);
    process.exit(1);
  }

  if (matches.length > 1) {
    process.stderr.write(`Multiple sessions match '${sessionId}':\n`);
    for (const m of matches) {
      process.stderr.write(`  ${m.id.substring(0, 12)}  ${m.agentName}\n`);
    }
    process.stderr.write(`\nPlease use a more specific ID.\n`);
    process.exit(1);
  }

  const session = matches[0];
  const details = await getSessionDetails(session.dirPath);

  if (!details.session) {
    process.stderr.write(`Failed to read session: ${sessionId}\n`);
    process.exit(1);
  }

  if (options?.json) {
    process.stdout.write(JSON.stringify(details, null, 2) + "\n");
    return;
  }

  const showFull = options?.full ?? false;

  // Display session info
  const s = details.session;

  process.stdout.write(`\n${"═".repeat(60)}\n`);
  process.stdout.write(`SESSION: ${s.id}\n`);
  process.stdout.write(`${"═".repeat(60)}\n\n`);

  process.stdout.write(`Agent:       ${s.agent.name}\n`);
  if (s.agent.description) {
    process.stdout.write(`Description: ${s.agent.description}\n`);
  }
  if (s.agent.filePath) {
    process.stdout.write(`File:        ${s.agent.filePath}\n`);
  }
  process.stdout.write(`Model:       ${s.model}\n`);
  process.stdout.write(`Started:     ${new Date(s.time.created).toLocaleString()}\n`);

  if (s.config.mcpServers && s.config.mcpServers.length > 0) {
    process.stdout.write(`MCP Servers: ${s.config.mcpServers.join(", ")}\n`);
  }

  process.stdout.write(`\nProject:     ${s.project.root}\n`);
  process.stdout.write(`Working Dir: ${s.project.cwd}\n`);

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

      // Show token usage and duration
      const tokens = message.assistant.tokens;
      const totalTokens = tokens.input + tokens.output;
      let statsLine = `Tokens: ${totalTokens} (in: ${tokens.input}, out: ${tokens.output})`;

      // Add duration if completed timestamp exists
      if (message.time.completed) {
        const durationMs = message.time.completed - message.time.created;
        const durationSec = (durationMs / 1000).toFixed(1);
        statsLine += `  Duration: ${durationSec}s`;
      }
      process.stdout.write(statsLine + "\n");

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
        .filter((p) => p.type === "text" || p.type === "tool")
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
          }
        }
      }
    }
  }

  process.stdout.write(`\n`);
}
