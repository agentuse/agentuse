import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/store/store";
import { createRecordMetricTool, METRICS_STORE_NAME, METRIC_ITEM_TYPE } from "../src/tools/metrics";

async function run(tool: { execute?: unknown }, input: unknown): Promise<any> {
  const execute = tool.execute as (i: unknown, o: unknown) => Promise<unknown>;
  return execute(input, {});
}

describe("Store.upsertWhere", () => {
  let tempDir: string;
  let store: Store;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "upsert-test-"));
    store = new Store(tempDir, "test-store", "test-agent");
  });

  afterEach(async () => {
    await store.releaseLock();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates when nothing matches", async () => {
    const { item, created } = await store.upsertWhere(
      { sessionId: "s1", metric: "a" },
      { data: { sessionId: "s1", metric: "a", value: 1 } }
    );
    expect(created).toBe(true);
    expect(item.data.value).toBe(1);
    expect(item.createdBy).toBe("test-agent");
  });

  it("updates in place when the key matches, merging data", async () => {
    const first = await store.upsertWhere(
      { sessionId: "s1", metric: "a" },
      { data: { sessionId: "s1", metric: "a", value: 1, note: "first" } }
    );
    const second = await store.upsertWhere(
      { sessionId: "s1", metric: "a" },
      { data: { sessionId: "s1", metric: "a", value: 5 } }
    );
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.data.value).toBe(5);
    expect(second.item.data.note).toBe("first"); // merge keeps unprovided keys

    const all = await store.list();
    expect(all.length).toBe(1);
  });

  it("does not match across a different key", async () => {
    await store.upsertWhere({ sessionId: "s1", metric: "a" }, { data: { sessionId: "s1", metric: "a", value: 1 } });
    await store.upsertWhere({ sessionId: "s2", metric: "a" }, { data: { sessionId: "s2", metric: "a", value: 2 } });
    await store.upsertWhere({ sessionId: "s1", metric: "b" }, { data: { sessionId: "s1", metric: "b", value: 3 } });
    const all = await store.list();
    expect(all.length).toBe(3);
  });

  it("updates the newest match when several match", async () => {
    const a = await store.create({ data: { k: "x", value: 1 } });
    await new Promise((r) => setTimeout(r, 2));
    const b = await store.create({ data: { k: "x", value: 2 } });
    const { item, created } = await store.upsertWhere({ k: "x" }, { data: { k: "x", value: 9 } });
    expect(created).toBe(false);
    expect(item.id).toBe(b.id);
    const untouched = await store.get(a.id);
    expect(untouched?.data.value).toBe(1);
  });
});

describe("record_metric tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metric-tool-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function metricsStore(): Store {
    return new Store(tempDir, METRICS_STORE_NAME, "reader");
  }

  it("records a metric with runtime-stamped provenance", async () => {
    const tool = createRecordMetricTool({ projectRoot: tempDir, sessionId: "ses_1", agentId: "invoice-chaser" });
    const res = await run(tool, { metric: "invoices_chased", count: 4, value: 11200, unit: "usd", note: "2 promised payment" });
    expect(res.success).toBe(true);
    expect(res.store).toBe(METRICS_STORE_NAME);

    const items = await metricsStore().list();
    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.type).toBe(METRIC_ITEM_TYPE);
    expect(item.tags).toEqual(["invoices_chased"]);
    expect(item.title).toBe("invoices_chased · 4 · 11200 usd");
    expect(item.data).toEqual({
      metric: "invoices_chased",
      value: 11200,
      unit: "usd",
      count: 4,
      note: "2 promised payment",
      sessionId: "ses_1",
      agent: "invoice-chaser",
    });
  });

  it("is idempotent per (sessionId, metric): re-recording overwrites", async () => {
    const tool = createRecordMetricTool({ projectRoot: tempDir, sessionId: "ses_1", agentId: "a" });
    await run(tool, { metric: "tickets_triaged", count: 3 });
    const res = await run(tool, { metric: "tickets_triaged", count: 8 });
    expect(res.success).toBe(true);
    expect(res.recorded).toContain("overwrote");

    const items = await metricsStore().list();
    expect(items.length).toBe(1);
    expect(items[0]!.data.count).toBe(8);
  });

  it("re-recording replaces omitted optional fields instead of retaining stale values", async () => {
    const tool = createRecordMetricTool({ projectRoot: tempDir, sessionId: "ses_1", agentId: "a" });
    await run(tool, { metric: "revenue_processed", count: 4, value: 11200, unit: "usd", note: "first" });
    await run(tool, { metric: "revenue_processed", count: 5 });

    const items = await metricsStore().list();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("revenue_processed · 5");
    expect(items[0]!.data).toEqual({
      metric: "revenue_processed",
      count: 5,
      sessionId: "ses_1",
      agent: "a",
    });
  });

  it("different sessions and metrics create separate records", async () => {
    const run1 = createRecordMetricTool({ projectRoot: tempDir, sessionId: "ses_1", agentId: "a" });
    const run2 = createRecordMetricTool({ projectRoot: tempDir, sessionId: "ses_2", agentId: "a" });
    await run(run1, { metric: "tickets_triaged", count: 3 });
    await run(run1, { metric: "replies_drafted", count: 5 });
    await run(run2, { metric: "tickets_triaged", count: 7 });

    const items = await metricsStore().list();
    expect(items.length).toBe(3);
  });

  it("without a sessionId every call creates (no dedupe key)", async () => {
    const tool = createRecordMetricTool({ projectRoot: tempDir, agentId: "a" });
    await run(tool, { metric: "tickets_triaged", count: 1 });
    await run(tool, { metric: "tickets_triaged", count: 2 });
    const items = await metricsStore().list();
    expect(items.length).toBe(2);
  });

  it("rejects a metric with neither value nor count via schema", () => {
    const tool = createRecordMetricTool({ projectRoot: tempDir, sessionId: "s", agentId: "a" });
    const schema = (tool as { inputSchema?: { safeParse: (i: unknown) => { success: boolean } } }).inputSchema!;
    expect(schema.safeParse({ metric: "tickets_triaged" }).success).toBe(false);
    expect(schema.safeParse({ metric: "Bad Name", count: 1 }).success).toBe(false);
    expect(schema.safeParse({ metric: "tickets_triaged", count: 1 }).success).toBe(true);
  });
});
