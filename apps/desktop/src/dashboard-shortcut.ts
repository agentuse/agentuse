import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_DASHBOARD_SHORTCUT = null;
export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES = Object.freeze({
  approvals: true,
  sessions: true,
});

export type DesktopNotificationCategory = keyof typeof DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES;
export type DesktopNotificationPreferences = Record<DesktopNotificationCategory, boolean>;

const MODIFIER_ORDER = ["Command", "Control", "Option", "Shift"] as const;
const MODIFIERS = new Set<string>([...MODIFIER_ORDER, "Hyper"]);
const NAMED_KEYS = new Set([
  "Space",
  "Return",
  "Tab",
  "Left",
  "Right",
  "Up",
  "Down",
  ...Array.from({ length: 20 }, (_, index) => `F${index + 1}`),
]);

interface DesktopPreferences {
  version: 1;
  dashboardShortcut: string | null;
  notifications: DesktopNotificationPreferences;
}

export function desktopPreferencesPath(userDataDirectory: string): string {
  return join(userDataDirectory, "desktop-preferences.json");
}

export function normalizeDashboardShortcut(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (!/^[A-Z0-9]$/.test(key) && !NAMED_KEYS.has(key)) return undefined;
  if (new Set(modifiers).size !== modifiers.length || modifiers.some((modifier) => !MODIFIERS.has(modifier))) {
    return undefined;
  }
  if (modifiers.includes("Hyper")) return modifiers.length === 1 ? `Hyper+${key}` : undefined;
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return ordered.length > 0 ? `${ordered.join("+")}+${key}` : undefined;
}

export function dashboardShortcutAccelerator(shortcut: string): string {
  const normalized = normalizeDashboardShortcut(shortcut);
  if (!normalized) throw new TypeError(`Invalid dashboard shortcut: ${shortcut}`);
  return normalized.startsWith("Hyper+")
    ? `Control+Alt+Command+Shift+${normalized.slice("Hyper+".length)}`
    : normalized.replaceAll("Option", "Alt");
}

export async function readDashboardShortcut(path: string): Promise<string | null> {
  return (await readDesktopPreferences(path)).dashboardShortcut;
}

export async function writeDashboardShortcut(path: string, shortcut: string | null): Promise<void> {
  const normalized = normalizeDashboardShortcut(shortcut);
  if (normalized === undefined) throw new TypeError("Dashboard shortcut is invalid.");
  const preferences = await readDesktopPreferences(path);
  await writeDesktopPreferences(path, { ...preferences, dashboardShortcut: normalized });
}

export async function readDesktopNotificationPreferences(path: string): Promise<DesktopNotificationPreferences> {
  return (await readDesktopPreferences(path)).notifications;
}

export async function writeDesktopNotificationPreference(
  path: string,
  category: DesktopNotificationCategory,
  enabled: boolean,
): Promise<void> {
  const preferences = await readDesktopPreferences(path);
  await writeDesktopPreferences(path, {
    ...preferences,
    notifications: { ...preferences.notifications, [category]: enabled },
  });
}

async function readDesktopPreferences(path: string): Promise<DesktopPreferences> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const normalizedShortcut = normalizeDashboardShortcut(stored.dashboardShortcut);
    const notifications = stored.notifications && typeof stored.notifications === "object"
      ? stored.notifications as Record<string, unknown>
      : {};
    return {
      version: 1,
      dashboardShortcut: normalizedShortcut === undefined ? DEFAULT_DASHBOARD_SHORTCUT : normalizedShortcut,
      notifications: {
        approvals: typeof notifications.approvals === "boolean"
          ? notifications.approvals
          : DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES.approvals,
        sessions: typeof notifications.sessions === "boolean"
          ? notifications.sessions
          : DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES.sessions,
      },
    };
  } catch {
    return {
      version: 1,
      dashboardShortcut: DEFAULT_DASHBOARD_SHORTCUT,
      notifications: { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES },
    };
  }
}

async function writeDesktopPreferences(path: string, preferences: DesktopPreferences): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
