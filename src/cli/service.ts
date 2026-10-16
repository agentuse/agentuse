import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, platform as osPlatform, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getGlobalConfigDir } from '../utils/global-config.js';
import { isNpxRun } from '../utils/npx.js';

/**
 * Keep `agentuse serve` running in the background: a launchd agent on macOS, a
 * systemd user unit on Linux. Setup installs it so nobody has to keep a
 * terminal window open, and agents keep their schedules after a restart.
 */

const run = promisify(execFile);

export const LAUNCHD_LABEL = 'io.agentuse.serve';
export const SYSTEMD_UNIT = 'agentuse.service';

export interface ServiceProgram {
  /** Absolute node binary. */
  node: string;
  /** Absolute, stable path to the agentuse CLI entry. */
  cli: string;
}

export type ServiceProgramResult =
  | { ok: true; program: ServiceProgram }
  | { ok: false; reason: 'npx' | 'unsupported' };

/**
 * The command a service can start at login. An npx run lives in npm's cache,
 * which npm may clear, so a service pointing at it would break later.
 */
export function serviceProgram(
  scriptPath = process.argv[1] ?? '',
  nodePath = process.execPath,
  platform: NodeJS.Platform = osPlatform(),
): ServiceProgramResult {
  if (platform !== 'darwin' && platform !== 'linux') return { ok: false, reason: 'unsupported' };
  if (isNpxRun(scriptPath)) return { ok: false, reason: 'npx' };
  let cli = scriptPath;
  try {
    cli = realpathSync(scriptPath);
  } catch {
    // Keep the given path; the plist or unit then shows what was used.
  }
  return { ok: true, program: { node: nodePath, cli } };
}

const xml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export const serviceLogPath = (): string => path.join(getGlobalConfigDir(), 'logs', 'serve.log');

export function launchdPlist(program: ServiceProgram, envPath: string, logPath = serviceLogPath()): string {
  const args = [program.node, program.cli, 'serve'].map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(envPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** systemd quotes arguments with double quotes; escape what would end them. */
const unitArg = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export function systemdUnit(program: ServiceProgram, envPath: string): string {
  return `[Unit]
Description=AgentUse (agentuse serve)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[program.node, program.cli, 'serve'].map(unitArg).join(' ')}
Environment=${unitArg(`PATH=${envPath}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export const launchdPlistPath = (home = homedir()): string => path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
export const systemdUnitPath = (home = homedir()): string => path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);

export function serviceInstalled(platform: NodeJS.Platform = osPlatform(), home = homedir()): boolean {
  if (platform === 'darwin') return existsSync(launchdPlistPath(home));
  if (platform === 'linux') return existsSync(systemdUnitPath(home));
  return false;
}

/**
 * Write the service file and start it. Running it again replaces and restarts
 * it. If it cannot start, the file is removed so nothing half-installed stays.
 */
export async function installService(program: ServiceProgram, envPath = process.env.PATH ?? '/usr/bin:/bin'): Promise<string> {
  const darwin = osPlatform() === 'darwin';
  const file = darwin ? launchdPlistPath() : systemdUnitPath();
  try {
    if (darwin) {
      atomicWriteFileSync(file, launchdPlist(program, envPath), { mode: 0o644, mkdir: true });
      mkdirSync(path.dirname(serviceLogPath()), { recursive: true });
      const domain = `gui/${userInfo().uid}`;
      // A previous copy may be loaded; replacing it is the point.
      await run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]).catch(() => {});
      await run('launchctl', ['bootstrap', domain, file]);
    } else {
      atomicWriteFileSync(file, systemdUnit(program, envPath), { mode: 0o644, mkdir: true });
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
      await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
    }
    return file;
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}
