import { contextBridge, ipcRenderer } from "electron";

export interface DesktopSetupState {
  launcher: {
    path: string;
    status: "ready" | "missing" | "conflict";
    detail: string;
  };
}

contextBridge.exposeInMainWorld("agentuseSetup", Object.freeze({
  getState: (): Promise<DesktopSetupState> => ipcRenderer.invoke("agentuse:setup:get-state"),
  installCliLauncher: (): Promise<DesktopSetupState> => ipcRenderer.invoke("agentuse:setup:install-cli-launcher"),
  complete: (launchAtLogin: boolean): Promise<void> => ipcRenderer.invoke("agentuse:setup:complete", launchAtLogin),
}));
