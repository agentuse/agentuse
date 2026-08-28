import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DESKTOP_ONBOARDING_VERSION = 1;

interface StoredDesktopOnboardingState {
  version: number;
  completedAt?: string;
  launchAtLoginDefaultAppliedAt?: string;
}

async function readDesktopOnboardingState(path: string): Promise<Partial<StoredDesktopOnboardingState> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<StoredDesktopOnboardingState>;
  } catch {
    return undefined;
  }
}

async function writeDesktopOnboardingState(path: string, state: StoredDesktopOnboardingState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function desktopOnboardingStatePath(userDataDirectory: string): string {
  return join(userDataDirectory, "desktop-onboarding.json");
}

export async function isDesktopOnboardingComplete(path: string): Promise<boolean> {
  const state = await readDesktopOnboardingState(path);
  return state?.version === DESKTOP_ONBOARDING_VERSION && typeof state.completedAt === "string";
}

export async function hasDesktopOnboardingAppliedLaunchAtLoginDefault(path: string): Promise<boolean> {
  const state = await readDesktopOnboardingState(path);
  return state?.version === DESKTOP_ONBOARDING_VERSION
    && typeof state.launchAtLoginDefaultAppliedAt === "string";
}

export async function clearPendingDesktopOnboardingLaunchAtLoginDefault(path: string): Promise<boolean> {
  const current = await readDesktopOnboardingState(path);
  if (current?.version !== DESKTOP_ONBOARDING_VERSION
    || typeof current.launchAtLoginDefaultAppliedAt !== "string"
    || typeof current.completedAt === "string") return false;

  await writeDesktopOnboardingState(path, {
    version: DESKTOP_ONBOARDING_VERSION,
  });
  return true;
}

export async function markDesktopOnboardingComplete(path: string, completedAt = new Date()): Promise<void> {
  const current = await readDesktopOnboardingState(path);
  await writeDesktopOnboardingState(path, {
    ...(current?.version === DESKTOP_ONBOARDING_VERSION ? current : {}),
    version: DESKTOP_ONBOARDING_VERSION,
    completedAt: completedAt.toISOString(),
  });
}
