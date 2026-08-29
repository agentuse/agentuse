import { createServer, type AddressInfo } from "node:net";

export const DEFAULT_AGENTUSE_PORT = 12233;

function reserveLoopbackPort(port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen(port, "127.0.0.1", () => {
      const address = reservation.address() as AddressInfo;
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function selectLoopbackPort(preferredPort = DEFAULT_AGENTUSE_PORT): Promise<number> {
  try {
    return await reserveLoopbackPort(preferredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return reserveLoopbackPort(0);
  }
}
