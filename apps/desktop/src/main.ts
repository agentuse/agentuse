import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, powerMonitor, shell, Tray, type Event, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pendingApprovalCount, pendingApprovalTitle, pendingApprovalTooltip, type ApprovalBucketsPayload } from "./approval-status";
import { bundledCliCommand } from "./bundled-cli";
import { createEditMenu, createNavigationMenu, createTrayMenu, createViewMenu, type FindCommands, type NavigationCommands, type ShareCommands, type ViewCommands } from "./menus";
import { notificationTargetUrl, parseNotificationFrames, type NativeNotificationEvent } from "./notification-stream";
import { encodeNativeSettingsMessage, isNativeSettingsPipeClosure, parseNativeSettingsCommand, type NativeSettingsMessage } from "./native-settings";
import {
  clearPendingDesktopOnboardingLaunchAtLoginDefault,
  desktopOnboardingStatePath,
  hasDesktopOnboardingAppliedLaunchAtLoginDefault,
  isDesktopOnboardingComplete,
  markDesktopOnboardingComplete,
} from "./onboarding-state";
import { createDesktopQuitPolicy, deferDesktopQuitAfterDrain, shouldWarnBeforeFullQuit } from "./quit-policy";
import { shouldHideDashboardWindow } from "./dashboard-presentation";
import { isAbandonedDesktopServer, isDashboardNavigation, isSafeExternalUrl, listRegisteredServers, selectServer, serverAcquisitionMode, serverRegistryDirectory, serverUrl, type RegisteredServer, type ServerEndpoint } from "./runtime";
import { readExternalServerTarget, writeExternalServerTarget, type ExternalServerTarget } from "./external-server-state";
import { findReadyExternalServer, probeServer } from "./server-connection";
import { createAgentUseTrayIcon } from "./tray-icon";
import { selectLoopbackPort } from "./port-selection";
import { defaultCliLinkPath, inspectCliAvailability, loginShellPath, packagedCliLauncherPath, toggleCliLink } from "./cli-link";
import {
  dashboardShortcutAccelerator,
  DEFAULT_DASHBOARD_SHORTCUT,
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  desktopPreferencesPath,
  normalizeDashboardShortcut,
  readDashboardShortcut,
  readDesktopNotificationPreferences,
  writeDesktopNotificationPreference,
  writeDashboardShortcut,
  type DesktopNotificationPreferences,
} from "./dashboard-shortcut";
import { getProviderStatus } from "../../../src/auth/provider-status";
import { loadGlobalConfig } from "../../../src/utils/global-config";
import { cloudUrl, readCloudConnection } from "../../../src/cloud/config";
import { completeProviderOAuth, saveProviderApiKey, startProviderOAuth } from "../../../src/auth/provider-setup";
import { CloudConnector, cloudSettingsState, type CloudApiState } from "./cloud-settings";
import { codingAgentStatuses, isCodingAgentId, setUpCodingAgent, type McpTarget } from "../../../src/onboarding/coding-agents";
import { automateWorkflow } from "../../../src/mcp-server/prompts";
import { connectPageUrl, isSetupApiKeyProvider, setupAiState, setupCloudState } from "./setup-wizard";
import { initializeDesktopGlobalDefaults } from "./global-defaults";
import { DesktopUpdater, type DesktopUpdateState } from "./updater";
import { DesktopUpdateScheduler } from "./update-scheduler";
import { currentProcessRef } from "../../../src/utils/process-info";
import {
  DESKTOP_LIFETIME_FD_ENV,
  DESKTOP_SUPERVISOR_ENV,
  type DesktopServerSupervisor,
} from "../../../src/utils/desktop-supervisor";

const require = createRequire(__filename);
const APP_NAME = "AgentUse";
const STARTUP_TIMEOUT_MS = 15_000;
const EXTERNAL_RECONNECT_TIMEOUT_MS = 10_000;
const APPROVAL_POLL_INTERVAL_MS = 5_000;
const SERVER_CONNECTION_POLL_INTERVAL_MS = 5_000;
const DESKTOP_SERVER_LIFETIME_FD = 3;
const desktopServerSupervisor: DesktopServerSupervisor = {
  kind: "desktop",
  token: randomUUID(),
  ...currentProcessRef(),
};

let window: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let settingsProcess: ChildProcess | undefined;
// `agentuse connect` / `disconnect`, run with the bundled CLI so the app and
// the terminal share one flow and one ~/.agentuse/cloud.json.
const cloudConnector = new CloudConnector(
  (args) => spawn(process.execPath, [resolveCliPath(), ...args], {
    cwd: app.getPath("home"),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_TTY: "true" },
  }),
  () => {
    void pushNativeSettingsState();
    notifySetupWindow();
  },
  // Like `gh auth login`: the code is ready to paste on the page that opens.
  (code) => clipboard.writeText(code),
);
let settingsOutputBuffer = "";
let settingsCommandQueue = Promise.resolve();
// Shown as an alert once Settings is on screen, e.g. why the dashboard could
// not open. A freshly spawned helper only reads it after it reports ready.
let pendingSettingsError: string | undefined;
let tray: Tray | undefined;
let trayMenu: Menu | undefined;
let dashboardUrl: string | undefined;
let dashboardApiKey: string | undefined;

/** The local server's MCP endpoint, for Claude Code and Codex on this Mac. */
function localMcpTarget(): McpTarget {
  if (!dashboardUrl) throw new Error("AgentUse is still starting. Try again in a moment.");
  return { url: `${dashboardUrl.replace(/\/+$/u, "")}/mcp`, ...(dashboardApiKey && { apiKey: dashboardApiKey }) };
}
let currentServer: RegisteredServer | undefined;
// Keep external ownership sticky across a restart gap. Without this hint, a
// one-second failed probe can make Desktop see port 12233 as unowned and bind
// its own daemon before the external supervisor restarts `agentuse serve`.
let disconnectedExternalServer: ExternalServerTarget | undefined;
let externalServerStateLoaded = false;
let ownedServer: ChildProcess | undefined;
let approvalPollTimer: ReturnType<typeof setInterval> | undefined;
let serverConnectionTimer: ReturnType<typeof setInterval> | undefined;
let serverConnectionRefresh: Promise<void> | undefined;
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
let dashboardPresentationQueue = Promise.resolve();
let userLoginPath: Promise<string> | undefined;
let desktopSetupStartedAt: number | undefined;
// The ChatGPT sign-in the first-run window started, finished by pasting the address.
let setupChatGptFlow: string | undefined;
let dashboardShortcut: string | null = DEFAULT_DASHBOARD_SHORTCUT;
let desktopNotificationPreferences: DesktopNotificationPreferences = { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES };
let registeredDashboardShortcut: string | undefined;
let dashboardShortcutError: string | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let desktopUpdateScheduler: DesktopUpdateScheduler | undefined;
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

function displayHomePath(value: string): string {
  const home = homedir();
  return value === home ? "~" : value.replaceAll(`${home}/`, "~/");
}

async function desktopSetupState() {
  const activeServer = currentServer && listRegisteredServers().find((server) => server.pid === currentServer?.pid);
  const saved = savedCloudConnection();
  const api = saved ? await cloudApiState(activeServer) : undefined;
  const view = cloudConnector.view;
  return {
    cloud: setupCloudState({
      ...(api && { api }),
      ...(saved && { saved }),
      ...(view.connecting && { connecting: view.connecting }),
      ...(view.error && { error: view.error }),
    }),
    ai: setupAiState(await getProviderStatus()),
    connectPage: `${cloudUrl().replace(/^https?:\/\//u, "")}/connect`,
  };
}

function notifySetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send("agentuse:setup:changed");
}

/** A call to the local server the first-run window needs, e.g. making the first project. */
async function dashboardApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureServer();
  const response = await fetch(new URL(path, dashboardUrl), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(dashboardApiKey ? { Authorization: `Bearer ${dashboardApiKey}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `AgentUse answered ${response.status}.`);
  return payload as T;
}

/** The project new agents go in: the default one, or my-agents made now. */
async function ensureSetupProject(): Promise<string> {
  type Project = { id: string; path: string; about?: { name?: string } };
  const info = await dashboardApi<{ projects: Project[]; default?: string }>("/api");
  const existing = info.projects.find((project) => project.id === info.default) ?? info.projects[0];
  if (existing) return existing.about?.name ?? existing.id;
  try {
    const created = await dashboardApi<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "my-agents" }),
    });
    return created.project.about?.name ?? created.project.id;
  } catch (error) {
    // Made by another window a moment ago.
    const again = await dashboardApi<{ projects: Project[] }>("/api");
    if (again.projects[0]) return again.projects[0].about?.name ?? again.projects[0].id;
    throw error;
  }
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
  ipcMain.handle("agentuse:desktop:open-settings", async (event) => {
    assertDashboardSender(event);
    showSettings();
  });
  ipcMain.handle("agentuse:desktop:choose-project-folder", async (event) => {
    assertDashboardSender(event);
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a project folder",
      buttonLabel: "Choose project",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("agentuse:desktop:get-navigation-state", (event) => {
    assertDashboardSender(event);
    return dashboardNavigationState();
  });
  ipcMain.handle("agentuse:desktop:go-back", (event) => {
    assertDashboardSender(event);
    navigationCommands.goBack();
  });
  ipcMain.handle("agentuse:desktop:go-forward", (event) => {
    assertDashboardSender(event);
    navigationCommands.goForward();
  });
  ipcMain.handle("agentuse:setup:get-state", async (event) => {
    assertSetupSender(event);
    return desktopSetupState();
  });
  ipcMain.handle("agentuse:setup:connect-cloud", async (event) => {
    assertSetupSender(event);
    if (cloudConnector.view.connecting) return;
    if ((await desktopSetupState()).cloud.status === "connected") return;
    cloudConnector.connect();
  });
  ipcMain.handle("agentuse:setup:cancel-cloud", (event) => {
    assertSetupSender(event);
    cloudConnector.cancel();
  });
  ipcMain.handle("agentuse:setup:open-connect-page", async (event) => {
    assertSetupSender(event);
    const code = cloudConnector.view.connecting?.code;
    if (code) clipboard.writeText(code);
    await shell.openExternal(connectPageUrl(cloudUrl()));
  });
  ipcMain.handle("agentuse:setup:start-chatgpt", async (event) => {
    assertSetupSender(event);
    const flow = await startProviderOAuth("openai");
    setupChatGptFlow = flow.flowId;
    await shell.openExternal(flow.authorizationUrl);
  });
  ipcMain.handle("agentuse:setup:finish-chatgpt", async (event, address: unknown) => {
    assertSetupSender(event);
    if (!setupChatGptFlow) throw new Error("Press Sign in with ChatGPT first.");
    if (typeof address !== "string" || !address.trim()) throw new Error("Paste the address from your browser.");
    await completeProviderOAuth(setupChatGptFlow, address);
    setupChatGptFlow = undefined;
    return setupAiState(await getProviderStatus());
  });
  ipcMain.handle("agentuse:setup:save-api-key", async (event, provider: unknown, key: unknown) => {
    assertSetupSender(event);
    if (!isSetupApiKeyProvider(provider)) throw new TypeError("Pick Anthropic, OpenAI or OpenRouter.");
    await saveProviderApiKey(provider, key);
    return setupAiState(await getProviderStatus());
  });
  ipcMain.handle("agentuse:setup:prepare-ready", async (event) => {
    assertSetupSender(event);
    const project = await ensureSetupProject();
    return { project, dashboardUrl: dashboardUrl!, mcpUrl: localMcpTarget().url };
  });
  ipcMain.handle("agentuse:setup:coding-agents", async (event) => {
    assertSetupSender(event);
    return codingAgentStatuses(localMcpTarget());
  });
  ipcMain.handle("agentuse:setup:set-up-agent", async (event, id: unknown) => {
    assertSetupSender(event);
    if (!isCodingAgentId(id)) throw new TypeError("Pick Claude Code or Codex.");
    const target = localMcpTarget();
    await setUpCodingAgent(id, target, await automateWorkflow());
    return codingAgentStatuses(target);
  });
  ipcMain.handle("agentuse:setup:copy", (event, text: unknown) => {
    assertSetupSender(event);
    if (typeof text !== "string") throw new TypeError("Nothing to copy.");
    clipboard.writeText(text);
  });
  ipcMain.handle("agentuse:setup:open-help", async (event) => {
    assertSetupSender(event);
    await shell.openExternal("https://docs.agentuse.io/guides/agentuse-cloud");
  });
  ipcMain.handle("agentuse:setup:complete", async (event, route: unknown, openDashboard: unknown) => {
    assertSetupSender(event);
    if (route !== "cloud" && route !== "local") throw new TypeError("Pick where you'll use AgentUse.");
    try {
      await ensureServer();
      if (openDashboard === true) await showDashboard();
      queueDesktopOnboardingTelemetry({
        event: "onboarding_step_completed",
        step: "desktop_setup",
        launch_at_login_enabled: true,
        ...(desktopSetupStartedAt !== undefined && { duration_ms: Date.now() - desktopSetupStartedAt }),
      });
      await flushDesktopTelemetry();
      await markDesktopOnboardingComplete(onboardingStateFile());
      const completedWindow = setupWindow;
      setupWindow = undefined;
      completedWindow?.destroy();
      // "Runs in the background": schedules and approvals need the app at login.
      // Last, so macOS's "Login Item Added" notice comes after setup, not over it.
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ["--hidden"] });
      refreshMenus();
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

function showNativeNotification(event: NativeNotificationEvent, source: ServerEndpoint | undefined): void {
  if (!desktopNotificationPreferences[event.category]) return;
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
  notification.on("click", () => void showDashboard(event.payload.url, source));
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

async function consumeNotificationStream(
  origin: string,
  apiKey: string | undefined,
  source: ServerEndpoint | undefined,
  signal: AbortSignal,
): Promise<void> {
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
        for (const event of parsed.events) showNativeNotification(event, source);
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
  const source = currentServer && { port: currentServer.port, projectRoot: currentServer.projectRoot };
  void consumeNotificationStream(dashboardUrl, dashboardApiKey, source, notificationStreamController.signal);
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

async function waitForExternalServer(previous: ExternalServerTarget, apiKey?: string): Promise<RegisteredServer | undefined> {
  const deadline = Date.now() + EXTERNAL_RECONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidate = await findReadyExternalServer(listRegisteredServers(), previous, apiKey);
    if (candidate) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

async function refreshExternalServerConnection(): Promise<void> {
  if (serverConnectionRefresh) return serverConnectionRefresh;
  if (isQuitting || serverOperation || ownedServer || !disconnectedExternalServer) return;
  const previous = currentServer;
  const target = disconnectedExternalServer;
  const apiKey = dashboardApiKey ?? process.env.AGENTUSE_API_KEY;
  serverConnectionRefresh = (async () => {
    let replacement: RegisteredServer | undefined;
    try {
      replacement = await findReadyExternalServer(listRegisteredServers(), target, apiKey);
    } catch {
      // Authentication failure is disconnected too; explicit dashboard opens
      // still surface the actionable error from the acquisition path.
    }
    // A settings action or dashboard open may have acquired a server while the
    // probe was in flight. Never overwrite that newer connection or shutdown.
    if (isQuitting || serverOperation || ownedServer || currentServer !== previous
      || disconnectedExternalServer !== target) return;
    if (replacement) {
      const recovered = !previous || previous.pid !== replacement.pid
        || previous.procStartedAt !== replacement.procStartedAt || !dashboardUrl;
      currentServer = replacement;
      dashboardUrl = serverUrl(replacement);
      dashboardApiKey = apiKey;
      if (recovered) {
        stopNotificationStream();
        startApprovalPolling();
        startNotificationStream();
        void refreshPendingApprovals();
        void pushNativeSettingsState();
      }
    } else if (previous) {
      currentServer = undefined;
      dashboardUrl = undefined;
      dashboardApiKey = undefined;
      stopNotificationStream();
      setPendingApprovals(0);
      void pushNativeSettingsState();
    }
  })().finally(() => { serverConnectionRefresh = undefined; });
  return serverConnectionRefresh;
}

function startServerConnectionPolling(): void {
  if (serverConnectionTimer) return;
  serverConnectionTimer = setInterval(() => {
    void refreshExternalServerConnection().catch((error: unknown) => {
      console.warn("Could not refresh the external AgentUse connection:", error);
    });
  }, SERVER_CONNECTION_POLL_INTERVAL_MS);
  serverConnectionTimer.unref();
}

function registeredServerIsStillRunning(server: RegisteredServer): boolean {
  return listRegisteredServers().some((candidate) => candidate.pid === server.pid
    && (!server.procStartedAt || !candidate.procStartedAt || candidate.procStartedAt === server.procStartedAt));
}

async function reconcileAbandonedDesktopServers(): Promise<void> {
  const abandoned = listRegisteredServers().filter((server) => isAbandonedDesktopServer(server));
  for (const server of abandoned) {
    console.warn(`Stopping AgentUse server ${server.pid} left by a terminated desktop app.`);
    try {
      process.kill(server.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.warn(`Could not stop abandoned AgentUse server ${server.pid}:`, error);
      }
      continue;
    }

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && registeredServerIsStillRunning(server)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!registeredServerIsStillRunning(server)) continue;

    // Match the explicit app-quit policy: a daemon that ignores its graceful
    // window must not outlive the desktop supervisor indefinitely.
    try {
      process.kill(server.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.warn(`Could not force-stop abandoned AgentUse server ${server.pid}:`, error);
      }
    }
    const forcedDeadline = Date.now() + 1_000;
    while (Date.now() < forcedDeadline && registeredServerIsStillRunning(server)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function acquireServer(allowReplacingExternal = false): Promise<void> {
  const statePath = join(app.getPath("userData"), "external-server.json");
  if (!externalServerStateLoaded) {
    disconnectedExternalServer = await readExternalServerTarget(statePath, serverRegistryDirectory());
    externalServerStateLoaded = true;
  }
  await reconcileAbandonedDesktopServers();
  const inheritedApiKey = process.env.AGENTUSE_API_KEY;
  if (disconnectedExternalServer && serverAcquisitionMode(disconnectedExternalServer, allowReplacingExternal) === "reconnect-external") {
    const replacement = await waitForExternalServer(disconnectedExternalServer, inheritedApiKey);
    if (replacement) {
      currentServer = replacement;
      dashboardUrl = serverUrl(replacement);
      dashboardApiKey = inheritedApiKey;
      disconnectedExternalServer = replacement;
      return;
    }
    throw new Error(`The external AgentUse backend at ${serverUrl(disconnectedExternalServer)} is not running. Desktop left its port available so the external server can restart. Use Start Server in Settings if you want Desktop to replace it.`);
  }

  const existing = selectServer(listRegisteredServers());
  if (existing) {
    // Remember ownership before probing: a registered backend can still be warming up.
    disconnectedExternalServer = existing;
    await writeExternalServerTarget(statePath, serverRegistryDirectory(), existing);
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
    disconnectedExternalServer = existing;
    return;
  }

  const cli = resolveCliPath();
  if (!existsSync(cli)) throw new Error(`AgentUse CLI was not found at ${cli}`);
  const ownedPort = await selectLoopbackPort(loadGlobalConfig()?.serve?.port);
  ownedServer = spawn(process.execPath, [cli, "serve", "--host", "127.0.0.1", "--port", String(ownedPort)], {
    cwd: app.getPath("home"),
    detached: false,
    // fd 3 is a lifetime lease: an abnormal desktop exit closes the pipe and
    // asks the daemon to take its normal graceful shutdown path.
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    // Match the CLI's loopback-only default so Open in Browser works without
    // leaking credentials in a URL. The server rejects cross-origin writes.
    env: {
      ...process.env,
      AGENTUSE_API_KEY: undefined,
      ELECTRON_RUN_AS_NODE: "1",
      [DESKTOP_LIFETIME_FD_ENV]: String(DESKTOP_SERVER_LIFETIME_FD),
      [DESKTOP_SUPERVISOR_ENV]: JSON.stringify(desktopServerSupervisor),
    },
  });
  const ownedPid = ownedServer.pid;
  if (!ownedPid) throw new Error("AgentUse backend process did not start.");
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
  try {
    currentServer = await waitForServer(ownedPid);
  } catch (error) {
    await stopOwnedServerCleanly();
    throw error;
  }
  await writeExternalServerTarget(statePath, serverRegistryDirectory());
  dashboardUrl = serverUrl(currentServer);
  dashboardApiKey = undefined;
  disconnectedExternalServer = undefined;
}

async function ensureServer(allowReplacingExternal = false): Promise<void> {
  if (dashboardUrl && currentServer) return;
  if (!serverAcquisition) {
    serverOperation = "starting";
    serverAcquisition = acquireServer(allowReplacingExternal).finally(() => {
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
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 16 },
    } : {}),
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
  browser.webContents.on("did-navigate", () => {
    refreshApplicationMenu();
    broadcastNavigationState();
  });
  browser.webContents.on("did-navigate-in-page", () => {
    refreshApplicationMenu();
    broadcastNavigationState();
  });
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
    width: 720,
    height: 660,
    minWidth: 640,
    minHeight: 560,
    title: "Welcome to AgentUse",
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

/**
 * Every user entry point into the dashboard (launch, Dock, tray, shortcut,
 * second instance) goes through here. The menu-bar shell already exists, so a
 * backend Desktop cannot reach is never fatal: Settings opens on the server
 * state with the reason, and Start Server stays one click away.
 */
async function openPrimaryWindow(): Promise<void> {
  try {
    await showPrimaryWindow();
  } catch (error) {
    console.error("Could not open the AgentUse dashboard:", error);
    pendingSettingsError = error instanceof Error ? error.message : String(error);
    refreshMenus();
    showSettings();
  }
}

async function prepareDesktopDocument(browser: BrowserWindow): Promise<void> {
  if (browser.isDestroyed() || browser.webContents.isDestroyed()) return;
  await browser.webContents.executeJavaScript(`(() => {
    document.documentElement.toggleAttribute('data-agentuse-desktop-mac', ${process.platform === "darwin"});
    document.querySelector('.skip-link')?.remove();
    if (window.__agentuseDesktopFocusGuardInstalled) return;
    window.__agentuseDesktopFocusGuardInstalled = true;

    let brandWasFocusedBeforeBlur = false;
    const brandIsFocused = () => document.activeElement?.matches?.('.sidebar-brand') === true;
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

/** `source` is the daemon a notification came from; see notificationTargetUrl. */
function showDashboard(requestedUrl?: string, source?: ServerEndpoint): Promise<void> {
  const presentation = dashboardPresentationQueue
    .catch(() => {})
    .then(() => presentDashboard(requestedUrl, source));
  dashboardPresentationQueue = presentation;
  return presentation;
}

async function presentDashboard(requestedUrl?: string, source?: ServerEndpoint): Promise<void> {
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
  const targetUrl = requestedUrl
    ? notificationTargetUrl(requestedUrl, dashboardUrl!, source, currentServer) ?? dashboardUrl!
    : dashboardUrl!;
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

function settingsShowMessage(): NativeSettingsMessage {
  return { type: "show" };
}

function flushPendingSettingsError(child = settingsProcess): void {
  if (!pendingSettingsError) return;
  sendNativeSettingsMessage({ type: "error", message: pendingSettingsError }, child);
  pendingSettingsError = undefined;
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
      sendNativeSettingsMessage(settingsShowMessage(), child);
      flushPendingSettingsError(child);
      break;
    case "toggleServer": {
      const operation = toggleServerFromSettings();
      await pushNativeSettingsState(child);
      try {
        await operation;
      } catch (error) {
        console.error("Could not change the AgentUse server:", error);
        const detail = error instanceof Error ? error.message : String(error);
        sendNativeSettingsMessage({ type: "error", message: detail }, child);
        refreshMenus();
      } finally {
        await pushNativeSettingsState(child);
      }
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
    case "setNotificationPreference":
      try {
        await writeDesktopNotificationPreference(desktopPreferencesFile(), command.category, command.enabled);
        desktopNotificationPreferences = {
          ...desktopNotificationPreferences,
          [command.category]: command.enabled,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendNativeSettingsMessage({ type: "error", message: `Could not update notifications: ${detail}` }, child);
      } finally {
        await pushNativeSettingsState(child);
      }
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
    case "toggleCloud": {
      const view = cloudConnector.view;
      try {
        if (view.connecting) cloudConnector.cancel();
        else if (readCloudConnection()) await cloudConnector.disconnect();
        else cloudConnector.connect();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendNativeSettingsMessage({ type: "error", message: detail }, child);
      } finally {
        await pushNativeSettingsState(child);
      }
      break;
    }
    case "checkForUpdates":
      await desktopUpdateScheduler?.checkNow();
      await pushNativeSettingsState(child);
      break;
    case "downloadUpdate":
      await desktopUpdater?.downloadUpdate();
      await pushNativeSettingsState(child);
      break;
    case "installUpdate":
      await desktopUpdater?.installUpdate();
      break;
  }
}

function showSettings(): void {
  if (settingsProcess && settingsProcess.exitCode === null && !settingsProcess.killed) {
    sendNativeSettingsMessage(settingsShowMessage());
    void pushNativeSettingsState();
    flushPendingSettingsError();
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
  if (setupWindow && !setupWindow.isDestroyed() && shouldHideDashboardWindow(setupWindow)) {
    setupWindow.hide();
    return;
  }
  if (window && !window.isDestroyed() && shouldHideDashboardWindow(window)) {
    window.hide();
    return;
  }
  void openPrimaryWindow();
}

async function initializeDesktopPreferences(): Promise<void> {
  [dashboardShortcut, desktopNotificationPreferences] = await Promise.all([
    readDashboardShortcut(desktopPreferencesFile()),
    readDesktopNotificationPreferences(desktopPreferencesFile()),
  ]);
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

/** The running server's line to AgentUse Cloud, or undefined when no server answers. */
async function cloudApiState(server: RegisteredServer | undefined): Promise<CloudApiState | undefined> {
  if (!server) return undefined;
  try {
    const response = await fetch(`${serverUrl(server)}/api/cloud`, {
      headers: dashboardApiKey ? { Authorization: `Bearer ${dashboardApiKey}` } : {},
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok ? await response.json() as CloudApiState : undefined;
  } catch {
    return undefined;
  }
}

function savedCloudConnection() {
  try {
    const saved = readCloudConnection();
    return saved && { name: saved.name, mcpUrl: saved.mcpUrl, ...(saved.account && { account: saved.account }) };
  } catch {
    return undefined;
  }
}

async function desktopSettingsState() {
  // Swift refreshes every second on a serial command queue. Keep a slow or
  // restarting backend off that queue; reconciliation publishes its own result.
  void refreshExternalServerConnection().catch((error: unknown) => {
    console.warn("Could not refresh the external AgentUse connection:", error);
  });
  const activeServer = currentServer && listRegisteredServers().find((server) => server.pid === currentServer?.pid);
  const api = await cloudApiState(activeServer);
  const saved = savedCloudConnection();
  const cloud = cloudSettingsState({
    ...(api && { api }),
    ...(saved && { saved }),
    ...cloudConnector.view,
  });
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const cli = inspectCliAvailability(
    defaultCliLinkPath(),
    packagedCliLauncherPath(process.resourcesPath),
    await resolveUserLoginPath(),
  );
  const commonState = {
    launchAtLogin,
    notificationApprovals: desktopNotificationPreferences.approvals,
    notificationSessions: desktopNotificationPreferences.sessions,
    dashboardShortcut,
    ...(dashboardShortcutError && { dashboardShortcutError }),
    cliStatus: cli.status,
    cliTitle: cli.title,
    cliDetail: displayHomePath(cli.detail),
    cliActionLabel: cli.actionLabel,
    cliActionDisabled: cli.actionDisabled,
    cliCommands: cli.commands.map(displayHomePath),
    ...cloud,
    ...desktopUpdateSettingsState(),
  };
  if (serverOperation === "starting") {
    return {
      status: "starting" as const,
      title: disconnectedExternalServer ? "Waiting for external server…" : "Starting server…",
      detail: disconnectedExternalServer ? `Waiting for your server at ${serverUrl(disconnectedExternalServer)}.` : "Preparing the local AgentUse dashboard.",
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
      title: disconnectedExternalServer ? "External server unavailable" : "Server stopped",
      detail: disconnectedExternalServer ? "Waiting for your external server. Start Server lets Desktop replace it." : "Start the server to use the local dashboard and schedules.",
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

function desktopUpdateSettingsState() {
  const state: DesktopUpdateState = desktopUpdater?.state ?? {
    status: "unavailable",
    currentVersion: app.getVersion(),
    detail: "Update checks are not ready yet.",
    actionLabel: "Check for Updates",
    actionDisabled: true,
  };
  return {
    updateStatus: state.status,
    updateCurrentVersion: state.currentVersion,
    ...(state.availableVersion && { updateAvailableVersion: state.availableVersion }),
    ...(state.progress !== undefined && { updateProgress: state.progress }),
    updateDetail: state.detail,
    updateActionLabel: state.actionLabel,
    updateActionDisabled: state.actionDisabled,
  };
}

function initializeDesktopUpdater(): void {
  desktopUpdater = new DesktopUpdater(autoUpdater, {
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
    beforeInstall: async () => {
      // Squirrel's macOS updater closes BrowserWindows before it emits
      // `before-quit`. Drain the supervised server first, then authorize an
      // uninterrupted native quit so window close guards cannot hide the app
      // or cancel ShipIt's installation transaction.
      await stopOwnedServerCleanly();
      quitPolicy.requestNativeUpdaterQuit();
      isQuitting = true;
      sendNativeSettingsMessage({ type: "quit" });
      if (approvalPollTimer) {
        clearInterval(approvalPollTimer);
        approvalPollTimer = undefined;
      }
      stopNotificationStream();
    },
    onUpdateReady: async (version) => {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "AgentUse update ready",
        message: `AgentUse ${version} is ready to install.`,
        detail: "Restart AgentUse now to apply the update, or continue working and restart later.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) await desktopUpdater?.installUpdate();
    },
    onStateChange: () => void pushNativeSettingsState(),
  });

  // Packaged macOS clients check shortly after launch, every six hours while
  // running, and after a sufficiently long sleep. Jitter avoids release-time
  // request spikes; installation still requires an explicit restart decision.
  if (app.isPackaged && process.platform === "darwin") {
    desktopUpdateScheduler = new DesktopUpdateScheduler(() => desktopUpdater!.checkForUpdates());
    desktopUpdateScheduler.start();
    powerMonitor.on("resume", () => desktopUpdateScheduler?.handleResume());
  }
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
    // This is the explicit escape hatch after an externally managed daemon has
    // been intentionally retired. Background reconnects never take its port.
    currentServer = undefined;
    dashboardUrl = undefined;
    dashboardApiKey = undefined;
    stopNotificationStream();
    await ensureServer(true);
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

function dashboardNavigationState(): { canGoBack: boolean; canGoForward: boolean } {
  const history = activeNavigationHistory();
  return {
    canGoBack: history?.canGoBack() ?? false,
    canGoForward: history?.canGoForward() ?? false,
  };
}

function broadcastNavigationState(): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send("agentuse:desktop:navigation-state", dashboardNavigationState());
}

async function showDashboardPath(path: string): Promise<void> {
  if (!dashboardUrl) await ensureServer();
  await showDashboard(new URL(path, dashboardUrl!).toString());
}

const navigationCommands: NavigationCommands = {
  open: (path) => void showDashboardPath(path),
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

// Bound in the Edit menu so ⌘⇧C reaches the page even while a native menu
// owns the key; the page's CopyLinkToast does the copy and shows the notice.
const shareCommands: ShareCommands = {
  copyPageLink: () => {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    void window.webContents.executeJavaScript("window.dispatchEvent(new Event('agentuse:copy-page-link'))");
  },
};

function toggleDashboardSidebar(): void {
  if (window && !window.isDestroyed() && window.isVisible()) {
    void window.webContents.executeJavaScript("window.dispatchEvent(new Event('agentuse:toggle-sidebar'))");
    return;
  }
  void showDashboard().then(() => window?.webContents.executeJavaScript(
    "window.dispatchEvent(new Event('agentuse:toggle-sidebar'))"
  ));
}

const viewCommands: ViewCommands = {
  toggle: toggleDashboardSidebar,
  reload: () => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.reload();
  },
};

function refreshTrayMenu(): void {
  trayMenu = Menu.buildFromTemplate(createTrayMenu({
    showDashboard: () => void openPrimaryWindow(),
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
        // Labelled here: the roles take app.name, the package name, which also
        // names the userData folder and so stays as it is.
        { role: "about", label: `About ${APP_NAME}` },
        { type: "separator" },
        { label: "Settings…", accelerator: "Command+,", click: showSettings },
        { type: "separator" },
        { role: "hide", label: `Hide ${APP_NAME}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit AgentUse", accelerator: "Command+Q", click: () => app.quit() },
      ],
    },
    createEditMenu(findCommands, shareCommands),
    createViewMenu(viewCommands),
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
  app.on("second-instance", () => void openPrimaryWindow());
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
    if (serverConnectionTimer) clearInterval(serverConnectionTimer);
    stopNotificationStream();
    // electron-updater/Squirrel must own this quit from start to finish. Its
    // transaction was prepared above, including draining the owned server, so
    // preventing this event would leave ShipIt waiting for a process that can
    // no longer complete the native updater's original quit request.
    if (quitPolicy.isNativeUpdaterQuit()) return;
    if (quitInProgress) return;
    event.preventDefault();
    void deferDesktopQuitAfterDrain(stopOwnedServerCleanly, () => {
      quitInProgress = true;
      app.quit();
    });
  });
  app.on("activate", () => void openPrimaryWindow());
  app.whenReady().then(async () => {
    // Finder-launched apps do not inherit shell setup. Load the same AgentUse
    // global .env and config.json env block as the CLI before any provider
    // status check, server authentication, or child-process construction.
    initializeDesktopGlobalDefaults();
    app.setAboutPanelOptions({ applicationName: APP_NAME });
    registerDesktopIpc();
    initializeDesktopUpdater();
    createTray();
    await initializeDesktopPreferences();
    const onboardingReady = await isDesktopOnboardingReady();
    startServerConnectionPolling();
    const hiddenLaunch = process.argv.includes("--hidden");
    queueDesktopTelemetry({
      event: "desktop_app_launched",
      launch_mode: hiddenLaunch ? "login_item_hidden" : "interactive",
      onboarding_complete: onboardingReady,
      login_item_enabled: app.getLoginItemSettings().openAtLogin,
    }, "mac_app");
    if (hiddenLaunch && onboardingReady) {
      // Login services have no guaranteed startup order. Keep the menu bar app
      // alive while PM2 (or another supervisor) brings its backend online.
      while (!isQuitting) {
        try {
          await ensureServer();
          break;
        } catch (error) {
          console.warn("Waiting for AgentUse backend at login:", error);
          refreshMenus();
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      if (isQuitting) return;
      await flushDesktopTelemetry();
      startApprovalPolling();
      startNotificationStream();
      refreshMenus();
      return;
    }
    await openPrimaryWindow();
    await flushDesktopTelemetry();
  }).catch((error: unknown) => {
    // Only shell setup (tray, IPC, preferences) lands here: without a menu-bar
    // shell there is nothing left to recover from, so quit.
    console.error("Could not open AgentUse desktop:", error);
    dialog.showErrorBox("AgentUse could not start", error instanceof Error ? error.message : String(error));
    requestFullQuit();
  });
}
