import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingDesktopOnboardingLaunchAtLoginDefault,
  desktopOnboardingStatePath,
  hasDesktopOnboardingAppliedLaunchAtLoginDefault,
  isDesktopOnboardingComplete,
  markDesktopOnboardingComplete,
} from "./onboarding-state";

describe("Desktop onboarding completion", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists completion and ignores corrupt or obsolete state", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentuse-desktop-onboarding-"));
    roots.push(root);
    const path = desktopOnboardingStatePath(root);

    expect(await isDesktopOnboardingComplete(path)).toBe(false);
    await markDesktopOnboardingComplete(path, new Date("2026-08-28T12:00:00.000Z"));
    expect(await isDesktopOnboardingComplete(path)).toBe(true);

    writeFileSync(path, '{"version":0,"completedAt":"2026-08-28T12:00:00.000Z"}');
    expect(await isDesktopOnboardingComplete(path)).toBe(false);
    writeFileSync(path, "not json");
    expect(await isDesktopOnboardingComplete(path)).toBe(false);
  });

  it("clears the pre-continue Launch at Login default left by older onboarding builds", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentuse-desktop-onboarding-default-"));
    roots.push(root);
    const path = desktopOnboardingStatePath(root);

    writeFileSync(path, '{"version":1,"launchAtLoginDefaultAppliedAt":"2026-08-28T11:00:00.000Z"}');
    expect(await hasDesktopOnboardingAppliedLaunchAtLoginDefault(path)).toBe(true);
    expect(await isDesktopOnboardingComplete(path)).toBe(false);
    expect(await clearPendingDesktopOnboardingLaunchAtLoginDefault(path)).toBe(true);
    expect(await hasDesktopOnboardingAppliedLaunchAtLoginDefault(path)).toBe(false);
    expect(await clearPendingDesktopOnboardingLaunchAtLoginDefault(path)).toBe(false);

    await markDesktopOnboardingComplete(path, new Date("2026-08-28T12:00:00.000Z"));
    expect(await isDesktopOnboardingComplete(path)).toBe(true);
  });
});
