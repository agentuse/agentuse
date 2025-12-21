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
    .option("-a, --all", "Show all sessions including subagents")
    .option("-n, --limit <n>", "Limit number of sessions to show", "10")
    .option("-j, --json", "Output as JSON")
    .action(async (sessionId?: string, options?: { all?: boolean; limit?: string; json?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());

      if (sessionId) {
        // Show specific session
        await showSession(projectContext.projectRoot, sessionId, options?.json);
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
    .option("-a, --all", "Show all sessions including subagents")
    .option("-n, --limit <n>", "Limit number of sessions to show", "10")
    .option("-j, --json", "Output as JSON")
    .action(async (options: { all?: boolean; limit?: string; json?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());
      await listSessionsCommand(projectContext.projectRoot, options);
    });

  // Add show subcommand
  sessionsCmd
    .command("show <id>")
    .description("Show session details")
    .option("-j, --json", "Output as JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());
      await showSession(projectContext.projectRoot, id, options?.json);
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
  options?: { all?: boolean; limit?: string; json?: boolean }
): Promise<void> {
  let sessions = await listSessions(projectRoot);

  // Filter out subagents unless --all is specified
  if (!options?.all) {
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
  json?: boolean
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

  if (json) {
    process.stdout.write(JSON.stringify(details, null, 2) + "\n");
    return;
  }

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
  process.stdout.write(`Created:     ${new Date(s.time.created).toLocaleString()}\n`);
  process.stdout.write(`Updated:     ${new Date(s.time.updated).toLocaleString()}\n`);

  if (s.config.timeout) {
    process.stdout.write(`Timeout:     ${s.config.timeout}s\n`);
  }
  if (s.config.maxSteps) {
    process.stdout.write(`Max Steps:   ${s.config.maxSteps}\n`);
  }
  if (s.config.mcpServers && s.config.mcpServers.length > 0) {
    process.stdout.write(`MCP Servers: ${s.config.mcpServers.join(", ")}\n`);
  }

  process.stdout.write(`\nProject:     ${s.project.root}\n`);
  process.stdout.write(`Working Dir: ${s.project.cwd}\n`);

  // Display messages
  if (details.messages.length > 0) {
    process.stdout.write(`\n${"─".repeat(60)}\n`);
    process.stdout.write(`MESSAGES (${details.messages.length})\n`);
    process.stdout.write(`${"─".repeat(60)}\n`);

    for (const { message, parts } of details.messages) {
      process.stdout.write(`\n[Message ${message.id.substring(0, 8)}]\n`);

      // Show user prompt (first line only for task, full for user input)
      const taskFirstLine = message.user.prompt.task.split("\n")[0];
      process.stdout.write(`  Task: ${truncate(taskFirstLine, 80)}\n`);
      if (message.user.prompt.user) {
        process.stdout.write(`  User: ${message.user.prompt.user}\n`);
      }

      // Show token usage
      const tokens = message.assistant.tokens;
      const totalTokens = tokens.input + tokens.output;
      process.stdout.write(
        `  Tokens: ${totalTokens} (in: ${tokens.input}, out: ${tokens.output})\n`
      );

      // Count parts by type
      const partCounts: Record<string, number> = {};
      for (const part of parts) {
        partCounts[part.type] = (partCounts[part.type] || 0) + 1;
      }

      if (Object.keys(partCounts).length > 0) {
        const partSummary = Object.entries(partCounts)
          .map(([type, count]) => `${type}: ${count}`)
          .join(", ");
        process.stdout.write(`  Parts: ${partSummary}\n`);
      }

      // Show tool calls
      const toolParts = parts.filter((p) => p.type === "tool") as Array<
        Part & { type: "tool"; tool: string; state: { status: string } }
      >;
      if (toolParts.length > 0) {
        process.stdout.write(`  Tools:\n`);
        for (const tool of toolParts.slice(0, 10)) {
          const status =
            tool.state.status === "completed"
              ? "✓"
              : tool.state.status === "error"
                ? "✗"
                : "…";
          process.stdout.write(`    ${status} ${tool.tool}\n`);
        }
        if (toolParts.length > 10) {
          process.stdout.write(`    ... and ${toolParts.length - 10} more\n`);
        }
      }

      // Show text output (if any)
      const textParts = parts.filter((p) => p.type === "text") as Array<
        Part & { type: "text"; text: string }
      >;
      if (textParts.length > 0) {
        const fullText = textParts.map((p) => p.text).join("\n");
        if (fullText.trim()) {
          process.stdout.write(`\n  Output:\n`);
          // Indent each line of output
          const indented = fullText
            .trim()
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n");
          process.stdout.write(`${indented}\n`);
        }
      }
    }
  }

  process.stdout.write(`\n`);
}
