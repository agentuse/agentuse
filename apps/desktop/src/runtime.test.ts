import { describe, expect, it } from "bun:test";
import { isDashboardNavigation, isLocalServer, isSafeExternalUrl, selectServer, serverUrl } from "./runtime";

describe("desktop runtime helpers", () => {
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

  it("keeps embedded navigation on the attached dashboard origin", () => {
    expect(isDashboardNavigation("http://127.0.0.1:12233/sessions", "http://127.0.0.1:12233")).toBe(true);
    expect(isDashboardNavigation("http://127.0.0.1:12234/sessions", "http://127.0.0.1:12233")).toBe(false);
    expect(isDashboardNavigation("http://127.0.0.1:12233@evil.example/sessions", "http://127.0.0.1:12233")).toBe(false);
    expect(isDashboardNavigation("https://example.com", "http://127.0.0.1:12233")).toBe(false);
    expect(isSafeExternalUrl("https://agentuse.ai/docs")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });
});
