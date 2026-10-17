import { describe, expect, it } from "bun:test";
import { connectPageUrl, isSetupApiKeyProvider, setupAiState, setupCloudState } from "./setup-wizard";

const saved = { account: "leon@example.com", name: "Leon's Mac", mcpUrl: "https://cloud.agentuse.io/mcp" };

describe("first-run setup", () => {
  it("shows the pairing code while the browser step runs", () => {
    expect(setupCloudState({ connecting: { code: "BCDF-GHJK" } })).toEqual({ status: "connecting", code: "BCDF-GHJK" });
  });

  it("counts a saved connection as signed in unless the account page removed it", () => {
    expect(setupCloudState({ saved })).toEqual({ status: "connected", account: saved.account, mcpUrl: saved.mcpUrl });
    expect(setupCloudState({ saved, api: { status: "disconnected from the cloud" } })).toEqual({ status: "none" });
    expect(setupCloudState({ error: "Code expired" })).toEqual({ status: "none", error: "Code expired" });
  });

  it("names the AI that will run agents", () => {
    const openai = { id: "openai", name: "OpenAI", configured: true, sources: [{ priority: 1 as const, kind: "oauth" as const, name: "ChatGPT", stored: true, active: true }] };
    const anthropic = { id: "anthropic", name: "Anthropic", configured: true, sources: [{ priority: 2 as const, kind: "api_key" as const, name: "API key", stored: true, active: true }] };
    expect(setupAiState({ providers: [openai], customProviders: [] })).toEqual({ ready: true, label: "your ChatGPT plan" });
    expect(setupAiState({ providers: [{ ...openai, configured: false }, anthropic], customProviders: [] })).toEqual({ ready: true, label: "Anthropic" });
    expect(setupAiState({ providers: [], customProviders: [] })).toEqual({ ready: false });
  });

  it("builds the links and commands the page offers", () => {
    expect(connectPageUrl("https://cloud.agentuse.io/")).toBe("https://cloud.agentuse.io/connect");
    expect(isSetupApiKeyProvider("openrouter")).toBe(true);
    expect(isSetupApiKeyProvider("ollama")).toBe(false);
  });
});
