import { describe, expect, it } from "bun:test";
import { connectPageUrl, customProviderName, detectLocalModels, isSetupApiKeyProvider, setupAiState, setupCloudState } from "./setup-wizard";

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

describe("a model on this Mac or another provider", () => {
  it("counts a keyless custom provider as ready, named by its model", () => {
    const ollama = { id: "ollama", baseURL: "http://127.0.0.1:11434/v1", hasApiKey: false, models: ["qwen2.5-coder:14b"] };
    expect(setupAiState({ providers: [], customProviders: [ollama] })).toEqual({ ready: true, label: "qwen2.5-coder:14b on Ollama" });
    expect(setupAiState({ providers: [], customProviders: [{ ...ollama, models: [] }] })).toEqual({ ready: false });
    expect(setupAiState({ providers: [], customProviders: [{ id: "together", baseURL: "https://api.together.xyz/v1", hasApiKey: true }] })).toEqual({ ready: true, label: "together" });
  });

  it("lists the chat models Ollama and LM Studio have", async () => {
    const answers: Record<string, unknown> = {
      "http://127.0.0.1:11434/v1/models": { data: [{ id: "qwen2.5-coder:14b" }, { id: "nomic-embed-text" }] },
      "http://127.0.0.1:11434/api/tags": { models: [{ name: "qwen2.5-coder:14b", size: 9_000_000_000 }] },
    };
    const fake = async (url: string) => {
      if (!(url in answers)) throw new Error("connection refused");
      return { ok: true, json: async () => answers[url] };
    };
    expect(await detectLocalModels(fake)).toEqual([
      { id: "ollama", name: "Ollama", baseURL: "http://127.0.0.1:11434/v1", models: [{ id: "qwen2.5-coder:14b", size: 9_000_000_000 }] },
    ]);
  });

  it("names a typed-in provider after its app or host", () => {
    expect(customProviderName("http://localhost:1234/v1")).toBe("lmstudio");
    expect(customProviderName("http://127.0.0.1:11434/v1")).toBe("ollama");
    expect(customProviderName("http://localhost:8080/v1")).toBe("local");
    expect(customProviderName("https://api.together.xyz/v1")).toBe("together");
    expect(customProviderName("https://api.openai.com/v1")).toBe("openai-custom");
    expect(() => customProviderName("not a url")).toThrow();
  });
});
