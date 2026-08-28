import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export type CliLinkStatus = "installed" | "external" | "notInstalled" | "conflict" | "unavailable";

export interface CliLinkState {
  status: CliLinkStatus;
  title: string;
  detail: string;
  actionLabel: "Install" | "Remove";
  actionDisabled: boolean;
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
  const resolvedCommands = new Set<string>();
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(resolve(directory), "agentuse");
    try {
      accessSync(candidate, constants.X_OK);
      const resolvedCandidate = realpathSync(candidate);
      if (resolvedCommands.has(resolvedCandidate)) continue;
      resolvedCommands.add(resolvedCandidate);
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
      title: "Command line tool unavailable",
      detail: "Reinstall AgentUse to restore the bundled command line tool.",
      actionLabel: "Install",
      actionDisabled: true,
    };
  }

  try {
    const entry = lstatSync(linkPath);
    if (entry.isSymbolicLink() && resolvedLinkTarget(linkPath) === resolve(launcherPath)) {
      return {
        status: "installed",
        title: "Command line tool installed",
        detail: `agentuse is linked at ${linkPath}`,
        actionLabel: "Remove",
        actionDisabled: false,
      };
    }
    return {
      status: "conflict",
      title: "Another command already exists",
      detail: `${linkPath} is not managed by this app.`,
      actionLabel: "Install",
      actionDisabled: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        status: "unavailable",
        title: "Command line tool status unavailable",
        detail: `AgentUse could not inspect ${linkPath}`,
        actionLabel: "Install",
        actionDisabled: true,
      };
    }
  }

  return {
    status: "notInstalled",
    title: "Command line tool not installed",
    detail: `Add agentuse to ${dirname(linkPath)}`,
    actionLabel: "Install",
    actionDisabled: false,
  };
}

export function inspectCliAvailability(
  linkPath: string,
  launcherPath: string,
  pathValue: string,
): CliLinkState {
  const link = inspectCliLink(linkPath, launcherPath);
  const commands = findCliExecutables(pathValue);
  const firstCommand = commands[0];
  const managedLinkIsFirst = link.status === "installed" && firstCommand === resolve(linkPath);

  if (managedLinkIsFirst) {
    const otherCount = commands.length - 1;
    return {
      ...link,
      detail: otherCount > 0
        ? `Using ${linkPath}; ${otherCount} other installation${otherCount === 1 ? "" : "s"} also found.`
        : link.detail,
    };
  }

  if (link.status === "installed") {
    return {
      ...link,
      title: firstCommand ? "Another command line tool takes priority" : "Command line tool is not on PATH",
      detail: firstCommand
        ? `Using ${firstCommand}; the app link remains at ${linkPath}.`
        : `Linked at ${linkPath}, but that directory is not on your PATH.`,
    };
  }

  if (firstCommand) {
    const otherCount = commands.length - 1;
    return {
      status: "external",
      title: "Command line tool already installed",
      detail: otherCount > 0
        ? `Using ${firstCommand}; ${otherCount} other installation${otherCount === 1 ? "" : "s"} also found.`
        : `Using ${firstCommand}`,
      actionLabel: "Install",
      actionDisabled: true,
    };
  }

  return link;
}

export async function toggleCliLink(
  linkPath: string,
  launcherPath: string,
  pathValue = process.env.PATH ?? "",
): Promise<CliLinkState> {
  const current = inspectCliAvailability(linkPath, launcherPath, pathValue);
  if (current.status === "installed") {
    await unlink(linkPath);
  } else if (current.status === "notInstalled") {
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(launcherPath, linkPath);
  }
  return inspectCliAvailability(linkPath, launcherPath, pathValue);
}
