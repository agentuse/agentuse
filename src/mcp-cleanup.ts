import type { MCPConnection } from './mcp';
import { logger } from './utils/logger';

/**
 * Close MCP clients concurrently. The MCP SDK's graceful stdio close can wait
 * seconds on a wedged server, so closing one after another made cleanup cost
 * that wait once per server. Close failures are ignored: cleanup is
 * best-effort and one bad server must not keep the others open.
 *
 * Kept out of mcp.ts so tests that replace that module keep this real cleanup.
 */
export async function closeMCPConnections(connections: readonly MCPConnection[]): Promise<void> {
  await Promise.allSettled(connections.map(async (connection) => {
    await connection.client.close();
    logger.debug(`Closed MCP client: ${connection.name}`);
  }));
}
