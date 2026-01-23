import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import {
  registerServer,
  unregisterServer,
  listServers,
  updateServer,
  formatUptime,
  type ServerEntry,
} from "../src/utils/server-registry";

const REGISTRY_DIR = path.join(homedir(), ".agentuse", "servers");

describe("Server Registry", () => {
  // Clean up test entries before and after each test
  const cleanupTestEntries = () => {
    const currentPidFile = path.join(REGISTRY_DIR, `${process.pid}.json`);
    if (fs.existsSync(currentPidFile)) {
      fs.rmSync(currentPidFile);
    }
  };

  beforeEach(cleanupTestEntries);
  afterEach(cleanupTestEntries);

  describe("registerServer", () => {
    it("should create a registry file for the current process", () => {
      registerServer({
        port: 12345,
        host: "127.0.0.1",
        projectRoot: "/test/project",
        startTime: Date.now(),
        agentCount: 5,
        scheduleCount: 2,
        version: "1.0.0",
      });

      const entryPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
      expect(fs.existsSync(entryPath)).toBe(true);

      const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as ServerEntry;
      expect(entry.pid).toBe(process.pid);
      expect(entry.port).toBe(12345);
      expect(entry.host).toBe("127.0.0.1");
      expect(entry.projectRoot).toBe("/test/project");
      expect(entry.agentCount).toBe(5);
      expect(entry.scheduleCount).toBe(2);
      expect(entry.version).toBe("1.0.0");
    });
  });

  describe("unregisterServer", () => {
    it("should remove the registry file for the current process", () => {
      // First register
      registerServer({
        port: 12345,
        host: "127.0.0.1",
        projectRoot: "/test/project",
        startTime: Date.now(),
        agentCount: 5,
        scheduleCount: 2,
        version: "1.0.0",
      });

      const entryPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
      expect(fs.existsSync(entryPath)).toBe(true);

      // Then unregister
      unregisterServer();
      expect(fs.existsSync(entryPath)).toBe(false);
    });

    it("should not throw if file doesn't exist", () => {
      // Just make sure it doesn't throw
      expect(() => unregisterServer()).not.toThrow();
    });
  });

  describe("updateServer", () => {
    it("should update existing entry fields", () => {
      registerServer({
        port: 12345,
        host: "127.0.0.1",
        projectRoot: "/test/project",
        startTime: Date.now(),
        agentCount: 5,
        scheduleCount: 2,
        version: "1.0.0",
      });

      updateServer({ agentCount: 10, scheduleCount: 5 });

      const entryPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
      const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as ServerEntry;
      expect(entry.agentCount).toBe(10);
      expect(entry.scheduleCount).toBe(5);
      // Other fields should be unchanged
      expect(entry.port).toBe(12345);
    });

    it("should not throw if file doesn't exist", () => {
      expect(() => updateServer({ agentCount: 10 })).not.toThrow();
    });
  });

  describe("listServers", () => {
    it("should return the current process entry", () => {
      registerServer({
        port: 12345,
        host: "127.0.0.1",
        projectRoot: "/test/project",
        startTime: Date.now(),
        agentCount: 5,
        scheduleCount: 2,
        version: "1.0.0",
      });

      const servers = listServers();
      const currentServer = servers.find((s) => s.pid === process.pid);

      expect(currentServer).toBeDefined();
      expect(currentServer!.port).toBe(12345);
    });

    it("should clean up stale entries", () => {
      // Create a fake stale entry with a non-existent PID
      const fakePid = 999999999; // Very unlikely to be a real PID
      const fakeEntryPath = path.join(REGISTRY_DIR, `${fakePid}.json`);

      // Ensure directory exists
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });

      // Write a fake entry
      fs.writeFileSync(
        fakeEntryPath,
        JSON.stringify({
          pid: fakePid,
          port: 99999,
          host: "127.0.0.1",
          projectRoot: "/fake/project",
          startTime: Date.now(),
          agentCount: 1,
          scheduleCount: 0,
          version: "1.0.0",
        })
      );

      expect(fs.existsSync(fakeEntryPath)).toBe(true);

      // listServers should clean it up
      listServers();

      expect(fs.existsSync(fakeEntryPath)).toBe(false);
    });

    it("should return empty array when no servers running", () => {
      // Make sure our current process isn't registered
      unregisterServer();

      const servers = listServers();
      // Filter out any other real servers that might be running
      const testServers = servers.filter((s) => s.pid === process.pid);
      expect(testServers).toHaveLength(0);
    });
  });

  describe("formatUptime", () => {
    it("should format seconds correctly", () => {
      const now = Date.now();
      const startTime = now - 30 * 1000; // 30 seconds ago
      expect(formatUptime(startTime)).toBe("30s");
    });

    it("should format minutes and seconds", () => {
      const now = Date.now();
      const startTime = now - (5 * 60 + 30) * 1000; // 5 minutes 30 seconds ago
      expect(formatUptime(startTime)).toBe("5m 30s");
    });

    it("should format hours and minutes", () => {
      const now = Date.now();
      const startTime = now - (2 * 60 * 60 + 30 * 60) * 1000; // 2 hours 30 minutes ago
      expect(formatUptime(startTime)).toBe("2h 30m");
    });

    it("should format days and hours", () => {
      const now = Date.now();
      const startTime = now - (3 * 24 * 60 * 60 + 5 * 60 * 60) * 1000; // 3 days 5 hours ago
      expect(formatUptime(startTime)).toBe("3d 5h");
    });
  });
});
