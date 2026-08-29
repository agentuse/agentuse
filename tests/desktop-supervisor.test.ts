import { describe, expect, it } from "bun:test";
import { PassThrough } from "stream";
import {
  createIdempotentShutdown,
  parseDesktopLifetimeFd,
  parseDesktopServerSupervisor,
  watchDesktopLifetime,
} from "../src/utils/desktop-supervisor";

describe("desktop server supervision", () => {
  it("validates inherited supervisor metadata and lifetime file descriptors", () => {
    expect(parseDesktopServerSupervisor(JSON.stringify({
      kind: "desktop",
      pid: 42,
      procStartedAt: "ps:start-token",
      token: "0123456789abcdef",
    }))).toEqual({
      kind: "desktop",
      pid: 42,
      procStartedAt: "ps:start-token",
      token: "0123456789abcdef",
    });
    expect(parseDesktopServerSupervisor('{"kind":"desktop","pid":0,"token":"0123456789abcdef"}')).toBeUndefined();
    expect(parseDesktopServerSupervisor("not-json")).toBeUndefined();

    expect(parseDesktopLifetimeFd("3")).toBe(3);
    expect(parseDesktopLifetimeFd("255")).toBe(255);
    expect(parseDesktopLifetimeFd("2")).toBeUndefined();
    expect(parseDesktopLifetimeFd("3.5")).toBeUndefined();
  });

  it("treats lifetime-channel EOF as one supervisor disconnect", async () => {
    const pipe = new PassThrough();
    let disconnects = 0;
    watchDesktopLifetime(3, () => { disconnects += 1; }, () => pipe);

    pipe.end();
    await new Promise((resolve) => setImmediate(resolve));

    expect(disconnects).toBe(1);
  });

  it("coalesces EOF and signal shutdown requests", async () => {
    let shutdowns = 0;
    const shutdown = createIdempotentShutdown(async () => {
      shutdowns += 1;
    });

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(shutdowns).toBe(1);
  });
});
