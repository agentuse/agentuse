import { describe, expect, it } from "bun:test";
import {
  DESKTOP_UPDATE_INTERVAL_MS,
  DESKTOP_UPDATE_RETRY_DELAY_MS,
  DESKTOP_UPDATE_STARTUP_DELAY_MS,
  DesktopUpdateScheduler,
} from "./update-scheduler";
import type { DesktopUpdateCheckResult } from "./updater";

interface ScheduledTimer {
  callback: () => void;
  delay: number;
  cleared: boolean;
}

function createHarness(results: DesktopUpdateCheckResult[] = ["completed"]) {
  let now = 1_000;
  let checks = 0;
  const timers: ScheduledTimer[] = [];
  const scheduler = new DesktopUpdateScheduler(async () => {
    checks += 1;
    return results.shift() ?? "completed";
  }, {
    now: () => now,
    random: () => 0.5,
    setTimeout: ((callback: () => void, delay?: number) => {
      const timer = { callback, delay: delay ?? 0, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: ScheduledTimer) => { timer.cleared = true; }) as unknown as typeof clearTimeout,
  });

  const latestActiveTimer = () => [...timers].reverse().find((timer) => !timer.cleared);
  const fireLatestTimer = async () => {
    const timer = latestActiveTimer();
    if (!timer) throw new Error("No active timer");
    timer.cleared = true;
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    scheduler,
    get checks() { return checks; },
    latestActiveTimer,
    fireLatestTimer,
    advance(ms: number) { now += ms; },
  };
}

describe("desktop update scheduler", () => {
  it("checks after a jittered startup delay and then every six hours", async () => {
    const harness = createHarness();
    harness.scheduler.start();

    expect(harness.latestActiveTimer()?.delay).toBe(DESKTOP_UPDATE_STARTUP_DELAY_MS + 15_000);
    await harness.fireLatestTimer();
    expect(harness.checks).toBe(1);
    expect(harness.latestActiveTimer()?.delay).toBe(DESKTOP_UPDATE_INTERVAL_MS);
  });

  it("checks on resume only after the six-hour throttle expires", async () => {
    const harness = createHarness();
    harness.scheduler.start();
    harness.scheduler.handleResume();
    expect(harness.checks).toBe(0);

    harness.advance(DESKTOP_UPDATE_INTERVAL_MS);
    harness.scheduler.handleResume();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.checks).toBe(1);
  });

  it("backs off after failure and restores the normal cadence after recovery", async () => {
    const harness = createHarness(["failed", "completed"]);
    harness.scheduler.start();
    await harness.fireLatestTimer();
    expect(harness.latestActiveTimer()?.delay).toBe(DESKTOP_UPDATE_RETRY_DELAY_MS + 150_000);

    await harness.fireLatestTimer();
    expect(harness.checks).toBe(2);
    expect(harness.latestActiveTimer()?.delay).toBe(DESKTOP_UPDATE_INTERVAL_MS);
  });
});
