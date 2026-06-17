import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileWatcher } from "../src/watcher/file-watcher";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
});
