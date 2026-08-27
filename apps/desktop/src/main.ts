import { app, BrowserWindow, dialog, Menu, shell, Tray, nativeImage, type Event, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { isDashboardNavigation, isSafeExternalUrl, listRegisteredServers, selectServer, serverUrl, type RegisteredServer } from "./runtime";

const require = createRequire(__filename);
const APP_NAME = "AgentUse";
const STARTUP_TIMEOUT_MS = 15_000;

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let dashboardUrl: string | undefined;
let dashboardApiKey: string | undefined;
let currentServer: RegisteredServer | undefined;
let ownedServer: ChildProcess | undefined;
let isQuitting = false;
let quitInProgress = false;

function resolveCliPath(): string {
  if (process.env.AGENTUSE_CLI_PATH) return process.env.AGENTUSE_CLI_PATH;
  return require.resolve("agentuse/bin/cli.js");
}

function runtimeStatus(activeServer: RegisteredServer | undefined): string {
  if (!dashboardUrl) return "Starting…";
  if (!activeServer) return "Unavailable";
  return ownedServer ? "Running (started by AgentUse)" : "Running (attached to existing server)";
}

async function probeServer(url: string, apiKey?: string): Promise<"ready" | "unauthorized" | "unreachable"> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (response.status === 401) return "unauthorized";
    return response.ok ? "ready" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function waitForServer(pid: number, apiKey?: string): Promise<RegisteredServer> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidate = listRegisteredServers().find((server) => server.pid === pid);
    if (candidate && await probeServer(serverUrl(candidate), apiKey) === "ready") return candidate;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("AgentUse server did not become ready within 15 seconds.");
}

async function findAvailableLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address() as AddressInfo;
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function acquireServer(): Promise<void> {
  const existing = selectServer(listRegisteredServers());
  if (existing) {
    const inheritedApiKey = process.env.AGENTUSE_API_KEY;
    const probe = await probeServer(serverUrl(existing), inheritedApiKey);
    if (probe === "unauthorized") {
      throw new Error("The running AgentUse backend requires a different API key. Set AGENTUSE_API_KEY before opening the desktop app, or restart the backend without operator authentication on loopback.");
    }
    if (probe === "unreachable") {
      throw new Error(`The registered AgentUse backend (pid ${existing.pid}) is not responding at ${serverUrl(existing)}.`);
    }
    currentServer = existing;
    dashboardUrl = serverUrl(existing);
    dashboardApiKey = inheritedApiKey;
    return;
  }

  const cli = resolveCliPath();
  if (!existsSync(cli)) throw new Error(`AgentUse CLI was not found at ${cli}`);
  const ownedPort = await findAvailableLoopbackPort();
  ownedServer = spawn(process.execPath, [cli, "serve", "--host", "127.0.0.1", "--port", String(ownedPort)], {
    cwd: app.getPath("home"),
    detached: false,
    stdio: "ignore",
    // Match the CLI's loopback-only default so Open in Browser works without
    // leaking credentials in a URL. The server rejects cross-origin writes.
    env: { ...process.env, AGENTUSE_API_KEY: undefined, ELECTRON_RUN_AS_NODE: "1" },
  });
  const ownedPid = ownedServer.pid;
  if (!ownedPid) throw new Error("AgentUse backend process did not start.");
  ownedServer.unref();
  ownedServer.once("exit", () => {
    ownedServer = undefined;
    if (currentServer?.pid === ownedPid) {
      currentServer = undefined;
      dashboardUrl = undefined;
      dashboardApiKey = undefined;
    }
    refreshMenus();
  });
  currentServer = await waitForServer(ownedPid);
  dashboardUrl = serverUrl(currentServer);
  dashboardApiKey = undefined;
}

function createWindow(): BrowserWindow {
  const browser = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  browser.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      browser.hide();
    }
  });
  browser.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const guardNavigation = (event: Event, url: string) => {
    if (!dashboardUrl || !isDashboardNavigation(url, dashboardUrl)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  };
  browser.webContents.on("will-navigate", guardNavigation);
  browser.webContents.on("will-redirect", guardNavigation);
  browser.webContents.on("will-attach-webview", (event) => event.preventDefault());
  browser.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "notifications" || permission === "clipboard-sanitized-write");
  });
  browser.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "notifications" || permission === "clipboard-sanitized-write";
  });
  browser.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (dashboardUrl && dashboardApiKey && isDashboardNavigation(details.url, dashboardUrl)) {
      details.requestHeaders.Authorization = `Bearer ${dashboardApiKey}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  return browser;
}

async function showDashboard(): Promise<void> {
  if (currentServer) {
    const registered = listRegisteredServers().find((server) => server.pid === currentServer?.pid);
    if (!registered || await probeServer(serverUrl(registered), dashboardApiKey) !== "ready") {
      currentServer = undefined;
      dashboardUrl = undefined;
      dashboardApiKey = undefined;
    } else {
      currentServer = registered;
    }
  }
  if (!dashboardUrl) await acquireServer();
  if (!window || window.isDestroyed()) window = createWindow();
  if (window.webContents.getURL() !== dashboardUrl) await window.loadURL(dashboardUrl!);
  window.show();
  window.focus();
  refreshMenus();
}

async function openLogs(): Promise<void> {
  if (currentServer?.logFile) await shell.openPath(currentServer.logFile);
}

function refreshMenus(): void {
  const activeServer = currentServer && listRegisteredServers().find((server) => server.pid === currentServer?.pid);
  const status: MenuItemConstructorOptions = { label: `Runtime: ${runtimeStatus(activeServer)}`, enabled: false };
  const items: MenuItemConstructorOptions[] = [
    { label: "Open AgentUse", click: () => void showDashboard() },
    status,
    { type: "separator" },
    // A protected runtime needs a header, which shell.openExternal cannot pass
    // without exposing the key. Keep it available in the embedded window only.
    { label: "Open in Browser", enabled: !!dashboardUrl && !dashboardApiKey, click: () => dashboardUrl && void shell.openExternal(dashboardUrl) },
    { label: "Open Logs", enabled: !!activeServer?.logFile, click: () => void openLogs() },
    { type: "separator" },
    { label: "Quit AgentUse", accelerator: "Command+Q", click: () => app.quit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(items));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: APP_NAME, submenu: items }]));
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  // A text title makes the status item visible without a bundled icon asset.
  tray.setTitle("AU");
  tray.setToolTip(APP_NAME);
  tray.on("click", () => void showDashboard());
  refreshMenus();
}

async function stopOwnedServerCleanly(): Promise<void> {
  const child = ownedServer;
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    // `agentuse serve` may spend up to eight seconds draining in-flight work
    // before it closes logs and telemetry. Leave headroom for those finalizers.
    }, 12_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void showDashboard());
  app.on("before-quit", (event) => {
    isQuitting = true;
    if (quitInProgress) return;
    event.preventDefault();
    void stopOwnedServerCleanly().finally(() => {
      quitInProgress = true;
      app.quit();
    });
  });
  app.on("activate", () => void showDashboard());
  app.whenReady().then(async () => {
    createTray();
    await showDashboard();
  }).catch((error: unknown) => {
    console.error("Could not open AgentUse desktop:", error);
    dialog.showErrorBox("AgentUse could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}
