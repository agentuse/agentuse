import { describe, expect, it } from "bun:test";
import { bundledCliCommand } from "./bundled-cli";

describe("Desktop bundled CLI command", () => {
  it("quotes the app executable and packaged CLI entry for a shell handoff", () => {
    expect(bundledCliCommand(
      "/Users/Example User/Applications/AgentUse.app/Contents/MacOS/AgentUse",
      "/Users/Example User/Applications/AgentUse.app/Contents/Resources/app.asar/node_modules/agentuse/bin/cli.js",
    )).toBe(
      "env ELECTRON_RUN_AS_NODE=1 '/Users/Example User/Applications/AgentUse.app/Contents/MacOS/AgentUse' '/Users/Example User/Applications/AgentUse.app/Contents/Resources/app.asar/node_modules/agentuse/bin/cli.js'",
    );
  });

  it("escapes single quotes in paths", () => {
    expect(bundledCliCommand("/Applications/AgentUse's.app/AgentUse", "/tmp/cli's.js"))
      .toBe("env ELECTRON_RUN_AS_NODE=1 '/Applications/AgentUse'\"'\"'s.app/AgentUse' '/tmp/cli'\"'\"'s.js'");
  });

  it("carries only the non-secret paths that select the Desktop runtime profile", () => {
    expect(bundledCliCommand("/Applications/AgentUse.app/AgentUse", "/tmp/cli.js", {
      HOME: "/tmp/Fresh User/home",
      XDG_DATA_HOME: "/tmp/Fresh User/data",
      AGENTUSE_CONFIG: "/tmp/Fresh User/config.json",
      OPENAI_API_KEY: "must-not-appear",
    })).toBe(
      "env HOME='/tmp/Fresh User/home' XDG_DATA_HOME='/tmp/Fresh User/data' AGENTUSE_CONFIG='/tmp/Fresh User/config.json' ELECTRON_RUN_AS_NODE=1 '/Applications/AgentUse.app/AgentUse' '/tmp/cli.js'",
    );
  });
});
