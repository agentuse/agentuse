import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { findReadyExternalServer, probeServer } from "./server-connection";
import type { RegisteredServer } from "./runtime";

const listeners: Server[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function backend(status = 200): Promise<number> {
  const server = createServer((request, response) => {
    response.writeHead(request.headers.authorization === "Bearer test-key" ? 200 : status).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  listeners.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener");
  return address.port;
}

function registered(pid: number, port: number, projectRoot = "/project"): RegisteredServer {
  return { pid, port, projectRoot, host: "127.0.0.1", startTime: pid, version: "1" };
}

describe("external server connection refresh", () => {
  it("recognizes a new daemon PID on the remembered endpoint after a restart gap", async () => {
    const port = await backend();
    const previous = registered(10, port);
    expect(await findReadyExternalServer([], previous)).toBeUndefined();

    const restarted = registered(20, port);
    expect(await findReadyExternalServer([restarted], previous)).toBe(restarted);
  });

  it("probes past a stale registry candidate to find the restarted listener", async () => {
    const previous = registered(10, 12233);
    const restarted = registered(20, 12233);
    const probes: string[] = [];
    expect(await findReadyExternalServer([previous, restarted], previous, undefined, async (url) => {
      probes.push(url);
      return probes.length === 1 ? "unreachable" : "ready";
    })).toBe(restarted);
    expect(probes).toEqual(["http://127.0.0.1:12233", "http://127.0.0.1:12233"]);
  });

  it("never attaches to a different project, port, or nonlocal host", async () => {
    const target = registered(10, 12233);
    let probes = 0;
    const result = await findReadyExternalServer([
      registered(20, 12233, "/other-project"),
      registered(30, 12234),
      { ...registered(40, 12233), host: "192.168.1.2" },
    ], target, undefined, async () => { probes += 1; return "ready"; });
    expect(result).toBeUndefined();
    expect(probes).toBe(0);
  });

  it("requires the inherited API key when a restarted daemon is authenticated", async () => {
    const port = await backend(401);
    const restarted = registered(20, port);
    await expect(findReadyExternalServer([restarted], restarted)).rejects.toThrow("different API key");
    expect(await findReadyExternalServer([restarted], restarted, "test-key")).toBe(restarted);
  });

  it("keeps registered but unhealthy servers disconnected", async () => {
    const port = await backend(503);
    const candidate = registered(20, port);
    expect(await findReadyExternalServer([candidate], candidate)).toBeUndefined();
    expect(await probeServer("http://127.0.0.1:0")).toBe("unreachable");
  });
});
