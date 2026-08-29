import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_DASHBOARD_SHORTCUT = null;

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
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as Partial<DesktopPreferences>;
    const normalized = normalizeDashboardShortcut(stored.dashboardShortcut);
    return normalized === undefined ? DEFAULT_DASHBOARD_SHORTCUT : normalized;
  } catch {
    return DEFAULT_DASHBOARD_SHORTCUT;
  }
}

export async function writeDashboardShortcut(path: string, shortcut: string | null): Promise<void> {
  const normalized = normalizeDashboardShortcut(shortcut);
  if (normalized === undefined) throw new TypeError("Dashboard shortcut is invalid.");
  const preferences: DesktopPreferences = { version: 1, dashboardShortcut: normalized };
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
