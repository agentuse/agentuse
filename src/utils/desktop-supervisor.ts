import { createReadStream, type ReadStream } from "fs";
import type { ProcessRef } from "./process-info";

export const DESKTOP_SUPERVISOR_ENV = "AGENTUSE_DESKTOP_SUPERVISOR";
export const DESKTOP_LIFETIME_FD_ENV = "AGENTUSE_DESKTOP_LIFETIME_FD";

export interface DesktopServerSupervisor extends ProcessRef {
  kind: "desktop";
  token: string;
}

export function parseDesktopServerSupervisor(value: string | undefined): DesktopServerSupervisor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<DesktopServerSupervisor>;
    if (parsed.kind !== "desktop" || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined;
    if (typeof parsed.token !== "string" || parsed.token.length < 16) return undefined;
    if (parsed.procStartedAt !== undefined && typeof parsed.procStartedAt !== "string") return undefined;
    return {
      kind: "desktop",
      pid: parsed.pid!,
      token: parsed.token,
      ...(parsed.procStartedAt && { procStartedAt: parsed.procStartedAt }),
    };
  } catch {
    return undefined;
  }
}

export function parseDesktopLifetimeFd(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const fd = Number(value);
  return Number.isInteger(fd) && fd >= 3 && fd <= 255 ? fd : undefined;
}

type LifetimeStream = Pick<ReadStream, "once" | "removeListener" | "resume" | "destroy">;

export function watchDesktopLifetime(
  fd: number | undefined,
  onDisconnect: () => void,
  open: (fd: number) => LifetimeStream = (lifetimeFd) => createReadStream("", { fd: lifetimeFd }),
): () => void {
  if (fd === undefined) return () => {};

  const stream = open(fd);
  let active = true;
  const disconnected = () => {
    if (!active) return;
    active = false;
    onDisconnect();
  };
  stream.once("end", disconnected);
  stream.once("error", disconnected);
  stream.resume();

  return () => {
    active = false;
    stream.removeListener("end", disconnected);
    stream.removeListener("error", disconnected);
    stream.destroy();
  };
}

export function createIdempotentShutdown(action: () => Promise<void>): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= action();
    return shutdown;
  };
}
