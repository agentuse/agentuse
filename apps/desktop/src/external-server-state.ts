import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isLocalServer, type RegisteredServer } from "./runtime";

export type ExternalServerTarget = Pick<RegisteredServer, "host" | "port" | "projectRoot">;

// Store only connection identity, never a PID or credentials from a previous boot.
export async function readExternalServerTarget(path: string, registry: string): Promise<ExternalServerTarget | undefined> {
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    const target = saved.target;
    if (saved.registry === registry && target && isLocalServer(target)
      && typeof target.projectRoot === "string" && target.projectRoot.length > 0) {
      return { host: target.host, port: target.port, projectRoot: target.projectRoot };
    }
  } catch {
    // Missing or invalid state follows normal server discovery.
  }
  return undefined;
}

export async function writeExternalServerTarget(path: string, registry: string, target?: ExternalServerTarget): Promise<void> {
  if (!target) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ registry, target: {
    host: target.host, port: target.port, projectRoot: target.projectRoot,
  } }), { mode: 0o600 });
  await rename(temporary, path);
}
