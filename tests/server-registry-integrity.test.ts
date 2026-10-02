import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { findServerForProject, listServers, registerServer, unregisterServer, updateServer } from "../src/utils/server-registry";

const originalAgentuseDataDir = process.env.AGENTUSE_DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(tmpdir(), "agentuse-server-registry-integrity-"));
process.env.AGENTUSE_DATA_DIR = testDataDir;
const REGISTRY_DIR = path.join(testDataDir, "servers");
const DEAD_PID = 999999996;

const entry = (projectRoot: string) => ({
  port: 12345,
  host: "127.0.0.1",
  projectRoot,
  startTime: Date.now(),
  agentCount: 0,
  scheduleCount: 0,
  version: "1.0.0",
  projects: [{ id: "p", root: projectRoot, agentCount: 0, scheduleCount: 0 }],
});

describe("server registry integrity", () => {
  afterEach(() => {
    unregisterServer();
    fs.rmSync(path.join(REGISTRY_DIR, `${DEAD_PID}.json`), { force: true });
  });

  afterAll(() => {
    if (originalAgentuseDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = originalAgentuseDataDir;
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  it("keeps an unreadable entry whose daemon is still alive", () => {
    // What a reader sees mid-write if the entry is truncated in place.
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const livePath = path.join(REGISTRY_DIR, `${process.pid}.json`);
    fs.writeFileSync(livePath, '{"pid":');

    listServers();

    expect(fs.existsSync(livePath)).toBe(true);
  });

  it("removes an unreadable entry whose daemon is gone", () => {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const deadPath = path.join(REGISTRY_DIR, `${DEAD_PID}.json`);
    fs.writeFileSync(deadPath, '{"pid":');

    listServers();

    expect(fs.existsSync(deadPath)).toBe(false);
  });

  it("replaces the entry file instead of rewriting it in place", () => {
    registerServer(entry("/test/project"));
    const entryPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
    const registeredInode = fs.statSync(entryPath).ino;

    updateServer({ agentCount: 3 });
    const updatedInode = fs.statSync(entryPath).ino;

    expect(updatedInode).not.toBe(registeredInode);
    expect(JSON.parse(fs.readFileSync(entryPath, "utf-8")).agentCount).toBe(3);
    expect(fs.readdirSync(REGISTRY_DIR).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("matches a project nested in a directory whose name starts with two dots", () => {
    registerServer(entry("/test/project"));

    expect(findServerForProject("/test/project/..cache/sub")?.pid).toBe(process.pid);
  });
});
