import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Store, createStore } from "../src/store/store";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
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
});

describe("Store Locking", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "store-lock-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates lock file on first access", async () => {
    const store = new Store(tempDir, "lock-test", "agent1");

    await store.create({ data: {} });

    const lockPath = join(tempDir, ".agentuse", "store", "lock-test", "lock");
    expect(existsSync(lockPath)).toBe(true);

    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.pid).toBe(process.pid);
    expect(lockContent.agent).toBe("agent1");

    await store.releaseLock();
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
