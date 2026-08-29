import { contextBridge, ipcRenderer } from "electron";
import type { ProviderStatus } from "../../../src/auth/provider-status";

export interface AgentUseDesktopContext {
  surface: "desktop";
  cliCommand: string;
  serveAlreadyRunning: true;
  getProviderStatus: () => Promise<ProviderStatus>;
  openSettings: () => Promise<void>;
}

const context = ipcRenderer.sendSync("agentuse:desktop-context") as Omit<AgentUseDesktopContext, "getProviderStatus" | "openSettings">;
contextBridge.exposeInMainWorld("agentuseDesktop", Object.freeze({
  ...context,
  getProviderStatus: () => ipcRenderer.invoke("agentuse:desktop:get-provider-status") as Promise<ProviderStatus>,
  openSettings: () => ipcRenderer.invoke("agentuse:desktop:open-settings") as Promise<void>,
} satisfies AgentUseDesktopContext));
