import { contextBridge, ipcRenderer } from "electron";
import type { ProviderStatus } from "../../../src/auth/provider-status";

export interface DesktopNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface AgentUseDesktopContext {
  surface: "desktop";
  cliCommand: string;
  serveAlreadyRunning: true;
  getProviderStatus: () => Promise<ProviderStatus>;
  openSettings: () => Promise<void>;
  chooseProjectFolder: () => Promise<string | null>;
  getNavigationState: () => Promise<DesktopNavigationState>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  onNavigationStateChange: (listener: (state: DesktopNavigationState) => void) => () => void;
}

const context = ipcRenderer.sendSync("agentuse:desktop-context") as Omit<AgentUseDesktopContext, "getProviderStatus" | "openSettings" | "chooseProjectFolder" | "getNavigationState" | "goBack" | "goForward" | "onNavigationStateChange">;
contextBridge.exposeInMainWorld("agentuseDesktop", Object.freeze({
  ...context,
  getProviderStatus: () => ipcRenderer.invoke("agentuse:desktop:get-provider-status") as Promise<ProviderStatus>,
  openSettings: () => ipcRenderer.invoke("agentuse:desktop:open-settings") as Promise<void>,
  chooseProjectFolder: () => ipcRenderer.invoke("agentuse:desktop:choose-project-folder") as Promise<string | null>,
  getNavigationState: () => ipcRenderer.invoke("agentuse:desktop:get-navigation-state") as Promise<DesktopNavigationState>,
  goBack: () => ipcRenderer.invoke("agentuse:desktop:go-back") as Promise<void>,
  goForward: () => ipcRenderer.invoke("agentuse:desktop:go-forward") as Promise<void>,
  onNavigationStateChange: (listener: (state: DesktopNavigationState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopNavigationState) => listener(state);
    ipcRenderer.on("agentuse:desktop:navigation-state", handler);
    return () => ipcRenderer.removeListener("agentuse:desktop:navigation-state", handler);
  },
} satisfies AgentUseDesktopContext));
