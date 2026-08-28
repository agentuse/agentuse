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
});
