import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExternalServerTarget, writeExternalServerTarget } from "./external-server-state";
import { reconnectCandidates, serverAcquisitionMode } from "./runtime";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), "agentuse-external-"));
  directories.push(directory);
  return join(directory, "external-server.json");
}
const target = { host: "127.0.0.1", port: 12233, projectRoot: "/project" };

describe("external server ownership across desktop launches", () => {
  it("preserves ownership through an empty registry and attaches to a new PID after reboot", async () => {
    const path = await statePath();
    await writeExternalServerTarget(path, "/registry", { ...target, pid: 123 } as typeof target);
    const restored = await readExternalServerTarget(path, "/registry");
    expect(restored).toEqual(target);
    expect(await readFile(path, "utf8")).not.toContain("pid");
    expect(serverAcquisitionMode(restored)).toBe("reconnect-external");
    expect(reconnectCandidates([], restored!)).toEqual([]);
    const restarted = { ...target, pid: 456, version: "1", startTime: 100 };
    expect(reconnectCandidates([restarted], restored!)).toEqual([restarted]);
  });

  it("does not reuse another data profile's external backend", async () => {
    const path = await statePath();
    await writeExternalServerTarget(path, "/registry-a", target);
    expect(await readExternalServerTarget(path, "/registry-b")).toBeUndefined();
  });

  it("clears remembered ownership when Desktop replaces the external server", async () => {
    const path = await statePath();
    await writeExternalServerTarget(path, "/registry", target);
    expect(serverAcquisitionMode(target, true)).toBe("start-owned");
    await writeExternalServerTarget(path, "/registry");
    expect(await readExternalServerTarget(path, "/registry")).toBeUndefined();
  });

  it("ignores missing, corrupt, and non-local targets", async () => {
    const path = await statePath();
    expect(await readExternalServerTarget(path, "/registry")).toBeUndefined();
    for (const value of ["{", JSON.stringify({ registry: "/registry", target: { ...target, host: "example.com" } })]) {
      await writeFile(path, value);
      expect(await readExternalServerTarget(path, "/registry")).toBeUndefined();
    }
  });
});
