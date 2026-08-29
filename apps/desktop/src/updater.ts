export type DesktopUpdateStatus =
  | "unavailable"
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  detail: string;
  actionLabel: "Check for Updates" | "Download Update" | "Restart and Install";
  actionDisabled: boolean;
}

interface UpdateInfo {
  version: string;
}

interface DownloadProgress {
  percent: number;
}

export interface DesktopAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: DownloadProgress) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface DesktopUpdaterOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  currentVersion: string;
  beforeInstall?: () => void | Promise<void>;
  onStateChange?: (state: DesktopUpdateState) => void;
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "The update service could not be reached.";
}

export class DesktopUpdater {
  private readonly enabled: boolean;
  private installInProgress = false;
  private stateValue: DesktopUpdateState;

  constructor(
    private readonly autoUpdater: DesktopAutoUpdater,
    private readonly options: DesktopUpdaterOptions,
  ) {
    this.enabled = options.isPackaged && options.platform === "darwin";
    this.stateValue = this.enabled
      ? {
          status: "idle",
          currentVersion: options.currentVersion,
          detail: "Updates are delivered through AgentUse GitHub Releases.",
          actionLabel: "Check for Updates",
          actionDisabled: false,
        }
      : {
          status: "unavailable",
          currentVersion: options.currentVersion,
          detail: options.platform === "darwin"
            ? "Update checks are available in packaged builds."
            : "Automatic updates are available in the macOS app.",
          actionLabel: "Check for Updates",
          actionDisabled: true,
        };

    if (!this.enabled) return;

    // A check may discover an update, but download and installation always
    // require separate user actions in Settings.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => this.setState({
      status: "checking",
      detail: "Checking GitHub Releases…",
      actionLabel: "Check for Updates",
      actionDisabled: true,
    }));
    autoUpdater.on("update-available", (info) => this.setState({
      status: "available",
      availableVersion: info.version,
      detail: `AgentUse ${info.version} is available. Download it when you are ready.`,
      actionLabel: "Download Update",
      actionDisabled: false,
    }));
    autoUpdater.on("update-not-available", () => this.setState({
      status: "upToDate",
      availableVersion: undefined,
      progress: undefined,
      detail: `AgentUse ${options.currentVersion} is up to date.`,
      actionLabel: "Check for Updates",
      actionDisabled: false,
    }));
    autoUpdater.on("download-progress", (progress) => this.setState({
      status: "downloading",
      progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
      detail: `Downloading update… ${Math.max(0, Math.min(100, Math.round(progress.percent)))}%`,
      actionLabel: "Download Update",
      actionDisabled: true,
    }));
    autoUpdater.on("update-downloaded", (info) => this.setState({
      status: "ready",
      availableVersion: info.version,
      progress: 100,
      detail: `AgentUse ${info.version} is ready. Restart to install it.`,
      actionLabel: "Restart and Install",
      actionDisabled: false,
    }));
    autoUpdater.on("error", (error) => this.setError(error));
  }

  get state(): DesktopUpdateState {
    return { ...this.stateValue };
  }

  async checkForUpdates(): Promise<void> {
    if (!this.enabled || this.stateValue.status === "checking" || this.stateValue.status === "downloading") return;
    this.setState({
      status: "checking",
      detail: "Checking GitHub Releases…",
      actionLabel: "Check for Updates",
      actionDisabled: true,
    });
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.setError(error);
    }
  }

  async downloadUpdate(): Promise<void> {
    if (!this.enabled || this.stateValue.status !== "available") return;
    this.setState({
      status: "downloading",
      progress: 0,
      detail: "Starting download…",
      actionLabel: "Download Update",
      actionDisabled: true,
    });
    try {
      await this.autoUpdater.downloadUpdate();
    } catch (error) {
      this.setError(error);
    }
  }

  async installUpdate(): Promise<void> {
    if (!this.enabled || this.stateValue.status !== "ready" || this.installInProgress) return;
    // This is called only from the explicit Restart and Install button.
    this.installInProgress = true;
    this.setState({
      status: "ready",
      availableVersion: this.stateValue.availableVersion,
      progress: 100,
      detail: "Preparing to restart…",
      actionLabel: "Restart and Install",
      actionDisabled: true,
    });
    try {
      // macOS Squirrel owns the quit transaction and cannot resume it after a
      // prevented `before-quit` event. Finish host shutdown work before asking
      // the native updater to close windows and replace the application.
      await this.options.beforeInstall?.();
      this.autoUpdater.quitAndInstall();
    } catch (error) {
      this.installInProgress = false;
      this.setError(error);
    }
  }

  private setError(error: unknown): void {
    this.setState({
      status: "error",
      detail: `Could not check for updates: ${errorDetail(error)}`,
      actionLabel: "Check for Updates",
      actionDisabled: false,
    });
  }

  private setState(update: Omit<DesktopUpdateState, "currentVersion">): void {
    this.stateValue = { currentVersion: this.options.currentVersion, ...update };
    this.options.onStateChange?.(this.state);
  }
}
