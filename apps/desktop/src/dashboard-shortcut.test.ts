import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dashboardShortcutAccelerator,
  DEFAULT_DASHBOARD_SHORTCUT,
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  normalizeDashboardShortcut,
  readDashboardShortcut,
  readDesktopNotificationPreferences,
  writeDesktopNotificationPreference,
  writeDashboardShortcut,
} from "./dashboard-shortcut";

describe("dashboard shortcut", () => {
  it("normalizes modifiers and treats Hyper as a first-class modifier", () => {
    expect(normalizeDashboardShortcut("Shift+Command+A")).toBe("Command+Shift+A");
    expect(normalizeDashboardShortcut("Hyper+P")).toBe("Hyper+P");
    expect(normalizeDashboardShortcut("Hyper+Shift+P")).toBeUndefined();
    expect(normalizeDashboardShortcut("A")).toBeUndefined();
    expect(normalizeDashboardShortcut("Command+💥")).toBeUndefined();
  });

  it("expands Hyper into Electron's physical modifiers", () => {
    expect(dashboardShortcutAccelerator("Hyper+A")).toBe("Control+Alt+Command+Shift+A");
    expect(dashboardShortcutAccelerator("Command+Option+Space")).toBe("Command+Alt+Space");
  });

  it("defaults safely and persists an explicit shortcut or disabled state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentuse-shortcut-"));
    const path = join(directory, "desktop-preferences.json");
    try {
      expect(DEFAULT_DASHBOARD_SHORTCUT).toBeNull();
      expect(await readDashboardShortcut(path)).toBeNull();
      await writeDashboardShortcut(path, "Hyper+P");
      expect(await readDashboardShortcut(path)).toBe("Hyper+P");
      expect(JSON.parse(readFileSync(path, "utf8")).dashboardShortcut).toBe("Hyper+P");
      await writeDashboardShortcut(path, null);
      expect(await readDashboardShortcut(path)).toBeNull();
      writeFileSync(path, "not json");
      expect(await readDashboardShortcut(path)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists native notification choices without overwriting the shortcut", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentuse-notifications-"));
    const path = join(directory, "desktop-preferences.json");
    try {
      expect(await readDesktopNotificationPreferences(path)).toEqual(DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES);
      await writeDashboardShortcut(path, "Command+Shift+A");
      await writeDesktopNotificationPreference(path, "approvals", false);
      expect(await readDesktopNotificationPreferences(path)).toEqual({ approvals: false, sessions: true });
      expect(await readDashboardShortcut(path)).toBe("Command+Shift+A");

      await writeDashboardShortcut(path, null);
      expect(await readDesktopNotificationPreferences(path)).toEqual({ approvals: false, sessions: true });
      await writeDesktopNotificationPreference(path, "sessions", false);
      expect(await readDesktopNotificationPreferences(path)).toEqual({ approvals: false, sessions: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
