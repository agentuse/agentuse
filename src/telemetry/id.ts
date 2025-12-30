/**
 * Anonymous ID generation and persistence for telemetry
 *
 * Stores telemetry config in ~/.local/share/agentuse/telemetry.json
 * This ID is never tied to user identity - it's purely for counting unique installations
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getXdgDataDir } from '../storage/paths';

const TELEMETRY_FILE = 'telemetry.json';

interface TelemetryConfig {
  id: string;
  alertedAt?: string;
}

function getTelemetryDir(): string {
  return path.join(getXdgDataDir(), 'agentuse');
}

function getConfigPath(): string {
  return path.join(getTelemetryDir(), TELEMETRY_FILE);
}

async function readConfig(): Promise<TelemetryConfig | null> {
  try {
    const content = await fs.readFile(getConfigPath(), 'utf-8');
    return JSON.parse(content) as TelemetryConfig;
  } catch {
    return null;
  }
}

async function writeConfig(config: TelemetryConfig): Promise<void> {
  const dir = getTelemetryDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

export async function getOrCreateAnonymousId(): Promise<string> {
  const config = await readConfig();
  if (config?.id) return config.id;

  const newId = crypto.randomUUID();
  try {
    await writeConfig({ id: newId });
  } catch {
    // If we can't persist, still return the ID for this session
  }
  return newId;
}

export async function isFirstRun(): Promise<boolean> {
  const config = await readConfig();
  return !config?.alertedAt;
}

export async function markFirstRunComplete(): Promise<void> {
  try {
    const config = await readConfig() ?? { id: crypto.randomUUID() };
    config.alertedAt = new Date().toISOString();
    await writeConfig(config);
  } catch {
    // Ignore errors - non-critical
  }
}
