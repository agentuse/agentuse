import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Tool } from "ai";
import { Store, createStore } from "../src/store/store";
import { createStoreTools } from "../src/store/tools";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Store", () => {
  let tempDir: string;
  let store: Store;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "store-test-"));
    store = new Store(tempDir, "test-store", "test-agent");
  });

  afterEach(async () => {
    await store.releaseLock();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("creates item with required fields", async () => {
      const item = await store.create({
        data: { message: "hello" },
      });

      expect(item.id).toBeDefined();
      expect(item.id.length).toBe(26); // ULID length
      expect(item.createdAt).toBeDefined();
      expect(item.updatedAt).toBeDefined();
      expect(item.data).toEqual({ message: "hello" });
    });

    it("creates item with all optional fields", async () => {
      const item = await store.create({
        type: "task",
        title: "Test Task",
        status: "pending",
        data: { priority: "high" },
        parentId: "parent-123",
        tags: ["urgent", "bug"],
      });

      expect(item.type).toBe("task");
      expect(item.title).toBe("Test Task");
      expect(item.status).toBe("pending");
      expect(item.parentId).toBe("parent-123");
      expect(item.tags).toEqual(["urgent", "bug"]);
    });

    it("sets createdBy to agent name", async () => {
      const item = await store.create({
        data: { test: true },
      });

      expect(item.createdBy).toBe("test-agent");
    });

    it("generates unique IDs", async () => {
      const item1 = await store.create({ data: { n: 1 } });
      const item2 = await store.create({ data: { n: 2 } });
      const item3 = await store.create({ data: { n: 3 } });

      expect(item1.id).not.toBe(item2.id);
      expect(item2.id).not.toBe(item3.id);
      expect(item1.id).not.toBe(item3.id);
    });

    it("parses a JSON string that decodes to an object", async () => {
      const item = await store.create({
        data: '{"foo":"bar","n":1}' as unknown as Record<string, unknown>,
      });

      expect(item.data).toEqual({ foo: "bar", n: 1 });
    });

    it("rejects a JSON string that decodes to an array", async () => {
      await expect(
        store.create({ data: '["a","b"]' as unknown as Record<string, unknown> })
      ).rejects.toThrow(/must be a plain object/);
    });

    it("rejects a non-JSON string", async () => {
      await expect(
        store.create({ data: "not json" as unknown as Record<string, unknown> })
      ).rejects.toThrow(/must be a plain object/);
    });

    it("rejects a raw array", async () => {
      await expect(
        store.create({ data: ["a", "b"] as unknown as Record<string, unknown> })
      ).rejects.toThrow(/must be a plain object/);
    });

    it("persists items to disk", async () => {
      await store.create({ data: { persisted: true } });

      const storePath = join(tempDir, ".agentuse", "store", "test-store", "items.json");
      expect(existsSync(storePath)).toBe(true);

      const content = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(content.version).toBe(1);
      expect(content.items).toHaveLength(1);
      expect(content.items[0].data.persisted).toBe(true);
    });
  });

  describe("get()", () => {
    it("retrieves item by ID", async () => {
      const created = await store.create({
        type: "task",
        data: { value: 42 },
      });

      const retrieved = await store.get(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.data.value).toBe(42);
    });

    it("returns null for non-existent ID", async () => {
      const retrieved = await store.get("nonexistent-id");

      expect(retrieved).toBeNull();
    });
  });

  describe("tools", () => {
    it("store_list defaults to summary projection without full data payloads", async () => {
      await store.create({
        type: "draft",
        title: "Large Draft",
        status: "pending",
        data: { body: "x".repeat(1000), score: 7 },
      });

      const tools = createStoreTools(store);
      const result = await (tools.store_list as any).execute({});

      expect(result.success).toBe(true);
      expect(result.items[0].data).toBeUndefined();
      expect(result.items[0].dataKeys).toEqual(["body", "score"]);
    });

    it("store_list can include selected data fields", async () => {
      await store.create({
        type: "draft",
        title: "Scored Draft",
        data: { body: "x".repeat(1000), score: 7 },
      });

      const tools = createStoreTools(store);
      const result = await (tools.store_list as any).execute({ fields: ["score"] });

      expect(result.items[0].data).toEqual({ score: 7 });
      expect(result.items[0].dataKeys).toEqual(["body", "score"]);
    });
  });

  describe("update()", () => {
    it("updates item fields", async () => {
      const created = await store.create({
        type: "task",
        status: "pending",
        data: { count: 0 },
      });

      const updated = await store.update(created.id, {
        status: "done",
      });

      expect(updated?.status).toBe("done");
      expect(updated?.type).toBe("task"); // Unchanged
    });

    it("merges data field instead of replacing", async () => {
      const created = await store.create({
        data: { a: 1, b: 2 },
      });

      const updated = await store.update(created.id, {
        data: { b: 20, c: 3 },
      });

      expect(updated?.data).toEqual({ a: 1, b: 20, c: 3 });
    });

    it("parses a JSON string data payload and merges it", async () => {
      const created = await store.create({ data: { a: 1 } });

      const updated = await store.update(created.id, {
        data: '{"b":2}' as unknown as Record<string, unknown>,
      });

      expect(updated?.data).toEqual({ a: 1, b: 2 });
    });

    it("rejects a string data payload that is not a JSON object", async () => {
      const created = await store.create({ data: { a: 1 } });

      await expect(
        store.update(created.id, {
          data: "{" as unknown as Record<string, unknown>,
        })
      ).rejects.toThrow(/must be a plain object/);

      // Store is unchanged after the rejected update
      const after = await store.get(created.id);
      expect(after?.data).toEqual({ a: 1 });
    });

    it("rejects an array data payload", async () => {
      const created = await store.create({ data: { a: 1 } });

      await expect(
        store.update(created.id, {
          data: ["x"] as unknown as Record<string, unknown>,
        })
      ).rejects.toThrow(/must be a plain object/);
    });

    it("updates updatedAt timestamp", async () => {
      const created = await store.create({ data: {} });
      const originalUpdatedAt = created.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await store.update(created.id, {
        status: "modified",
      });

      expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
    });

    it("returns null for non-existent ID", async () => {
      const updated = await store.update("nonexistent-id", {
        status: "done",
      });

      expect(updated).toBeNull();
    });

    it("preserves createdAt timestamp", async () => {
      const created = await store.create({ data: {} });

      const updated = await store.update(created.id, {
        status: "done",
      });

      expect(updated?.createdAt).toBe(created.createdAt);
    });
  });

  describe("delete()", () => {
    it("removes item from store", async () => {
      const created = await store.create({ data: {} });

      const deleted = await store.delete(created.id);
      const retrieved = await store.get(created.id);

      expect(deleted).toBe(true);
      expect(retrieved).toBeNull();
    });

    it("returns false for non-existent ID", async () => {
      const deleted = await store.delete("nonexistent-id");

      expect(deleted).toBe(false);
    });
  });

  describe("list()", () => {
    beforeEach(async () => {
      // Create test items
      await store.create({ type: "task", status: "pending", data: { n: 1 }, tags: ["a"] });
      await store.create({ type: "task", status: "done", data: { n: 2 }, tags: ["b"] });
      await store.create({ type: "note", status: "pending", data: { n: 3 }, tags: ["a", "b"] });
    });

    it("lists all items when no filters", async () => {
      const items = await store.list();

      expect(items).toHaveLength(3);
    });

    it("filters by type", async () => {
      const tasks = await store.list({ type: "task" });

      expect(tasks).toHaveLength(2);
      expect(tasks.every((i) => i.type === "task")).toBe(true);
    });

    it("filters by status", async () => {
      const pending = await store.list({ status: "pending" });

      expect(pending).toHaveLength(2);
      expect(pending.every((i) => i.status === "pending")).toBe(true);
    });

    it("filters by tag", async () => {
      const tagA = await store.list({ tag: "a" });
      const tagB = await store.list({ tag: "b" });

      expect(tagA).toHaveLength(2);
      expect(tagB).toHaveLength(2);
    });

    it("combines multiple filters", async () => {
      const pendingTasks = await store.list({ type: "task", status: "pending" });

      expect(pendingTasks).toHaveLength(1);
      expect(pendingTasks[0].data.n).toBe(1);
    });

    it("filters by parentId", async () => {
      const parent = await store.create({ type: "parent", data: {} });
      await store.create({ type: "child", parentId: parent.id, data: { n: "c1" } });
      await store.create({ type: "child", parentId: parent.id, data: { n: "c2" } });

      const children = await store.list({ parentId: parent.id });

      expect(children).toHaveLength(2);
      expect(children.every((i) => i.parentId === parent.id)).toBe(true);
    });

    it("respects limit", async () => {
      const items = await store.list({ limit: 2 });

      expect(items).toHaveLength(2);
    });

    it("respects offset", async () => {
      const all = await store.list();
      const offset = await store.list({ offset: 1 });

      expect(offset).toHaveLength(2);
      expect(offset[0].id).toBe(all[1].id);
    });

    it("combines limit and offset for pagination", async () => {
      const page1 = await store.list({ limit: 1, offset: 0 });
      const page2 = await store.list({ limit: 1, offset: 1 });
      const page3 = await store.list({ limit: 1, offset: 2 });

      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page3).toHaveLength(1);
      expect(page1[0].id).not.toBe(page2[0].id);
      expect(page2[0].id).not.toBe(page3[0].id);
    });

    it("sorts by createdAt descending (newest first)", async () => {
      const items = await store.list();

      // Verify items are sorted by createdAt descending
      for (let i = 0; i < items.length - 1; i++) {
        expect(items[i].createdAt >= items[i + 1].createdAt).toBe(true);
      }
    });

    it("filters by ids", async () => {
      const all = await store.list();
      const wanted = [all[0].id, all[2].id];
      const subset = await store.list({ ids: wanted });

      expect(subset).toHaveLength(2);
      expect(subset.map((i) => i.id).sort()).toEqual([...wanted].sort());
    });

    it("filters by where on data keys", async () => {
      const matched = await store.list({ where: { n: 2 } });

      expect(matched).toHaveLength(1);
      expect(matched[0].data.n).toBe(2);
    });

    it("where matches string form of numeric/boolean data", async () => {
      await store.create({ type: "flag", data: { active: true, count: 5 } });

      const byBool = await store.list({ where: { active: "true" } });
      const byNum = await store.list({ where: { count: "5" } });

      expect(byBool).toHaveLength(1);
      expect(byNum).toHaveLength(1);
    });

    it("searches with q across title and data", async () => {
      await store.create({ title: "Find the needle", data: { body: "nothing here" } });
      await store.create({ data: { body: "a needle hides in data" } });

      const hits = await store.list({ q: "needle" });

      expect(hits).toHaveLength(2);
    });
  });

  describe("query()", () => {
    beforeEach(async () => {
      await store.create({ type: "task", data: { n: 1 } });
      await store.create({ type: "task", data: { n: 2 } });
      await store.create({ type: "note", data: { n: 3 } });
    });

    it("returns total matching filters regardless of limit", async () => {
      const result = await store.query({ type: "task", limit: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(2);
    });

    it("total reflects all items when unfiltered", async () => {
      const result = await store.query();

      expect(result.total).toBe(3);
    });
  });

  describe("getStoreName()", () => {
    it("returns the store name", () => {
      expect(store.getStoreName()).toBe("test-store");
    });
  });

  describe("getStorePath()", () => {
    it("returns the store file path", () => {
      const path = store.getStorePath();

      expect(path).toContain(".agentuse");
      expect(path).toContain("store");
      expect(path).toContain("test-store");
      expect(path).toContain("items.json");
    });
  });
});

describe("createStore()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "store-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates isolated store when config is true", () => {
    const store = createStore(tempDir, true, "my-agent");

    expect(store.getStoreName()).toBe("my-agent");
  });

  it("creates shared store when config is string", () => {
    const store = createStore(tempDir, "shared-store", "my-agent");

    expect(store.getStoreName()).toBe("shared-store");
  });

  it("allows nested isolated store names for path-based agent ids", () => {
    const store = createStore(tempDir, true, "agents/research");

    expect(store.getStoreName()).toBe("agents/research");
    expect(store.getStorePath()).toContain(join("agents", "research", "items.json"));
  });

  it("rejects shared store names that escape the store root", () => {
    expect(() => createStore(tempDir, "../outside", "my-agent")).toThrow(/Invalid store name/);
    expect(() => createStore(tempDir, "nested/../../outside", "my-agent")).toThrow(/Invalid store name/);
    expect(() => createStore(tempDir, String.raw`nested\outside`, "my-agent")).toThrow(/Invalid store name/);
  });

  it("rejects store paths that traverse symlinked store directories", () => {
    const outside = mkdtempSync(join(tmpdir(), "store-outside-"));
    mkdirSync(join(tempDir, ".agentuse", "store"), { recursive: true });
    symlinkSync(outside, join(tempDir, ".agentuse", "store", "linked"), "dir");

    expect(() => createStore(tempDir, "linked", "my-agent")).toThrow(/symbolic link/);
    expect(() => createStore(tempDir, "linked/nested", "my-agent")).toThrow(/symbolic link/);

    rmSync(outside, { recursive: true, force: true });
  });
});

describe("Store Locking", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "store-lock-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("releases the lock as soon as a write completes (per-op, not run-scoped)", async () => {
    const store = new Store(tempDir, "lock-test", "agent1");

    await store.create({ data: {} });

    // The lock is held only for the write, so it is already gone once create()
    // resolves - no run-scoped hold that could strand the store on a crash.
    const lockPath = join(tempDir, ".agentuse", "store", "lock-test", "lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("steals a stale lock even when its PID is still alive (leaked-in-worker case)", async () => {
    const { mkdirSync, writeFileSync } = require("fs");
    const lockDir = join(tempDir, ".agentuse", "store", "lock-test");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "lock");

    // A leaked lock from a long-lived process (PID 1 is always alive) with a
    // timestamp older than any single op could take. PID liveness says "valid"
    // forever; age says "abandoned".
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        agent: "errored-session",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
    );

    const store = new Store(tempDir, "lock-test", "fresh");
    await expect(store.create({ data: { ok: true } })).resolves.toBeDefined();
    await store.releaseLock();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes lock file on release", async () => {
    const store = new Store(tempDir, "lock-test", "agent1");

    await store.create({ data: {} });
    await store.releaseLock();

    const lockPath = join(tempDir, ".agentuse", "store", "lock-test", "lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("allows same process to reacquire lock", async () => {
    const store1 = new Store(tempDir, "lock-test", "agent1");
    await store1.create({ data: { from: "store1" } });
    await store1.releaseLock();

    const store2 = new Store(tempDir, "lock-test", "agent2");
    const item = await store2.create({ data: { from: "store2" } });

    expect(item.data.from).toBe("store2");
    await store2.releaseLock();
  });

  it("lets concurrent Store instances in one process interleave writes without lost updates", async () => {
    const store1 = new Store(tempDir, "lock-test", "manager");
    const store2 = new Store(tempDir, "lock-test", "subagent");
    const lockPath = join(tempDir, ".agentuse", "store", "lock-test", "lock");

    // Fire both writes at once. Per-op locking serializes the transactions, so
    // both items land - neither clobbers the other's snapshot.
    await Promise.all([
      store1.create({ data: { from: "manager" } }),
      store2.create({ data: { from: "subagent" } }),
    ]);

    const items = await store1.list();
    expect(items).toHaveLength(2);

    // The lock is not held between ops, so it is free once both writes finish.
    expect(existsSync(lockPath)).toBe(false);
  });

  // Regression: the serve worker handles requests concurrently, so multiple
  // Store instances acquire/release the same lock at the same time. The old
  // ref-count logic drifted under these interleavings and left the lock file
  // on disk with a live PID, permanently blocking every other process.
  it("releases the lock file after concurrent acquire/release cycles", async () => {
    const lockPath = join(tempDir, ".agentuse", "store", "lock-test", "lock");

    const cycle = async (i: number) => {
      const s = new Store(tempDir, "lock-test", `agent-${i}`);
      await s.create({ data: { i } });
      // Yield so cycles interleave across the await points in acquire/release.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await s.list();
      await s.releaseLock();
    };

    await Promise.all(Array.from({ length: 20 }, (_, i) => cycle(i)));

    // Once every concurrent holder has released, the lock file must be gone and
    // no phantom ref count may linger.
    expect(existsSync(lockPath)).toBe(false);

    // A fresh acquire must still succeed and not see itself as locked out.
    const after = new Store(tempDir, "lock-test", "after");
    await expect(after.create({ data: { ok: true } })).resolves.toBeDefined();
    await after.releaseLock();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("Store Atomic Writes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "store-atomic-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not leave temp files after successful write", async () => {
    const store = new Store(tempDir, "atomic-test");

    await store.create({ data: { test: 1 } });
    await store.create({ data: { test: 2 } });
    await store.create({ data: { test: 3 } });

    const storeDir = join(tempDir, ".agentuse", "store", "atomic-test");
    const files = require("fs").readdirSync(storeDir);
    const tmpFiles = files.filter((f: string) => f.includes(".tmp"));

    expect(tmpFiles).toHaveLength(0);

    await store.releaseLock();
  });
});

describe("createStoreTools", () => {
  let tempDir: string;
  let store: Store;
  let tools: ReturnType<typeof createStoreTools>;

  // The tool `execute` is the AI-SDK Tool shape; invoke it directly in tests.
  const call = (tool: Tool, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (tool.execute as (a: Record<string, unknown>, o?: unknown) => Promise<Record<string, unknown>>)(args, {});

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "store-tools-test-"));
    store = new Store(tempDir, "tools-store", "agent");
    tools = createStoreTools(store);
    await store.create({ type: "task", title: "First", status: "open", data: { body: "alpha payload", n: 1 } });
    await store.create({ type: "task", title: "Second", status: "done", data: { body: "beta payload", n: 2 } });
    await store.create({ type: "note", title: "Third", data: { body: "gamma needle payload", n: 3 } });
  });

  afterEach(async () => {
    await store.releaseLock();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("store_list returns summary rows without data by default", async () => {
    const res = await call(tools.store_list, {});
    const items = res.items as Array<Record<string, unknown>>;

    expect(res.count).toBe(3);
    expect(res.total).toBe(3);
    expect(items.every((i) => !("data" in i))).toBe(true);
    expect(items.every((i) => typeof i.id === "string")).toBe(true);
  });

  it("store_list summary rows list available data keys without values", async () => {
    const res = await call(tools.store_list, {});
    const first = (res.items as Array<Record<string, unknown>>)[0];

    expect(first.data).toBeUndefined();
    expect(Array.isArray(first.dataKeys)).toBe(true);
    expect((first.dataKeys as string[]).sort()).toEqual(["body", "n"]);
  });

  it("store_list includeData returns full payloads", async () => {
    const res = await call(tools.store_list, { includeData: true });
    const items = res.items as Array<Record<string, unknown>>;

    expect(items.every((i) => "data" in i)).toBe(true);
  });

  it("store_list fields projects only requested data keys", async () => {
    const res = await call(tools.store_list, { fields: ["n"] });
    const first = (res.items as Array<Record<string, unknown>>)[0];

    expect(Object.keys(first.data as object)).toEqual(["n"]);
  });

  it("store_list total reflects filter while count reflects the page", async () => {
    const res = await call(tools.store_list, { type: "task", limit: 1 });

    expect(res.count).toBe(1);
    expect(res.total).toBe(2);
  });

  it("store_list q attaches a match snippet to summary rows", async () => {
    const res = await call(tools.store_list, { q: "needle" });
    const items = res.items as Array<Record<string, unknown>>;

    expect(items).toHaveLength(1);
    expect(typeof items[0].match).toBe("string");
    expect((items[0].match as string).toLowerCase()).toContain("needle");
  });

  it("store_create echoes id and metadata but not the data payload", async () => {
    const res = await call(tools.store_create, { type: "task", data: { secret: "x".repeat(500) } });

    expect(res.success).toBe(true);
    expect(typeof res.id).toBe("string");
    expect((res.item as Record<string, unknown>).data).toBeUndefined();
  });

  it("store_get returns full data, or only requested fields", async () => {
    const created = await store.create({ data: { keep: 1, drop: 2 } });

    const full = await call(tools.store_get, { id: created.id });
    expect((full.item as { data: Record<string, unknown> }).data).toEqual({ keep: 1, drop: 2 });

    const narrowed = await call(tools.store_get, { id: created.id, fields: ["keep"] });
    expect((narrowed.item as { data: Record<string, unknown> }).data).toEqual({ keep: 1 });
  });
});
