import type { DesktopUpdateCheckResult } from "./updater";

export const DESKTOP_UPDATE_STARTUP_DELAY_MS = 30_000;
export const DESKTOP_UPDATE_STARTUP_JITTER_MS = 30_000;
export const DESKTOP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DESKTOP_UPDATE_INTERVAL_JITTER_MS = 5 * 60 * 1000;
export const DESKTOP_UPDATE_RETRY_DELAY_MS = 15 * 60 * 1000;

interface DesktopUpdateSchedulerOptions {
  now?: () => number;
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/**
 * Keeps update traffic detached from launch, de-synchronizes installed clients,
 * and ensures there is never more than one scheduled check in flight.
 */
export class DesktopUpdateScheduler {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | undefined;
  private lastCheckStartedAt: number | undefined;
  private checkInFlight = false;
  private failureCount = 0;
  private stopped = true;

  constructor(
    private readonly checkForUpdates: () => Promise<DesktopUpdateCheckResult>,
    options: DesktopUpdateSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.now();
    this.schedule(DESKTOP_UPDATE_STARTUP_DELAY_MS + this.random() * DESKTOP_UPDATE_STARTUP_JITTER_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Manual checks bypass the time throttle but retain single-flight safety. */
  async checkNow(): Promise<void> {
    await this.runCheck();
  }

  /** Recheck after wake only when the normal six-hour window has elapsed. */
  handleResume(): void {
    if (this.stopped || this.checkInFlight) return;
    const lastActivityAt = this.lastCheckStartedAt ?? this.startedAt;
    if (lastActivityAt !== undefined && this.now() - lastActivityAt < DESKTOP_UPDATE_INTERVAL_MS) return;
    void this.runCheck();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.runCheck();
    }, Math.max(0, Math.round(delayMs)));
    this.timer.unref?.();
  }

  private async runCheck(): Promise<void> {
    if (this.stopped || this.checkInFlight) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.checkInFlight = true;
    this.lastCheckStartedAt = this.now();

    let result: DesktopUpdateCheckResult = "failed";
    try {
      result = await this.checkForUpdates();
    } catch {
      result = "failed";
    } finally {
      this.checkInFlight = false;
    }

    if (result === "failed") {
      this.failureCount += 1;
      const retryDelay = Math.min(
        DESKTOP_UPDATE_RETRY_DELAY_MS * (2 ** (this.failureCount - 1)),
        DESKTOP_UPDATE_INTERVAL_MS,
      );
      this.schedule(retryDelay + this.random() * DESKTOP_UPDATE_INTERVAL_JITTER_MS);
      return;
    }

    this.failureCount = 0;
    const jitter = (this.random() * 2 - 1) * DESKTOP_UPDATE_INTERVAL_JITTER_MS;
    this.schedule(DESKTOP_UPDATE_INTERVAL_MS + jitter);
  }
}
