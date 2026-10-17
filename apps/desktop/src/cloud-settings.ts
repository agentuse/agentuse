import type { ChildProcess } from "node:child_process";

/**
 * The Settings tab "AgentUse Cloud". Connecting runs the bundled CLI's own
 * `agentuse connect` (which opens the browser), so the app and the terminal
 * share one flow and one connection file; the tab only shows its progress.
 */

export interface CloudApiState {
  status: string;
  lastError?: string;
  account?: string;
  name?: string;
  mcpUrl?: string;
}

export interface CloudSettingsState {
  cloudStatus: "notConnected" | "connecting" | "connected" | "reconnecting" | "disconnected" | "serverStopped";
  cloudTitle: string;
  cloudDetail: string;
  cloudCode?: string;
  cloudAccount?: string;
  cloudComputer?: string;
  cloudMcpUrl?: string;
  cloudActionLabel: "Connect" | "Cancel" | "Disconnect";
  cloudActionDisabled: boolean;
}

const MCP_APPS = "Claude, ChatGPT, Cursor, or any app that supports MCP";

export function cloudSettingsState(input: {
  /** From the running server's /api/cloud; undefined when no server answers. */
  api?: CloudApiState;
  /** From ~/.agentuse/cloud.json, for when the server is stopped. */
  saved?: { account?: string; name: string; mcpUrl: string };
  connecting?: { code?: string };
  busy?: boolean;
  error?: string;
}): CloudSettingsState {
  const account = input.api?.account ?? input.saved?.account;
  const computer = input.api?.name ?? input.saved?.name;
  const mcpUrl = input.api?.mcpUrl ?? input.saved?.mcpUrl;
  const details = { ...(account && { cloudAccount: account }), ...(computer && { cloudComputer: computer }), ...(mcpUrl && { cloudMcpUrl: mcpUrl }) };

  if (input.connecting) {
    return {
      cloudStatus: "connecting",
      cloudTitle: "Finish in your browser",
      cloudDetail: input.connecting.code
        ? `We copied the code ${input.connecting.code}. Sign in on the page that opened and paste it.`
        : "Opening AgentUse Cloud in your browser…",
      ...(input.connecting.code && { cloudCode: input.connecting.code }),
      cloudActionLabel: "Cancel",
      cloudActionDisabled: false,
    };
  }
  if (!account && !computer) {
    return {
      cloudStatus: "notConnected",
      cloudTitle: "Not connected",
      cloudDetail: input.error ?? `Use AgentUse from ${MCP_APPS}. Your agents keep running on this Mac.`,
      cloudActionLabel: "Connect",
      cloudActionDisabled: input.busy ?? false,
    };
  }
  if (!input.api) {
    return {
      cloudStatus: "serverStopped",
      cloudTitle: "Connected, server stopped",
      cloudDetail: "Start the server so apps can reach AgentUse on this Mac.",
      ...details,
      cloudActionLabel: "Disconnect",
      cloudActionDisabled: input.busy ?? false,
    };
  }
  const live = input.api.status;
  return {
    cloudStatus: live === "connected" ? "connected" : live === "disconnected from the cloud" ? "disconnected" : "reconnecting",
    cloudTitle: live === "connected" ? "Connected" : live === "disconnected from the cloud" ? "Disconnected from your account" : "Reconnecting…",
    cloudDetail: live === "connected"
      ? `${MCP_APPS} can use AgentUse on this Mac.`
      : input.api.lastError ?? "Trying to reach AgentUse Cloud.",
    ...details,
    cloudActionLabel: "Disconnect",
    cloudActionDisabled: input.busy ?? false,
  };
}

/** The pairing code `agentuse connect` prints ("…and enter BCDF-GHJK"). */
export function parseConnectCode(output: string): string | undefined {
  return output.match(/enter\s+(?:\u001b\[[0-9;]*m)*([B-Z]{4}-[B-Z]{4})/u)?.[1];
}

const SETTLE_REFRESH_MS = [300, 800, 1_500, 3_000];

/** Runs `agentuse connect` / `agentuse disconnect` and tracks the one in flight. */
export class CloudConnector {
  private child: ChildProcess | undefined;
  private code: string | undefined;
  private lastError: string | undefined;
  private busy = false;

  constructor(
    private readonly runCli: (args: string[]) => ChildProcess,
    private readonly onChange: () => void,
    /** A new pairing code, for the app to put on the clipboard. */
    private readonly onCode: (code: string) => void = () => {},
  ) {}

  get view(): { connecting?: { code?: string }; busy: boolean; error?: string } {
    return {
      ...(this.child && { connecting: this.code ? { code: this.code } : {} }),
      busy: this.busy,
      ...(this.lastError && { error: this.lastError }),
    };
  }

  connect(): void {
    if (this.child) return;
    this.lastError = undefined;
    this.code = undefined;
    const child = this.runCli(["connect"]);
    this.child = child;
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const code = parseConnectCode(output);
      if (code && code !== this.code) {
        this.code = code;
        this.onCode(code);
        this.onChange();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("exit", (exitCode, signal) => {
      this.child = undefined;
      this.code = undefined;
      if (exitCode !== 0 && signal !== "SIGTERM") {
        this.lastError = output.trim().split("\n").filter(Boolean).at(-1) ?? "Connecting did not finish.";
      }
      this.onChange();
      // The server switches to the new connection within a second or so; look
      // again a few times so the tab turns green then, not at the next poll.
      if (exitCode === 0) {
        for (const ms of SETTLE_REFRESH_MS) setTimeout(this.onChange, ms).unref?.();
      }
    });
    this.onChange();
  }

  cancel(): void {
    this.child?.kill("SIGTERM");
  }

  async disconnect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.onChange();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = this.runCli(["disconnect"]);
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(output.trim() || "Could not disconnect."))));
      });
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
}
