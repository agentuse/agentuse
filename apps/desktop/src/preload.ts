import { contextBridge, ipcRenderer } from "electron";

export interface AgentUseDesktopContext {
  surface: "desktop";
  cliCommand: string;
  serveAlreadyRunning: true;
}

const context = ipcRenderer.sendSync("agentuse:desktop-context") as AgentUseDesktopContext;
contextBridge.exposeInMainWorld("agentuseDesktop", Object.freeze(context));
