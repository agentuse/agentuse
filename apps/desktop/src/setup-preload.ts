import { contextBridge, ipcRenderer } from "electron";
import type { CodingAgentStatus } from "../../../src/onboarding/coding-agents";
import type { LocalModelServer, SetupAiState, SetupApiKeyProvider, SetupCloudState } from "./setup-wizard";

export interface DesktopSetupState {
  cloud: SetupCloudState;
  ai: SetupAiState;
  /** Where to type the code by hand, e.g. cloud.agentuse.io/connect. */
  connectPage: string;
}

export interface DesktopSetupReady {
  project: string;
  dashboardUrl: string;
  /** This Mac's MCP address, for apps AgentUse cannot set up itself. */
  mcpUrl: string;
}

contextBridge.exposeInMainWorld("agentuseSetup", Object.freeze({
  getState: (): Promise<DesktopSetupState> => ipcRenderer.invoke("agentuse:setup:get-state"),
  onChange: (listener: () => void): void => {
    ipcRenderer.on("agentuse:setup:changed", () => listener());
  },
  connectCloud: (): Promise<void> => ipcRenderer.invoke("agentuse:setup:connect-cloud"),
  cancelCloud: (): Promise<void> => ipcRenderer.invoke("agentuse:setup:cancel-cloud"),
  openConnectPage: (): Promise<void> => ipcRenderer.invoke("agentuse:setup:open-connect-page"),
  startChatGpt: (): Promise<void> => ipcRenderer.invoke("agentuse:setup:start-chatgpt"),
  finishChatGpt: (address: string): Promise<SetupAiState> => ipcRenderer.invoke("agentuse:setup:finish-chatgpt", address),
  saveApiKey: (provider: SetupApiKeyProvider, key: string): Promise<SetupAiState> => ipcRenderer.invoke("agentuse:setup:save-api-key", provider, key),
  localModels: (): Promise<LocalModelServer[]> => ipcRenderer.invoke("agentuse:setup:local-models"),
  saveCustomProvider: (input: { baseURL: string; model?: string; key?: string; name?: string }): Promise<SetupAiState> => ipcRenderer.invoke("agentuse:setup:save-custom-provider", input),
  chooseProjectFolder: (): Promise<{ path: string; display: string } | null> => ipcRenderer.invoke("agentuse:setup:choose-project-folder"),
  useProject: (choice: { kind: "new" } | { kind: "existing"; path: string }): Promise<{ project: string }> => ipcRenderer.invoke("agentuse:setup:use-project", choice),
  prepareReady: (): Promise<DesktopSetupReady> => ipcRenderer.invoke("agentuse:setup:prepare-ready"),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("agentuse:setup:copy", text),
  codingAgents: (): Promise<CodingAgentStatus[]> => ipcRenderer.invoke("agentuse:setup:coding-agents"),
  setUpAgent: (id: string): Promise<CodingAgentStatus[]> => ipcRenderer.invoke("agentuse:setup:set-up-agent", id),
  openHelp: (): Promise<void> => ipcRenderer.invoke("agentuse:setup:open-help"),
  complete: (route: "cloud" | "local", openDashboard: boolean): Promise<void> => ipcRenderer.invoke("agentuse:setup:complete", route, openDashboard),
}));
