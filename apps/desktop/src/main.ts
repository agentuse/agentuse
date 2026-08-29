import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, shell, Tray, type Event, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pendingApprovalCount, pendingApprovalTitle, pendingApprovalTooltip, type ApprovalBucketsPayload } from "./approval-status";
import { bundledCliCommand } from "./bundled-cli";
import { createEditMenu, createNavigationMenu, createTrayMenu, type FindCommands, type NavigationCommands } from "./menus";
import { parseNotificationFrames, type NativeNotificationEvent } from "./notification-stream";
import { encodeNativeSettingsMessage, isNativeSettingsPipeClosure, parseNativeSettingsCommand, type NativeSettingsMessage } from "./native-settings";
import {
  clearPendingDesktopOnboardingLaunchAtLoginDefault,
  desktopOnboardingStatePath,
  hasDesktopOnboardingAppliedLaunchAtLoginDefault,
  isDesktopOnboardingComplete,
  markDesktopOnboardingComplete,
} from "./onboarding-state";
import { createDesktopQuitPolicy, shouldWarnBeforeFullQuit } from "./quit-policy";
import { isDashboardNavigation, isSafeExternalUrl, listRegisteredServers, selectServer, serverUrl, type RegisteredServer } from "./runtime";
import { createAgentUseTrayIcon } from "./tray-icon";
import { defaultCliLinkPath, inspectCliAvailability, loginShellPath, packagedCliLauncherPath, toggleCliLink, type CliLinkState } from "./cli-link";
import {
  dashboardShortcutAccelerator,
  DEFAULT_DASHBOARD_SHORTCUT,
  desktopPreferencesPath,
  normalizeDashboardShortcut,
  readDashboardShortcut,
  writeDashboardShortcut,
} from "./dashboard-shortcut";
import { getProviderStatus } from "../../../src/auth/provider-status";

const require = createRequire(__filename);
const APP_NAME = "AgentUse";
const STARTUP_TIMEOUT_MS = 15_000;
const APPROVAL_POLL_INTERVAL_MS = 5_000;

let window: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let settingsProcess: ChildProcess | undefined;
let settingsOutputBuffer = "";
let settingsCommandQueue = Promise.resolve();
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
let quitConfirmationInFlight = false;
let serverOperation: "starting" | "stopping" | undefined;
let serverAcquisition: Promise<void> | undefined;
let userLoginPath: Promise<string> | undefined;
let desktopSetupStartedAt: number | undefined;
let desktopCliLauncherAdded = false;
let dashboardShortcut: string | null = DEFAULT_DASHBOARD_SHORTCUT;
let registeredDashboardShortcut: string | undefined;
let dashboardShortcutError: string | undefined;
const pendingDesktopTelemetry: Array<{
  payload: Record<string, unknown>;
  clientSurface: "mac_app" | "mac_setup";
}> = [];
const quitPolicy = createDesktopQuitPolicy();

function queueDesktopTelemetry(
  payload: Record<string, unknown>,
  clientSurface: "mac_app" | "mac_setup" = "mac_setup",
): void {
  pendingDesktopTelemetry.push({ payload, clientSurface });
}

function queueDesktopOnboardingTelemetry(payload: Record<string, unknown>): void {
  queueDesktopTelemetry({ ...payload, onboarding_route: "desktop" });
}

async function flushDesktopTelemetry(): Promise<void> {
  if (!dashboardUrl || pendingDesktopTelemetry.length === 0) return;
  const telemetryUrl = new URL("/api/telemetry", dashboardUrl);
  while (pendingDesktopTelemetry.length > 0) {
    try {
      const pending = pendingDesktopTelemetry[0];
      const response = await fetch(telemetryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentUse-Client": pending.clientSurface,
          ...(dashboardApiKey ? { Authorization: `Bearer ${dashboardApiKey}` } : {}),
        },
        body: JSON.stringify(pending.payload),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return;
      pendingDesktopTelemetry.shift();
    } catch {
      return;
    }
  }
}

function resolveUserLoginPath(): Promise<string> {
  userLoginPath ??= loginShellPath();
  return userLoginPath;
}

function resolveCliPath(): string {
  if (process.env.AGENTUSE_CLI_PATH) return process.env.AGENTUSE_CLI_PATH;
  return require.resolve("agentuse/bin/cli.js");
}

function onboardingStateFile(): string {
  return desktopOnboardingStatePath(app.getPath("userData"));
}

function desktopPreferencesFile(): string {
  return desktopPreferencesPath(app.getPath("userData"));
}

function onboardingCliLinkState(link: CliLinkState) {
  return {
    path: defaultCliLinkPath(),
    status: link.status === "installed"
      ? "ready" as const
      : link.status === "notInstalled"
        ? "missing" as const
        : "conflict" as const,
    detail: link.status === "notInstalled"
      ? "Creates an agentuse command for Terminal. Make sure ~/.local/bin is in your PATH."
      : displayHomePath(link.detail),
  };
}

function displayHomePath(value: string): string {
  const home = homedir();
  return value === home ? "~" : value.replaceAll(`${home}/`, "~/");
}

async function desktopSetupState() {
  const link = inspectCliAvailability(
    defaultCliLinkPath(),
    packagedCliLauncherPath(process.resourcesPath),
    await resolveUserLoginPath(),
  );
  return {
    launcher: onboardingCliLinkState(link),
  };
}

function assertSetupSender(event: IpcMainInvokeEvent): void {
  if (!setupWindow || setupWindow.isDestroyed() || event.sender.id !== setupWindow.webContents.id) {
    throw new Error("This setup request did not come from the AgentUse setup window.");
  }
}

function assertDashboardSender(event: IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
    throw new Error("This request did not come from the AgentUse dashboard window.");
  }
}

function registerDesktopIpc(): void {
  ipcMain.on("agentuse:desktop-context", (event) => {
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      event.returnValue = undefined;
      return;
    }
    event.returnValue = {
      surface: "desktop",
      cliCommand: bundledCliCommand(process.execPath, resolveCliPath(), process.env),
      serveAlreadyRunning: true,
    };
  });
  ipcMain.handle("agentuse:desktop:get-provider-status", async (event) => {
    assertDashboardSender(event);
    return getProviderStatus();
  });
  ipcMain.handle("agentuse:setup:get-state", async (event) => {
    assertSetupSender(event);
    return desktopSetupState();
  });
  ipcMain.handle("agentuse:setup:install-cli-launcher", async (event) => {
    assertSetupSender(event);
    try {
      const linkPath = defaultCliLinkPath();
      const launcherPath = packagedCliLauncherPath(process.resourcesPath);
      const loginPath = await resolveUserLoginPath();
      const current = inspectCliAvailability(linkPath, launcherPath, loginPath);
      if (current.status === "notInstalled" || (current.status === "conflict" && !current.actionDisabled)) {
        await toggleCliLink(linkPath, launcherPath, loginPath);
        desktopCliLauncherAdded = true;
      } else if (current.status !== "installed") {
        throw new Error(current.detail);
      }
      return desktopSetupState();
    } catch (error) {
      queueDesktopOnboardingTelemetry({
        event: "onboarding_step_failed",
        step: "desktop_setup",
        error_code: "cli_launcher_add_failed",
      });
      throw error;
    }
  });
  ipcMain.handle("agentuse:setup:complete", async (event, launchAtLogin: unknown) => {
    assertSetupSender(event);
    if (typeof launchAtLogin !== "boolean") throw new TypeError("Launch at Login must be enabled or disabled.");
    try {
      const launcher = (await desktopSetupState()).launcher;
      const cliLauncherStatus = launcher.status === "ready"
        ? desktopCliLauncherAdded ? "added" : "already_available"
        : launcher.status === "conflict" ? "conflict" : "skipped";
      app.setLoginItemSettings({
        openAtLogin: launchAtLogin,
        openAsHidden: launchAtLogin,
        args: launchAtLogin ? ["--hidden"] : [],
      });
      await showDashboard();
      queueDesktopOnboardingTelemetry({
        event: "onboarding_step_completed",
        step: "desktop_setup",
        launch_at_login_enabled: launchAtLogin,
        cli_launcher_status: cliLauncherStatus,
        ...(desktopSetupStartedAt !== undefined && { duration_ms: Date.now() - desktopSetupStartedAt }),
      });
      await flushDesktopTelemetry();
      await markDesktopOnboardingComplete(onboardingStateFile());
      const completedWindow = setupWindow;
      setupWindow = undefined;
      completedWindow?.destroy();
    } catch (error) {
      queueDesktopOnboardingTelemetry({
        event: "onboarding_step_failed",
        step: "desktop_setup",
        error_code: "desktop_setup_failed",
      });
      throw error;
    }
  });
}

async function isDesktopOnboardingReady(): Promise<boolean> {
  return isDesktopOnboardingComplete(onboardingStateFile());
}

async function revertLegacyDesktopOnboardingDefault(): Promise<void> {
  const statePath = onboardingStateFile();
  if (!await hasDesktopOnboardingAppliedLaunchAtLoginDefault(statePath)) return;
  if (!await clearPendingDesktopOnboardingLaunchAtLoginDefault(statePath)) return;
  app.setLoginItemSettings({
    openAtLogin: false,
    openAsHidden: false,
    args: [],
  });
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

async function ensureServer(): Promise<void> {
  if (dashboardUrl && currentServer) return;
  if (!serverAcquisition) {
    serverOperation = "starting";
    serverAcquisition = acquireServer().finally(() => {
      serverAcquisition = undefined;
      serverOperation = undefined;
    });
  }
  await serverAcquisition;
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
      preload: join(__dirname, "preload.cjs"),
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
  // The web UI keeps its accessibility skip link in browsers. Electron gives
  // the first link automatic focus on launch, turning that normally hidden
  // control into persistent app chrome. Desktop also needs to correct the
  // brand link when Chromium newly focuses it after a hide/show cycle.
  browser.webContents.on("dom-ready", () => void prepareDesktopDocument(browser));
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
    if (dashboardUrl && isDashboardNavigation(details.url, dashboardUrl)) {
      details.requestHeaders["X-AgentUse-Client"] = "mac_app";
      if (dashboardApiKey) details.requestHeaders.Authorization = `Bearer ${dashboardApiKey}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  return browser;
}

function createSetupWindow(): BrowserWindow {
  const browser = new BrowserWindow({
    width: 860,
    height: 660,
    minWidth: 720,
    minHeight: 620,
    title: "Set up AgentUse for Mac",
    show: false,
    webPreferences: {
      preload: join(__dirname, "setup-preload.cjs"),
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
  browser.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (event: Event, url: string) => {
    if (url !== browser.webContents.getURL()) event.preventDefault();
  };
  browser.webContents.on("will-navigate", guardNavigation);
  browser.webContents.on("will-redirect", guardNavigation);
  browser.webContents.on("will-attach-webview", (event) => event.preventDefault());
  browser.once("ready-to-show", () => {
    browser.show();
    browser.focus();
  });
  return browser;
}

async function showDesktopSetup(): Promise<void> {
  if (desktopSetupStartedAt === undefined) {
    desktopSetupStartedAt = Date.now();
    queueDesktopOnboardingTelemetry({ event: "onboarding_started" });
    // Start the local daemon behind setup so a user who leaves before Continue
    // is still represented in the onboarding funnel. Failures stay invisible;
    // Continue will retry through the normal dashboard path.
    void ensureServer().then(flushDesktopTelemetry).catch(() => {});
  }
  if (process.platform === "darwin") await app.dock?.show();
  if (!setupWindow || setupWindow.isDestroyed()) {
    setupWindow = createSetupWindow();
    await setupWindow.loadFile(join(__dirname, "onboarding.html"));
  }
  setupWindow.show();
  setupWindow.focus();
  refreshMenus();
}

async function showPrimaryWindow(): Promise<void> {
  if (!await isDesktopOnboardingReady()) {
    await revertLegacyDesktopOnboardingDefault();
    await showDesktopSetup();
    return;
  }
  await showDashboard();
}

async function prepareDesktopDocument(browser: BrowserWindow): Promise<void> {
  if (browser.isDestroyed() || browser.webContents.isDestroyed()) return;
  await browser.webContents.executeJavaScript(`(() => {
    document.querySelector('.skip-link')?.remove();
    if (window.__agentuseDesktopFocusGuardInstalled) return;
    window.__agentuseDesktopFocusGuardInstalled = true;

    let brandWasFocusedBeforeBlur = false;
    const brandIsFocused = () => document.activeElement?.matches?.('.topbar .brand') === true;
    const desktopFocusSink = () => {
      let sink = document.querySelector('[data-agentuse-desktop-focus-sink]');
      if (sink instanceof HTMLElement) return sink;
      sink = document.createElement('div');
      sink.setAttribute('data-agentuse-desktop-focus-sink', '');
      sink.setAttribute('role', 'presentation');
      sink.tabIndex = -1;
      Object.assign(sink.style, {
        position: 'fixed',
        width: '1px',
        height: '1px',
        inset: '0 auto auto 0',
        opacity: '0',
        overflow: 'hidden',
        pointerEvents: 'none',
        outline: 'none',
      });
      document.body.prepend(sink);
      return sink;
    };
    const repairAccidentalBrandFocus = () => {
      requestAnimationFrame(() => {
        if (!brandIsFocused() || brandWasFocusedBeforeBlur) {
          brandWasFocusedBeforeBlur = false;
          return;
        }
        desktopFocusSink().focus({ preventScroll: true });
      });
    };

    window.addEventListener('blur', () => {
      brandWasFocusedBeforeBlur = brandIsFocused();
    });
    window.addEventListener('focus', repairAccidentalBrandFocus);
    repairAccidentalBrandFocus();
  })()`).catch(() => {});
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
  if (!dashboardUrl) await ensureServer();
  if (!window || window.isDestroyed()) window = createWindow();
  const targetUrl = requestedUrl ? notificationTargetUrl(requestedUrl) ?? dashboardUrl! : dashboardUrl!;
  if (window.webContents.getURL() !== targetUrl) await window.loadURL(targetUrl);
  await prepareDesktopDocument(window);
  startApprovalPolling();
  startNotificationStream();
  void refreshPendingApprovals();
  window.show();
  window.focus();
  refreshMenus();
}

function nativeSettingsExecutablePath(): string {
  const bundle = app.isPackaged
    ? join(process.resourcesPath, "..", "Frameworks", "AgentUseSettings.app")
    : join(__dirname, "AgentUseSettings.app");
  return join(bundle, "Contents", "MacOS", "AgentUseSettings");
}

function sendNativeSettingsMessage(message: NativeSettingsMessage, child = settingsProcess): void {
  if (!child?.stdin?.writable || child.stdin.destroyed || child.exitCode !== null || child.killed) return;
  try {
    child.stdin.write(encodeNativeSettingsMessage(message), (error) => {
      if (error) handleNativeSettingsPipeError(error, child);
    });
  } catch (error) {
    handleNativeSettingsPipeError(error, child);
  }
}

function handleNativeSettingsPipeError(error: unknown, child: ChildProcess): void {
  if (settingsProcess === child) settingsProcess = undefined;
  if (!isNativeSettingsPipeClosure(error)) {
    console.error("Could not write to native Settings:", error);
  }
}

async function pushNativeSettingsState(child = settingsProcess): Promise<void> {
  if (!child || child !== settingsProcess) return;
  const state = await desktopSettingsState();
  if (child !== settingsProcess) return;
  sendNativeSettingsMessage({ type: "state", state }, child);
}

async function handleNativeSettingsCommand(line: string, child: ChildProcess): Promise<void> {
  if (child !== settingsProcess) return;
  const command = parseNativeSettingsCommand(line);
  if (!command) return;
  switch (command.type) {
    case "refresh":
      await pushNativeSettingsState(child);
      break;
    case "ready":
      await pushNativeSettingsState(child);
      sendNativeSettingsMessage({ type: "show" }, child);
      break;
    case "toggleServer": {
      const operation = toggleServerFromSettings();
      await pushNativeSettingsState(child);
      await operation;
      await pushNativeSettingsState(child);
      break;
    }
    case "setLaunchAtLogin":
      app.setLoginItemSettings({
        openAtLogin: command.enabled,
        openAsHidden: command.enabled,
        args: command.enabled ? ["--hidden"] : [],
      });
      await pushNativeSettingsState(child);
      break;
    case "setDashboardShortcut": {
      try {
        await updateDashboardShortcut(command.shortcut);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        dashboardShortcutError = detail;
        sendNativeSettingsMessage({ type: "error", message: detail }, child);
      } finally {
        await pushNativeSettingsState(child);
      }
      break;
    }
    case "clearDashboardShortcut": {
      try {
        await updateDashboardShortcut(null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        dashboardShortcutError = detail;
        sendNativeSettingsMessage({ type: "error", message: detail }, child);
      } finally {
        await pushNativeSettingsState(child);
      }
      break;
    }
    case "toggleCliLink": {
      try {
        await toggleCliLink(
          defaultCliLinkPath(),
          packagedCliLauncherPath(process.resourcesPath),
          await resolveUserLoginPath(),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendNativeSettingsMessage({ type: "error", message: `Could not update the command line tool: ${detail}` }, child);
      } finally {
        await pushNativeSettingsState(child);
      }
      break;
    }
  }
}

function showSettings(): void {
  if (settingsProcess && settingsProcess.exitCode === null && !settingsProcess.killed) {
    sendNativeSettingsMessage({ type: "show" });
    void pushNativeSettingsState();
    return;
  }

  const executable = nativeSettingsExecutablePath();
  if (!existsSync(executable)) {
    dialog.showErrorBox("AgentUse Settings could not open", `The native Settings helper is missing at ${executable}. Rebuild the desktop app and try again.`);
    return;
  }

  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
  settingsProcess = child;
  settingsOutputBuffer = "";
  child.stdin?.on("error", (error) => handleNativeSettingsPipeError(error, child));
  child.stdin?.on("close", () => {
    if (settingsProcess === child) settingsProcess = undefined;
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    settingsOutputBuffer += chunk;
    const lines = settingsOutputBuffer.split("\n");
    settingsOutputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      settingsCommandQueue = settingsCommandQueue
        .then(() => handleNativeSettingsCommand(line, child))
        .catch((error: unknown) => console.error("Could not handle native Settings command:", error));
    }
  });
  child.once("error", (error) => {
    if (settingsProcess === child) settingsProcess = undefined;
    dialog.showErrorBox("AgentUse Settings could not open", error.message);
  });
  child.once("exit", () => {
    if (settingsProcess === child) settingsProcess = undefined;
  });
}

function toggleDashboard(): void {
  if (setupWindow && !setupWindow.isDestroyed() && setupWindow.isVisible()) {
    setupWindow.hide();
    return;
  }
  if (window && !window.isDestroyed() && window.isVisible()) {
    window.hide();
    return;
  }
  void showPrimaryWindow();
}

async function initializeDashboardShortcut(): Promise<void> {
  dashboardShortcut = await readDashboardShortcut(desktopPreferencesFile());
  dashboardShortcutError = undefined;
  if (!dashboardShortcut) return;
  const accelerator = dashboardShortcutAccelerator(dashboardShortcut);
  if (globalShortcut.register(accelerator, toggleDashboard)) {
    registeredDashboardShortcut = dashboardShortcut;
    return;
  }
  dashboardShortcutError = "That shortcut is already used by macOS or another app. Choose another shortcut.";
}

async function updateDashboardShortcut(value: string | null): Promise<void> {
  const normalized = normalizeDashboardShortcut(value);
  if (normalized === undefined) {
    throw new Error("Choose a shortcut with at least one modifier and one supported key.");
  }
  if (normalized === null) {
    await writeDashboardShortcut(desktopPreferencesFile(), null);
    if (registeredDashboardShortcut) {
      globalShortcut.unregister(dashboardShortcutAccelerator(registeredDashboardShortcut));
    }
    dashboardShortcut = null;
    registeredDashboardShortcut = undefined;
    dashboardShortcutError = undefined;
    return;
  }

  if (registeredDashboardShortcut === normalized) {
    await writeDashboardShortcut(desktopPreferencesFile(), normalized);
    dashboardShortcut = normalized;
    dashboardShortcutError = undefined;
    return;
  }

  const accelerator = dashboardShortcutAccelerator(normalized);
  if (!globalShortcut.register(accelerator, toggleDashboard)) {
    throw new Error("That shortcut is already used by macOS or another app. Choose another shortcut.");
  }
  try {
    await writeDashboardShortcut(desktopPreferencesFile(), normalized);
  } catch (error) {
    globalShortcut.unregister(accelerator);
    throw error;
  }
  if (registeredDashboardShortcut) {
    globalShortcut.unregister(dashboardShortcutAccelerator(registeredDashboardShortcut));
  }
  dashboardShortcut = normalized;
  registeredDashboardShortcut = normalized;
  dashboardShortcutError = undefined;
}

function unregisterDashboardShortcut(): void {
  if (!registeredDashboardShortcut) return;
  globalShortcut.unregister(dashboardShortcutAccelerator(registeredDashboardShortcut));
  registeredDashboardShortcut = undefined;
}

async function readLogTail(logFile: string | undefined, maxBytes = 200_000): Promise<string> {
  if (!logFile) return "";
  try {
    const file = await open(logFile, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, Math.max(0, size - length));
      return buffer.toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

async function desktopSettingsState() {
  const activeServer = currentServer && listRegisteredServers().find((server) => server.pid === currentServer?.pid);
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const cli = inspectCliAvailability(
    defaultCliLinkPath(),
    packagedCliLauncherPath(process.resourcesPath),
    await resolveUserLoginPath(),
  );
  const commonState = {
    launchAtLogin,
    dashboardShortcut,
    ...(dashboardShortcutError && { dashboardShortcutError }),
    cliStatus: cli.status,
    cliTitle: cli.title,
    cliDetail: displayHomePath(cli.detail),
    cliActionLabel: cli.actionLabel,
    cliActionDisabled: cli.actionDisabled,
    cliCommands: cli.commands.map(displayHomePath),
  };
  if (serverOperation === "starting") {
    return {
      status: "starting" as const,
      title: "Starting server…",
      detail: "Preparing the local AgentUse dashboard.",
      actionLabel: "Start Server" as const,
      actionDisabled: true,
      ...commonState,
      logText: "",
    };
  }
  if (serverOperation === "stopping") {
    return {
      status: "stopping" as const,
      title: "Stopping server…",
      detail: "Active work is being allowed to finish.",
      actionLabel: "Stop Server" as const,
      actionDisabled: true,
      ...commonState,
      logText: await readLogTail(activeServer?.logFile),
      logFile: activeServer?.logFile,
    };
  }
  if (!activeServer) {
    return {
      status: "stopped" as const,
      title: "Server stopped",
      detail: "Start the server to use the local dashboard and schedules.",
      actionLabel: "Start Server" as const,
      actionDisabled: false,
      ...commonState,
      logText: "",
    };
  }
  const isOwned = ownedServer?.pid === activeServer.pid;
  return {
    status: "running" as const,
    title: isOwned ? "Server running" : "Connected to external server",
    detail: isOwned ? `Dashboard available at ${serverUrl(activeServer)}` : `Started outside AgentUse at ${serverUrl(activeServer)}`,
    actionLabel: "Stop Server" as const,
    actionDisabled: !isOwned,
    ...commonState,
    logText: await readLogTail(activeServer.logFile),
    logFile: activeServer.logFile,
  };
}

async function toggleServerFromSettings() {
  const activeServer = currentServer && listRegisteredServers().find((server) => server.pid === currentServer?.pid);
  if (activeServer && ownedServer?.pid === activeServer.pid) {
    serverOperation = "stopping";
    try {
      await stopOwnedServerCleanly();
      window?.hide();
    } finally {
      serverOperation = undefined;
    }
  } else if (!activeServer) {
    await ensureServer();
    startApprovalPolling();
    startNotificationStream();
  }
  refreshMenus();
  return desktopSettingsState();
}

function requestFullQuit(): void {
  quitPolicy.requestFullQuit();
  app.quit();
}

async function requestFullQuitFromMenuBar(): Promise<void> {
  if (quitConfirmationInFlight) return;
  if (!shouldWarnBeforeFullQuit(ownedServer)) {
    requestFullQuit();
    return;
  }
  quitConfirmationInFlight = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "Quit AgentUse?",
      message: "Quit AgentUse and stop the local server?",
      detail: "Quitting the menu-bar app also stops the server. Scheduled agents and approvals will be unavailable until AgentUse starts again. Active work will be given time to finish.\n\nTo close only the Dashboard, keep AgentUse running and hide the window instead.",
      buttons: ["Keep AgentUse Running", "Quit and Stop Server"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) requestFullQuit();
  } finally {
    quitConfirmationInFlight = false;
  }
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
  trayMenu = Menu.buildFromTemplate(createTrayMenu({
    showDashboard: () => void showPrimaryWindow(),
    showSettings,
    quit: () => void requestFullQuitFromMenuBar(),
  }));
}

function refreshApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    // Command+Q and Dock Quit flow through before-quit without opting into a
    // full termination. The menu-bar item's separate menu opts in explicitly.
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Command+,", click: showSettings },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit AgentUse", accelerator: "Command+Q", click: () => app.quit() },
      ],
    },
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
  // Local desktop reinstalls terminate the existing app with SIGTERM before
  // replacing its bundle. Treat that as an explicit full quit so an owned
  // server gets the same graceful shutdown as the menu-bar Quit command.
  process.once("SIGTERM", requestFullQuit);
  app.on("second-instance", () => void showPrimaryWindow());
  app.on("will-quit", unregisterDashboardShortcut);
  app.on("before-quit", (event) => {
    if (!quitPolicy.shouldTerminate()) {
      event.preventDefault();
      window?.hide();
      setupWindow?.hide();
      sendNativeSettingsMessage({ type: "hide" });
      if (process.platform === "darwin") app.dock?.hide();
      return;
    }
    isQuitting = true;
    sendNativeSettingsMessage({ type: "quit" });
    if (approvalPollTimer) clearInterval(approvalPollTimer);
    stopNotificationStream();
    if (quitInProgress) return;
    event.preventDefault();
    void stopOwnedServerCleanly().finally(() => {
      quitInProgress = true;
      app.quit();
    });
  });
  app.on("activate", () => void showPrimaryWindow());
  app.whenReady().then(async () => {
    registerDesktopIpc();
    createTray();
    await initializeDashboardShortcut();
    const onboardingReady = await isDesktopOnboardingReady();
    const hiddenLaunch = process.argv.includes("--hidden");
    queueDesktopTelemetry({
      event: "desktop_app_launched",
      launch_mode: hiddenLaunch ? "login_item_hidden" : "interactive",
      onboarding_complete: onboardingReady,
      login_item_enabled: app.getLoginItemSettings().openAtLogin,
    }, "mac_app");
    if (hiddenLaunch && onboardingReady) {
      await ensureServer();
      await flushDesktopTelemetry();
      startApprovalPolling();
      startNotificationStream();
      refreshMenus();
      return;
    }
    await showPrimaryWindow();
    await flushDesktopTelemetry();
  }).catch((error: unknown) => {
    console.error("Could not open AgentUse desktop:", error);
    dialog.showErrorBox("AgentUse could not start", error instanceof Error ? error.message : String(error));
    requestFullQuit();
  });
}
