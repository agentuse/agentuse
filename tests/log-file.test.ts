import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startLogFile } from "../src/utils/log-file";

describe("log-file", () => {
  const created: string[] = [];
  const tmp = (name: string): string => {
    const p = path.join(os.tmpdir(), `agentuse-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    created.push(p);
    return p;
  };

  afterEach(() => {
    for (const p of created.splice(0)) {
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  });

  it("tees stdout writes into the log file", async () => {
    const p = tmp("stdout.log");
    const handle = startLogFile({ path: p });
    process.stdout.write("hello stdout\n");
    await handle.close();

    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toContain("hello stdout");
  });

  it("tees stderr writes into the log file", async () => {
    const p = tmp("stderr.log");
    const handle = startLogFile({ path: p });
    process.stderr.write("hello stderr\n");
    await handle.close();

    expect(fs.readFileSync(p, "utf-8")).toContain("hello stderr");
  });

  it("strips ANSI color codes from the log file but keeps them on the wrapped stream", async () => {
    const p = tmp("ansi.log");
    const handle = startLogFile({ path: p });
    const colored = "\x1b[31mRED\x1b[0m plain";
    process.stdout.write(colored + "\n");
    await handle.close();

    const contents = fs.readFileSync(p, "utf-8");
    expect(contents).toContain("RED plain");
    expect(contents).not.toContain("\x1b[");
  });

  it("stops writing to the log file after close()", async () => {
    const p = tmp("restore.log");
    const handle = startLogFile({ path: p });
    process.stdout.write("before close\n");
    await handle.close();
    process.stdout.write("after close\n");
    // Give the (now-closed) stream a tick just in case.
    await new Promise((r) => setTimeout(r, 20));

    const contents = fs.readFileSync(p, "utf-8");
    expect(contents).toContain("before close");
    expect(contents).not.toContain("after close");
  });

  it("close() is idempotent", async () => {
    const p = tmp("idempotent.log");
    const handle = startLogFile({ path: p });
    await handle.close();
    await handle.close();
    // Should not throw.
  });

  it("truncates any pre-existing file at startup", async () => {
    const p = tmp("truncate.log");
    fs.writeFileSync(p, "old content that must be gone\n");
    const handle = startLogFile({ path: p });
    process.stdout.write("fresh\n");
    await handle.close();

    const contents = fs.readFileSync(p, "utf-8");
    expect(contents).not.toContain("old content");
    expect(contents).toContain("fresh");
  });
});
