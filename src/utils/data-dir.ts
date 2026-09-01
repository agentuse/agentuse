import { homedir } from 'os';
import { join, resolve } from 'path';

/**
 * Exact root for AgentUse-owned durable data.
 *
 * AGENTUSE_DATA_DIR is the product-specific override. XDG_DATA_HOME remains a
 * standards-compatible fallback and, as the XDG base directory, receives the
 * conventional `agentuse/` child. The direct override never receives another
 * suffix.
 */
export function getAgentuseDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTUSE_DATA_DIR;
  if (override && override.length > 0) return resolve(override);

  const xdgDataHome = env.XDG_DATA_HOME;
  const dataHome = xdgDataHome && xdgDataHome.length > 0
    ? xdgDataHome
    : join(env.HOME || homedir(), '.local', 'share');
  return join(dataHome, 'agentuse');
}
