import { contextBridge, ipcRenderer } from "electron";
import type { SetupAiState, SetupApiKeyProvider, SetupCloudState } from "./setup-wizard";

export interface DesktopSetupState {
  cloud: SetupCloudState;
  ai: SetupAiState;
  /** Where to type the code by hand, e.g. cloud.agentuse.io/connect. */
  connectPage: string;
}

export interface DesktopSetupReady {
  project: string;
  dashboardUrl: string;
  mcpCommand: string;
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
  prepareReady: (): Promise<DesktopSetupReady> => ipcRenderer.invoke("agentuse:setup:prepare-ready"),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("agentuse:setup:copy", text),
  openHelp: (): Promise<void> => ipcRenderer.invoke("agentuse:setup:open-help"),
  complete: (route: "cloud" | "local", openDashboard: boolean): Promise<void> => ipcRenderer.invoke("agentuse:setup:complete", route, openDashboard),
}));
