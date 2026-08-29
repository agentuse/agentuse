import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { selectLoopbackPort } from "./port-selection";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(port = 0): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

describe("Desktop server port selection", () => {
  it("uses the preferred port when it is available", async () => {
    const temporary = await listen();
    const address = temporary.address();
    if (!address || typeof address === "string") throw new Error("Expected an IP socket");
    const preferredPort = address.port;
    await new Promise<void>((resolve) => temporary.close(() => resolve()));
    servers.splice(servers.indexOf(temporary), 1);

    expect(await selectLoopbackPort(preferredPort)).toBe(preferredPort);
  });

  it("falls back to an ephemeral port when the preferred port is occupied", async () => {
    const occupied = await listen();
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected an IP socket");

    const selected = await selectLoopbackPort(address.port);
    expect(selected).toBeGreaterThan(0);
    expect(selected).not.toBe(address.port);
  });
});
