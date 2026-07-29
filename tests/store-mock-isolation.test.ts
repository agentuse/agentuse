import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store } from "../src/store/store";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "store-mock-iso-"));
  delete process.env.AGENTUSE_MOCK_MODE;
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  delete process.env.AGENTUSE_MOCK_MODE;
});

function realItemsPath(storeName: string): string {
  return path.join(projectRoot, ".agentuse", "store", storeName, "items.json");
}

function mockBaseDirs(): string[] {
  const parent = path.join(projectRoot, ".agentuse", "store-mock");
  return fs.existsSync(parent) ? fs.readdirSync(parent).map((d) => path.join(parent, d)) : [];
}

describe("mock-mode store isolation", () => {
  it("seeds from the real store, reads back its own writes, and never touches the real store", async () => {
    // Seed the REAL store while mock is off.
    const real = new Store(projectRoot, "mystore", "agent-a");
    await real.create({ title: "existing", data: { n: 1 } });
    const realBytesBefore = fs.readFileSync(realItemsPath("mystore"), "utf8");

    // Mock run: reads see the seeded item, writes are read-back consistent.
    process.env.AGENTUSE_MOCK_MODE = "1";
    const mocked = new Store(projectRoot, "mystore", "agent-a");
    const seeded = await mocked.list({});
    expect(seeded.map((i) => i.title)).toEqual(["existing"]);

    await mocked.create({ title: "from-mock-run", data: { n: 2 } });
    const after = await mocked.list({});
    expect(after.map((i) => i.title).sort()).toEqual(["existing", "from-mock-run"]);

    // The real store is byte-identical; the write landed under store-mock/.
    expect(fs.readFileSync(realItemsPath("mystore"), "utf8")).toBe(realBytesBefore);
    const bases = mockBaseDirs();
    expect(bases.length).toBe(1);
    const mockItems = fs.readFileSync(path.join(bases[0], "mystore", "items.json"), "utf8");
    expect(mockItems).toContain("from-mock-run");
  });

  it("works for a store with no real counterpart (e.g. a fresh metrics store)", async () => {
    process.env.AGENTUSE_MOCK_MODE = "1";
    const metrics = new Store(projectRoot, "metrics", "agent-a");
    await metrics.create({ type: "metric", title: "replies", data: { count: 3 } });
    expect((await metrics.list({})).length).toBe(1);
    expect(fs.existsSync(realItemsPath("metrics"))).toBe(false);
  });

  it("shares one scratch base per project within the process", async () => {
    process.env.AGENTUSE_MOCK_MODE = "1";
    await new Store(projectRoot, "a", "x").create({ data: { v: 1 } });
    await new Store(projectRoot, "b", "x").create({ data: { v: 2 } });
    expect(mockBaseDirs().length).toBe(1);
  });
});
