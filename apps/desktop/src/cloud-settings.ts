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
  connecting?: { code?: string; joining?: boolean };
  busy?: boolean;
  error?: string;
}): CloudSettingsState {
  const account = input.api?.account ?? input.saved?.account;
  const computer = input.api?.name ?? input.saved?.name;
  const mcpUrl = input.api?.mcpUrl ?? input.saved?.mcpUrl;
  const details = { ...(account && { cloudAccount: account }), ...(computer && { cloudComputer: computer }), ...(mcpUrl && { cloudMcpUrl: mcpUrl }) };

  if (input.connecting?.joining) {
    return {
      cloudStatus: "connecting",
      cloudTitle: "Connecting…",
      cloudDetail: "Linking this Mac to your account with the code from the setup page.",
      cloudActionLabel: "Cancel",
      cloudActionDisabled: false,
    };
  }
  if (input.connecting) {
    return {
      cloudStatus: "connecting",
      cloudTitle: "Finish in your browser",
      cloudDetail: input.connecting.code
        ? `Sign in and press Connect. The page shows the code ${input.connecting.code}.`
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

const JOIN_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;

/**
 * The join code in a link from the Cloud setup page
 * (`agentuse://join?code=BCDF-GHJK-LMNP`), or undefined for anything else.
 */
export function parseJoinLink(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "agentuse:") return undefined;
  // `agentuse://join?…` puts "join" in the host; `agentuse:join?…` in the path.
  if ((parsed.host || parsed.pathname.replace(/^\/+/u, "")) !== "join") return undefined;
  const code = parsed.searchParams.get("code")?.trim().toUpperCase();
  return code && JOIN_CODE.test(code) ? code : undefined;
}

const SETTLE_REFRESH_MS = [300, 800, 1_500, 3_000];

/** Runs `agentuse connect` / `agentuse disconnect` and tracks the one in flight. */
export class CloudConnector {
  private child: ChildProcess | undefined;
  private code: string | undefined;
  private joining = false;
  private lastError: string | undefined;
  private busy = false;

  constructor(
    private readonly runCli: (args: string[]) => ChildProcess,
    private readonly onChange: () => void,
  ) {}

  get view(): { connecting?: { code?: string; joining?: boolean }; busy: boolean; error?: string } {
    return {
      ...(this.child && { connecting: this.joining ? { joining: true } : this.code ? { code: this.code } : {} }),
      busy: this.busy,
      ...(this.lastError && { error: this.lastError }),
    };
  }

  /** With a join code from the setup page, links without a browser step. */
  connect(joinCode?: string): void {
    if (this.child) return;
    this.lastError = undefined;
    this.code = undefined;
    this.joining = joinCode !== undefined;
    const child = this.runCli(joinCode ? ["connect", "--join", joinCode] : ["connect"]);
    this.child = child;
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const code = parseConnectCode(output);
      if (code && code !== this.code) {
        this.code = code;
        this.onChange();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("exit", (exitCode, signal) => {
      this.child = undefined;
      this.code = undefined;
      this.joining = false;
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
