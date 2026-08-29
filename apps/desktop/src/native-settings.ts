export interface DesktopSettingsState {
  status: "running" | "stopped" | "starting" | "stopping";
  title: string;
  detail: string;
  actionLabel: "Start Server" | "Stop Server";
  actionDisabled: boolean;
  launchAtLogin: boolean;
  cliStatus: "installed" | "notInstalled" | "conflict" | "unavailable";
  cliTitle: string;
  cliDetail: string;
  cliActionLabel: "Add" | "Replace" | "Remove";
  cliActionDisabled: boolean;
  cliCommands: string[];
  logText: string;
  logFile?: string;
}

export type NativeSettingsCommand =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "toggleServer" }
  | { type: "toggleCliLink" }
  | { type: "setLaunchAtLogin"; enabled: boolean };

export type NativeSettingsMessage =
  | { type: "state"; state: DesktopSettingsState }
  | { type: "error"; message: string }
  | { type: "show" }
  | { type: "hide" }
  | { type: "quit" };

export function parseNativeSettingsCommand(line: string): NativeSettingsCommand | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return undefined;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "ready":
    case "refresh":
    case "toggleServer":
    case "toggleCliLink":
      return { type: command.type };
    case "setLaunchAtLogin":
      return typeof command.enabled === "boolean"
        ? { type: command.type, enabled: command.enabled }
        : undefined;
    default:
      return undefined;
  }
}

export function encodeNativeSettingsMessage(message: NativeSettingsMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function isNativeSettingsPipeClosure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}
