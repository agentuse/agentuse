import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

mock.restore();

const completeTextMock = mock(async (_model: string, options: { prompt: string }) => {
  if (options.prompt.includes("## Reviewer's note")) {
    return JSON.stringify({ category: "tip", title: "Cite sources", instruction: "Always cite primary sources." });
  }
  const id = options.prompt.match(/- \(id ([^)]+)\).*\[tip\] Cite sources/)?.[1];
  return JSON.stringify([{ id, verdict: "duplicate", detail: "Always cite primary sources." }]);
});

mock.module("../src/complete-text", () => ({ completeText: completeTextMock }));

let saveManualLearning: typeof import("../src/learning").saveManualLearning;
let LearningStore: typeof import("../src/learning/store").LearningStore;

beforeAll(async () => {
  ({ saveManualLearning } = await import("../src/learning"));
  ({ LearningStore } = await import("../src/learning/store"));
});

const dirs: string[] = [];
const priorXdgDataHome = process.env.XDG_DATA_HOME;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdgDataHome;
  completeTextMock.mockClear();
});

describe("manual learning vet", () => {
  it("quarantines a duplicate verdict instead of activating another copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-manual-vet-"));
    dirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const agentFile = join(dir, "demo.agentuse");
    writeFileSync(agentFile, "---\nname: demo\nmodel: demo:test\n---\nAlways cite primary sources.\n");

    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: dir,
      instruction: "Remember to cite sources.",
      model: "demo:test",
      agentInstructions: "Always cite primary sources.",
    });
    const stored = await LearningStore.fromAgentFile(agentFile, dir).load();

    expect(outcome.quarantined).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe("quarantined");
    expect(stored[0]!.quarantineReason).toContain("duplicates the contract");
  });
});
