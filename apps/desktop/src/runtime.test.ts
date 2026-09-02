import { describe, expect, it } from "bun:test";
import { isAbandonedDesktopServer, isDashboardNavigation, isLocalServer, isSafeExternalUrl, reconnectCandidates, selectServer, serverAcquisitionMode, serverRegistryDirectory, serverUrl } from "./runtime";

describe("desktop runtime helpers", () => {
  it("uses AGENTUSE_DATA_DIR as the exact registry profile", () => {
    expect(serverRegistryDirectory({
      AGENTUSE_DATA_DIR: "/tmp/agentuse-data",
      XDG_DATA_HOME: "/tmp/xdg-data",
    })).toBe("/tmp/agentuse-data/servers");
    expect(serverRegistryDirectory({
      XDG_DATA_HOME: "/tmp/xdg-data",
    })).toBe("/tmp/xdg-data/agentuse/servers");
  });

  it("only attaches to local registered servers", () => {
    expect(isLocalServer({ host: "127.0.0.1", port: 12233 })).toBe(true);
    expect(isLocalServer({ host: "0.0.0.0", port: 12233 })).toBe(true);
    expect(isLocalServer({ host: "localhost", port: 0 })).toBe(false);
  });

  it("selects the oldest valid server and formats IPv6 URLs", () => {
    const selected = selectServer([
      { pid: 2, host: "127.0.0.1", port: 12234, projectRoot: "/b", startTime: 2, version: "1" },
      { pid: 1, host: "::1", port: 12233, projectRoot: "/a", startTime: 1, version: "1" },
    ]);
    expect(selected?.pid).toBe(1);
    expect(serverUrl({ host: "::1", port: 12233 })).toBe("http://[::1]:12233");
    expect(serverUrl({ host: "0.0.0.0", port: 12233 })).toBe("http://127.0.0.1:12233");
  });

  it("reconnects only to the disconnected external server's endpoint and project", () => {
    const candidates = reconnectCandidates([
      { pid: 3, host: "127.0.0.1", port: 12234, projectRoot: "/c", startTime: 1, version: "1" },
      { pid: 2, host: "127.0.0.1", port: 12233, projectRoot: "/b", startTime: 3, version: "1" },
      { pid: 1, host: "127.0.0.1", port: 12233, projectRoot: "/a", startTime: 2, version: "1" },
      { pid: 4, host: "127.0.0.1", port: 12233, projectRoot: "/a", startTime: 4, version: "1" },
    ], { port: 12233, projectRoot: "/a" });

    expect(candidates.map((candidate) => candidate.pid)).toEqual([1, 4]);
  });

  it("does not replace a disconnected external server without an explicit request", () => {
    expect(serverAcquisitionMode({ port: 12233 })).toBe("reconnect-external");
    expect(serverAcquisitionMode({ port: 12233 }, true)).toBe("start-owned");
    expect(serverAcquisitionMode(undefined)).toBe("start-owned");
  });

  it("keeps embedded navigation on the attached dashboard origin", () => {
    expect(isDashboardNavigation("http://127.0.0.1:12233/sessions", "http://127.0.0.1:12233")).toBe(true);
    expect(isDashboardNavigation("http://127.0.0.1:12234/sessions", "http://127.0.0.1:12233")).toBe(false);
    expect(isDashboardNavigation("http://127.0.0.1:12233@evil.example/sessions", "http://127.0.0.1:12233")).toBe(false);
    expect(isDashboardNavigation("https://example.com", "http://127.0.0.1:12233")).toBe(false);
    expect(isSafeExternalUrl("https://agentuse.ai/docs")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });

  it("only reclaims desktop-supervised servers whose original app is gone", () => {
    const server = {
      pid: 20,
      host: "127.0.0.1",
      port: 12233,
      projectRoot: "/test",
      startTime: 1,
      version: "1",
      supervisor: { kind: "desktop" as const, pid: 10, token: "0123456789abcdef" },
    };

    expect(isAbandonedDesktopServer(server, () => "dead")).toBe(true);
    expect(isAbandonedDesktopServer(server, () => "alive")).toBe(false);
    expect(isAbandonedDesktopServer({ ...server, supervisor: undefined }, () => "dead")).toBe(false);
  });
});
