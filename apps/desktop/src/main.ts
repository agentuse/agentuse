import { app, BrowserWindow, dialog, Menu, Notification, shell, Tray, type Event, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { pendingApprovalCount, pendingApprovalTitle, pendingApprovalTooltip, type ApprovalBucketsPayload } from "./approval-status";
import { createEditMenu, createNavigationMenu, type FindCommands, type NavigationCommands } from "./menus";
import { parseNotificationFrames, type NativeNotificationEvent } from "./notification-stream";
import { createDesktopQuitPolicy } from "./quit-policy";
import { isDashboardNavigation, isSafeExternalUrl, listRegisteredServers, selectServer, serverUrl, type RegisteredServer } from "./runtime";
import { createAgentUseTrayIcon } from "./tray-icon";

const require = createRequire(__filename);
const APP_NAME = "AgentUse";
const STARTUP_TIMEOUT_MS = 15_000;
const APPROVAL_POLL_INTERVAL_MS = 5_000;

let window: BrowserWindow | undefined;
let windowNeedsInitialFocusReset = false;
let tray: Tray | undefined;
let trayMenu: Menu | undefined;
let dashboardUrl: string | undefined;
let dashboardApiKey: string | undefined;
let currentServer: RegisteredServer | undefined;
let ownedServer: ChildProcess | undefined;
let approvalPollTimer: ReturnType<typeof setInterval> | undefined;
let notificationStreamController: AbortController | undefined;
let notificationStreamOrigin: string | undefined;
const activeNotifications = new Map<string, Notification>();
let displayedPendingApprovals = 0;
let approvalRefreshInFlight = false;
let isQuitting = false;
let quitInProgress = false;
const quitPolicy = createDesktopQuitPolicy();

function resolveCliPath(): string {
  if (process.env.AGENTUSE_CLI_PATH) return process.env.AGENTUSE_CLI_PATH;
  return require.resolve("agentuse/bin/cli.js");
}

function runtimeStatus(activeServer: RegisteredServer | undefined): string {
  if (!dashboardUrl) return "Starting…";
  if (!activeServer) return "Unavailable";
  return ownedServer ? "Running (started by AgentUse)" : "Running (attached to existing server)";
}

function setPendingApprovals(count: number): void {
  displayedPendingApprovals = count;
  tray?.setTitle(pendingApprovalTitle(count));
  tray?.setToolTip(pendingApprovalTooltip(count));
}

async function refreshPendingApprovals(): Promise<void> {
  if (approvalRefreshInFlight || !dashboardUrl) return;
  approvalRefreshInFlight = true;
  try {
    const approvalsUrl = new URL("/api/approvals", dashboardUrl);
    approvalsUrl.searchParams.set("view", "buckets");
    const response = await fetch(approvalsUrl, {
      signal: AbortSignal.timeout(2_000),
      headers: dashboardApiKey ? { Authorization: `Bearer ${dashboardApiKey}` } : undefined,
    });
    if (!response.ok) return;
    const count = pendingApprovalCount(await response.json() as ApprovalBucketsPayload);
    if (count !== undefined) setPendingApprovals(count);
  } catch {
    // A transient server restart should not make the last known count flicker.
  } finally {
    approvalRefreshInFlight = false;
  }
}

function startApprovalPolling(): void {
  if (approvalPollTimer) return;
  void refreshPendingApprovals();
  approvalPollTimer = setInterval(() => void refreshPendingApprovals(), APPROVAL_POLL_INTERVAL_MS);
  approvalPollTimer.unref();
}

function stopNotificationStream(): void {
  notificationStreamController?.abort();
  notificationStreamController = undefined;
  notificationStreamOrigin = undefined;
}

function notificationTargetUrl(url: string): string | undefined {
  if (!dashboardUrl) return undefined;
  try {
    const remote = new URL(url);
    return new URL(`${remote.pathname}${remote.search}${remote.hash}`, dashboardUrl).toString();
  } catch {
    return undefined;
  }
}

function showNativeNotification(event: NativeNotificationEvent): void {
  if (!Notification.isSupported()) return;
  const key = event.payload.tag ?? `${event.category}:${event.payload.url}`;
  activeNotifications.get(key)?.close();
  const notification = new Notification({
    title: event.payload.title,
    body: event.payload.body,
    silent: false,
  });
  activeNotifications.set(key, notification);
  const forget = () => {
    if (activeNotifications.get(key) === notification) activeNotifications.delete(key);
  };
  notification.on("click", () => {
    const target = notificationTargetUrl(event.payload.url);
    void showDashboard(target);
  });
  notification.on("close", forget);
  notification.on("failed", (_event, error) => {
    console.error("Could not show AgentUse notification:", error);
    forget();
  });
  notification.show();
}

async function waitForNotificationReconnect(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, 3_000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function consumeNotificationStream(origin: string, apiKey: string | undefined, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const streamUrl = new URL("/api/notifications/events", origin);
      const response = await fetch(streamUrl, {
        signal,
        headers: {
          Accept: "text/event-stream",
          ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
        },
      });
      if (!response.ok || !response.body) throw new Error(`Notification stream returned ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseNotificationFrames(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) showNativeNotification(event);
      }
    } catch (error) {
      if (!signal.aborted) console.debug("AgentUse notification stream disconnected:", error);
    }
    if (!signal.aborted) await waitForNotificationReconnect(signal);
  }
}

function startNotificationStream(): void {
  if (!dashboardUrl) return;
  if (notificationStreamController && notificationStreamOrigin === dashboardUrl) return;
  stopNotificationStream();
  notificationStreamOrigin = dashboardUrl;
  notificationStreamController = new AbortController();
  void consumeNotificationStream(dashboardUrl, dashboardApiKey, notificationStreamController.signal);
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
      stopNotificationStream();
      setPendingApprovals(0);
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
  // Electron emits the in-page event for History API changes made by the SPA.
  // Rebuild only the application menu so the tray menu and lifecycle stay put.
  browser.webContents.on("did-navigate", refreshApplicationMenu);
  browser.webContents.on("did-navigate-in-page", refreshApplicationMenu);
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
  windowNeedsInitialFocusReset = true;
  return browser;
}

function resetAutomaticInitialFocus(browser: BrowserWindow): void {
  if (!windowNeedsInitialFocusReset) return;
  windowNeedsInitialFocusReset = false;
  setImmediate(() => {
    if (browser.isDestroyed() || browser.webContents.isDestroyed()) return;
    void browser.webContents.executeJavaScript(`
      (() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.classList.contains('skip-link')) active.blur();
      })()
    `).catch(() => {});
  });
}

async function showDashboard(requestedUrl?: string): Promise<void> {
  if (process.platform === "darwin") await app.dock?.show();
  if (currentServer) {
    const registered = listRegisteredServers().find((server) => server.pid === currentServer?.pid);
    if (!registered || await probeServer(serverUrl(registered), dashboardApiKey) !== "ready") {
      currentServer = undefined;
      dashboardUrl = undefined;
      dashboardApiKey = undefined;
      stopNotificationStream();
      setPendingApprovals(0);
    } else {
      currentServer = registered;
    }
  }
  if (!dashboardUrl) await acquireServer();
  if (!window || window.isDestroyed()) window = createWindow();
  const targetUrl = requestedUrl ? notificationTargetUrl(requestedUrl) ?? dashboardUrl! : dashboardUrl!;
  if (window.webContents.getURL() !== targetUrl) await window.loadURL(targetUrl);
  startApprovalPolling();
  startNotificationStream();
  void refreshPendingApprovals();
  window.show();
  window.focus();
  resetAutomaticInitialFocus(window);
  refreshMenus();
}

function toggleDashboard(): void {
  if (window && !window.isDestroyed() && window.isVisible()) {
    window.hide();
    return;
  }
  void showDashboard();
}

async function openLogs(): Promise<void> {
  if (currentServer?.logFile) await shell.openPath(currentServer.logFile);
}

function requestFullQuit(): void {
  quitPolicy.requestFullQuit();
  app.quit();
}

function runtimeMenuItems(quit: () => void): MenuItemConstructorOptions[] {
  const activeServer = currentServer && listRegisteredServers().find((server) => server.pid === currentServer?.pid);
  const status: MenuItemConstructorOptions = { label: `Runtime: ${runtimeStatus(activeServer)}`, enabled: false };
  return [
    { label: "Open AgentUse", click: () => void showDashboard() },
    status,
    { type: "separator" },
    // A protected runtime needs a header, which shell.openExternal cannot pass
    // without exposing the key. Keep it available in the embedded window only.
    { label: "Open in Browser", enabled: !!dashboardUrl && !dashboardApiKey, click: () => dashboardUrl && void shell.openExternal(dashboardUrl) },
    { label: "Open Logs", enabled: !!activeServer?.logFile, click: () => void openLogs() },
    { type: "separator" },
    { label: "Quit AgentUse", accelerator: "Command+Q", click: quit },
  ];
}

function activeNavigationHistory() {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return undefined;
  return window.webContents.navigationHistory;
}

const navigationCommands: NavigationCommands = {
  canGoBack: () => activeNavigationHistory()?.canGoBack() ?? false,
  canGoForward: () => activeNavigationHistory()?.canGoForward() ?? false,
  goBack: () => {
    const history = activeNavigationHistory();
    if (history?.canGoBack()) history.goBack();
  },
  goForward: () => {
    const history = activeNavigationHistory();
    if (history?.canGoForward()) history.goForward();
  },
};

function focusSessionLogSearch(): void {
  if (window && !window.isDestroyed() && window.isVisible()) {
    void window.webContents.executeJavaScript("window.dispatchEvent(new Event('agentuse:find-session-log'))");
    return;
  }
  void showDashboard().then(() => window?.webContents.executeJavaScript(
    "window.dispatchEvent(new Event('agentuse:find-session-log'))"
  ));
}

const findCommands: FindCommands = {
  open: focusSessionLogSearch,
};

function refreshTrayMenu(): void {
  trayMenu = Menu.buildFromTemplate(runtimeMenuItems(requestFullQuit));
}

function refreshApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    // Command+Q and Dock Quit flow through before-quit without opting into a
    // full termination. The menu-bar item's separate menu opts in explicitly.
    { label: APP_NAME, submenu: runtimeMenuItems(() => app.quit()) },
    createEditMenu(findCommands),
    createNavigationMenu(navigationCommands),
  ]));
}

function refreshMenus(): void {
  refreshTrayMenu();
  refreshApplicationMenu();
}

function createTray(): void {
  tray = new Tray(createAgentUseTrayIcon());
  setPendingApprovals(displayedPendingApprovals);
  tray.on("click", toggleDashboard);
  tray.on("right-click", () => {
    if (trayMenu) tray?.popUpContextMenu(trayMenu);
  });
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
    if (!quitPolicy.shouldTerminate()) {
      event.preventDefault();
      window?.hide();
      if (process.platform === "darwin") app.dock?.hide();
      return;
    }
    isQuitting = true;
    if (approvalPollTimer) clearInterval(approvalPollTimer);
    stopNotificationStream();
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
    requestFullQuit();
  });
}
