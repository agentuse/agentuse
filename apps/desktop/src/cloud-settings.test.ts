import { describe, expect, it } from "bun:test";
import { cloudSettingsState, parseConnectCode } from "./cloud-settings";
import { parseNativeSettingsCommand } from "./native-settings";

describe("AgentUse Cloud settings", () => {
  it("offers Connect when this Mac is not connected", () => {
    expect(cloudSettingsState({})).toMatchObject({ cloudStatus: "notConnected", cloudActionLabel: "Connect", cloudActionDisabled: false });
  });

  it("shows the code and Cancel while waiting for the browser", () => {
    expect(cloudSettingsState({ connecting: { code: "BCDF-GHJK" } })).toMatchObject({
      cloudStatus: "connecting",
      cloudCode: "BCDF-GHJK",
      cloudActionLabel: "Cancel",
    });
  });

  it("shows the account, this Mac and the MCP address once connected", () => {
    const state = cloudSettingsState({
      api: { status: "connected", account: "you@example.com", name: "MacBook Pro", mcpUrl: "https://cloud.agentuse.io/mcp" },
    });
    expect(state).toMatchObject({
      cloudStatus: "connected",
      cloudAccount: "you@example.com",
      cloudComputer: "MacBook Pro",
      cloudMcpUrl: "https://cloud.agentuse.io/mcp",
      cloudActionLabel: "Disconnect",
    });
  });

  it("says the server is stopped when only the saved connection is known", () => {
    expect(cloudSettingsState({ saved: { name: "MacBook Pro", mcpUrl: "https://cloud.agentuse.io/mcp" } }).cloudStatus).toBe("serverStopped");
  });

  it("passes on why the cloud dropped this Mac", () => {
    const state = cloudSettingsState({
      api: { status: "disconnected from the cloud", lastError: "Run agentuse connect", name: "MacBook Pro", mcpUrl: "u" },
    });
    expect(state).toMatchObject({ cloudStatus: "disconnected", cloudDetail: "Run agentuse connect" });
  });

  it("reads the code from the CLI output, colours included", () => {
    expect(parseConnectCode("Open https://cloud.agentuse.io/connect and enter \u001b[1mBCDF-GHJK\u001b[22m")).toBe("BCDF-GHJK");
    expect(parseConnectCode("Waiting…")).toBeUndefined();
  });

  it("accepts the toggleCloud command from the settings helper", () => {
    expect(parseNativeSettingsCommand('{"type":"toggleCloud"}')).toEqual({ type: "toggleCloud" });
  });
});
