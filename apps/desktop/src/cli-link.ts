import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export type CliLinkStatus = "installed" | "notInstalled" | "conflict" | "unavailable";

export interface CliLinkState {
  status: CliLinkStatus;
  title: string;
  detail: string;
  actionLabel: "Add" | "Replace" | "Remove";
  actionDisabled: boolean;
}

export interface CliAvailabilityState extends CliLinkState {
  /** Executable paths in the same order the login shell resolves them. */
  commands: string[];
}

export function defaultCliLinkPath(): string {
  return join(homedir(), ".local", "bin", "agentuse");
}

export function packagedCliLauncherPath(resourcesPath: string): string {
  return join(resourcesPath, "bin", "agentuse");
}

export function loginShellPath(
  shell = process.env.SHELL,
  fallback = process.env.PATH ?? "",
): Promise<string> {
  if (!shell) return Promise.resolve(fallback);
  const marker = "__AGENTUSE_LOGIN_PATH__";
  return new Promise((complete) => {
    execFile(
      shell,
      ["-ilc", `printf '\\n${marker}%s\\n' "$PATH"`],
      { timeout: 3_000, maxBuffer: 512_000 },
      (_error, stdout) => {
        const markedPath = stdout.slice(stdout.lastIndexOf(marker) + marker.length).split("\n")[0];
        complete(stdout.includes(marker) && markedPath ? markedPath : fallback);
      },
    );
  });
}

export function findCliExecutables(pathValue: string): string[] {
  const commands: string[] = [];
  const seenCommands = new Set<string>();
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(resolve(directory), "agentuse");
    if (seenCommands.has(candidate)) continue;
    seenCommands.add(candidate);
    try {
      accessSync(candidate, constants.X_OK);
      commands.push(candidate);
    } catch {
      // Missing and non-executable entries are not commands the shell can use.
    }
  }
  return commands;
}

function resolvedLinkTarget(linkPath: string): string | undefined {
  try {
    const target = readlinkSync(linkPath);
    return resolve(dirname(linkPath), target);
  } catch {
    return undefined;
  }
}

export function inspectCliLink(linkPath: string, launcherPath: string): CliLinkState {
  if (!existsSync(launcherPath)) {
    return {
      status: "unavailable",
      title: "Add CLI launcher",
      detail: "Reinstall AgentUse to restore the bundled command line tool.",
      actionLabel: "Add",
      actionDisabled: true,
    };
  }

  try {
    const entry = lstatSync(linkPath);
    if (entry.isSymbolicLink() && resolvedLinkTarget(linkPath) === resolve(launcherPath)) {
      return {
        status: "installed",
        title: "Add CLI launcher",
        detail: `Available at ${linkPath}.`,
        actionLabel: "Remove",
        actionDisabled: false,
      };
    }
    const replaceable = entry.isFile() || entry.isSymbolicLink();
    return {
      status: "conflict",
      title: "Add CLI launcher",
      detail: replaceable
        ? `Replace the existing command at ${linkPath} with the bundled CLI.`
        : `${linkPath} exists but is not a replaceable file.`,
      actionLabel: "Replace",
      actionDisabled: !replaceable,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        status: "unavailable",
        title: "Add CLI launcher",
        detail: `AgentUse could not inspect ${linkPath}`,
        actionLabel: "Add",
        actionDisabled: true,
      };
    }
  }

  return {
    status: "notInstalled",
    title: "Add CLI launcher",
    detail: `Creates an agentuse command for Terminal at ${linkPath}.`,
    actionLabel: "Add",
    actionDisabled: false,
  };
}

export function inspectCliAvailability(
  linkPath: string,
  launcherPath: string,
  pathValue: string,
): CliAvailabilityState {
  const link = inspectCliLink(linkPath, launcherPath);
  const commands = findCliExecutables(pathValue);
  const firstCommand = commands[0];
  const managedLinkIsFirst = link.status === "installed" && firstCommand === resolve(linkPath);

  if (managedLinkIsFirst) {
    const otherCount = commands.length - 1;
    return {
      ...link,
      commands,
      detail: otherCount > 0
        ? `Available at ${linkPath}; ${otherCount} other command${otherCount === 1 ? "" : "s"} also found on PATH.`
        : link.detail,
    };
  }

  if (link.status === "installed") {
    return {
      ...link,
      commands,
      detail: firstCommand
        ? `Added at ${linkPath}, but ${firstCommand} runs first.`
        : `Added at ${linkPath}, but ~/.local/bin is not on your PATH.`,
    };
  }

  return { ...link, commands };
}

export async function toggleCliLink(
  linkPath: string,
  launcherPath: string,
  pathValue = process.env.PATH ?? "",
): Promise<CliAvailabilityState> {
  const current = inspectCliAvailability(linkPath, launcherPath, pathValue);
  if (current.status === "installed") {
    await unlink(linkPath);
  } else if (current.status === "notInstalled") {
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(launcherPath, linkPath);
  } else if (current.status === "conflict" && !current.actionDisabled) {
    await mkdir(dirname(linkPath), { recursive: true });
    const replacement = join(dirname(linkPath), `.agentuse-link-${process.pid}-${Date.now()}`);
    await symlink(launcherPath, replacement);
    try {
      await rename(replacement, linkPath);
    } catch (error) {
      await unlink(replacement).catch(() => {});
      throw error;
    }
  }
  return inspectCliAvailability(linkPath, launcherPath, pathValue);
}
