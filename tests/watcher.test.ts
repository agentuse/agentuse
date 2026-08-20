import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileWatcher, scanAgentFiles } from "../src/watcher/file-watcher";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function waitForEvent(events: string[], expected: string, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (events.includes(expected)) return;
    await delay(50);
  }
  expect(events).toContain(expected);
}

describe("FileWatcher", () => {
  it("hot-reloads added, changed, and removed .agentuse files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-watcher-"));
    fs.mkdirSync(path.join(tmpDir, "nested"));

    const events: string[] = [];
    const watcher = new FileWatcher({
      projectRoot: tmpDir,
      envFile: path.join(tmpDir, ".env"),
      agentScanIntervalMs: 200,
      onAgentAdded: async (relativePath) => {
        events.push(`add:${relativePath}`);
      },
      onAgentChanged: async (relativePath) => {
        events.push(`change:${relativePath}`);
      },
      onAgentRemoved: (relativePath) => {
        events.push(`unlink:${relativePath}`);
      },
      onEnvReloaded: () => {
        events.push("env");
      },
    });

    try {
      watcher.start();
      await delay(800);

      const agentPath = path.join(tmpDir, "nested", "hot.agentuse");
      fs.writeFileSync(agentPath, "---\nname: Hot\nmodel: anthropic:claude-haiku-4-5\n---\n");
      await waitForEvent(events, "add:nested/hot.agentuse");

      fs.appendFileSync(agentPath, "\nchanged\n");
      await waitForEvent(events, "change:nested/hot.agentuse");

      fs.unlinkSync(agentPath);
      await waitForEvent(events, "unlink:nested/hot.agentuse");
    } finally {
      await watcher.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not overlap periodic agent scans when a scan is slow", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-watcher-overlap-"));
    let activeScans = 0;
    let maxActiveScans = 0;
    let scanCount = 0;

    const watcher = new FileWatcher({
      projectRoot: tmpDir,
      envFile: path.join(tmpDir, ".env"),
      agentScanIntervalMs: 50,
      onAgentAdded: async () => {},
      onAgentChanged: async () => {},
      onAgentRemoved: () => {},
      onEnvReloaded: () => {},
    });

    (watcher as unknown as { listAgentFiles: (watchRoot: string) => Promise<string[]> }).listAgentFiles = async () => {
      activeScans++;
      scanCount++;
      maxActiveScans = Math.max(maxActiveScans, activeScans);
      await delay(150);
      activeScans--;
      return [];
    };

    try {
      watcher.start();
      await delay(500);

      expect(scanCount).toBeGreaterThan(1);
      expect(maxActiveScans).toBe(1);
    } finally {
      await watcher.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("backs off the scan cadence after consecutive quiet scans and resets on a diff", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-watcher-backoff-"));
    const fastMs = 60;
    // The backoff ceiling is 4x the fast cadence, so a stretched gap is >= 240ms
    // and a fast one <= ~60ms. 150ms separates them with room for jitter.
    const stretchedThresholdMs = 150;

    const scanTimes: number[] = [];
    let scanResult: string[] = [];

    const watcher = new FileWatcher({
      projectRoot: tmpDir,
      envFile: path.join(tmpDir, ".env"),
      agentScanIntervalMs: fastMs,
      onAgentAdded: async () => {},
      onAgentChanged: async () => {},
      onAgentRemoved: () => {},
      onEnvReloaded: () => {},
    });

    (watcher as unknown as { listAgentFiles: () => Promise<string[]> }).listAgentFiles = async () => {
      scanTimes.push(Date.now());
      return [...scanResult];
    };

    const gapBefore = (index: number) => scanTimes[index]! - scanTimes[index - 1]!;

    try {
      watcher.start();

      // Scans 1-4 all find nothing, so the 4th trips the backoff and scan 5
      // lands a stretched interval later.
      await waitFor(() => scanTimes.length >= 5);
      expect(gapBefore(1)).toBeLessThan(stretchedThresholdMs);
      expect(gapBefore(2)).toBeLessThan(stretchedThresholdMs);
      expect(gapBefore(3)).toBeLessThan(stretchedThresholdMs);
      expect(gapBefore(4)).toBeGreaterThanOrEqual(stretchedThresholdMs);

      // A diff on the next scan drops straight back to the fast cadence.
      const quietScans = scanTimes.length;
      scanResult = ["found.agentuse"];
      await waitFor(() => scanTimes.length >= quietScans + 2);
      expect(gapBefore(quietScans + 1)).toBeLessThan(stretchedThresholdMs);
    } finally {
      await watcher.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reschedules a pending backed-off scan when a watched agent changes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-watcher-reset-"));
    const scanTimes: number[] = [];

    const watcher = new FileWatcher({
      projectRoot: tmpDir,
      envFile: path.join(tmpDir, ".env"),
      agentScanIntervalMs: 60,
      onAgentAdded: async () => {},
      onAgentChanged: async () => {},
      onAgentRemoved: () => {},
      onEnvReloaded: () => {},
    });

    (watcher as unknown as { listAgentFiles: () => Promise<string[]> }).listAgentFiles = async () => {
      scanTimes.push(Date.now());
      return [];
    };

    try {
      watcher.start();
      await waitFor(() => scanTimes.length >= 5);

      // The pending timer is now a 240ms one. A change event should cancel it
      // and re-arm at the fast cadence instead of leaving the daemon idle.
      const resetAt = Date.now();
      (watcher as unknown as { resetScanCadence: () => void }).resetScanCadence();
      const before = scanTimes.length;
      await waitFor(() => scanTimes.length > before);
      expect(scanTimes[before]! - resetAt).toBeLessThan(150);
    } finally {
      await watcher.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanAgentFiles", () => {
  it("finds nested agents and prunes ignored and dot directories at any depth", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-scan-"));

    const write = (relativePath: string) => {
      const full = path.join(tmpDir, relativePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "---\nname: X\n---\n");
    };

    write("top.agentuse");
    write("nested/deep/deep.agentuse");
    write("nested/notes.md");
    write(".dot.agentuse");
    write("node_modules/pkg/bundled.agentuse");
    write("nested/node_modules/pkg/bundled.agentuse");
    write("dist/built.agentuse");
    write("nested/dist/built.agentuse");
    write(".hidden/hidden.agentuse");
    write("nested/.hidden/hidden.agentuse");
    write("nested/__pycache__/cached.agentuse");

    try {
      expect(await scanAgentFiles(tmpDir)).toEqual(["nested/deep/deep.agentuse", "top.agentuse"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for an unreadable root instead of throwing", async () => {
    expect(await scanAgentFiles(path.join(os.tmpdir(), "agentuse-scan-does-not-exist"))).toEqual([]);
  });
});
