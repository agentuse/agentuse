import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { CloudConnector, cloudSettingsState, parseConnectCode, parseJoinLink } from "./cloud-settings";
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

  it("reads the join code from a setup page link and nothing else", () => {
    expect(parseJoinLink("agentuse://join?code=bcdf-ghjk-lmnp")).toBe("BCDF-GHJK-LMNP");
    expect(parseJoinLink("agentuse:join?code=BCDF-GHJK-LMNP")).toBe("BCDF-GHJK-LMNP");
    expect(parseJoinLink("agentuse://join?code=BCDF-GHJK")).toBeUndefined();
    expect(parseJoinLink("agentuse://join?code=AAAA-GHJK-LMNP")).toBeUndefined();
    expect(parseJoinLink("agentuse://open?code=BCDF-GHJK-LMNP")).toBeUndefined();
    expect(parseJoinLink("https://join?code=BCDF-GHJK-LMNP")).toBeUndefined();
    expect(parseJoinLink("not a url")).toBeUndefined();
  });

  it("joins with the code and shows Connecting instead of a browser step", () => {
    const calls: string[][] = [];
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill() {} });
    const connector = new CloudConnector((args) => { calls.push(args); return child as never; }, () => {});
    connector.connect("BCDF-GHJK-LMNP");
    expect(calls).toEqual([["connect", "--join", "BCDF-GHJK-LMNP"]]);
    expect(cloudSettingsState(connector.view)).toMatchObject({ cloudStatus: "connecting", cloudTitle: "Connecting…", cloudActionLabel: "Cancel" });
    child.emit("exit", 0, null);
    expect(connector.view.connecting).toBeUndefined();
  });
});
