// pm2 config for the long-running `agentuse serve` daemon.
//
// Apply with:  pm2 startOrRestart scripts/pm2-agentuse.config.cjs && pm2 save
//
// Surviving a restart is serve's own job now: on shutdown it releases workers
// that still have agents running, and they finish out of process (see
// AgentWorker.release in src/cli/serve.ts). The settings here are the belt to
// that fix's braces -- worth having, no longer load-bearing.
//
// `treekill: false` stops pm2 signalling the whole process tree. The workers
// ignore a mid-run SIGINT/SIGTERM on their own, so the graceful signal is
// already survivable; what treekill still costs you is the SIGKILL pm2 sends at
// `kill_timeout`, which nothing can defer and which would take the released
// workers with it if the daemon were slow to exit.
//
// `kill_timeout` is generous for the same reason: it is the window the daemon
// has to finish its own shutdown before that unblockable SIGKILL lands.
//
// `script` must point at bin/cli.js, NOT the `agentuse` bin on PATH. That bin is
// a pnpm /bin/sh shim that spawns node as a *child*, so with treekill off pm2
// signals the shim and orphans the real daemon -- which then holds the port and
// crash-loops every replacement on EADDRINUSE. Naming cli.js directly makes the
// pid pm2 manages the daemon itself.
const path = require('path');
const os = require('os');

// PM2 retains its saved environment across restarts. Include the standard user
// CLI install directory even when PM2 was launched without a login-shell PATH.
// Append it to preserve the caller's existing command resolution order.
const localBin = path.join(os.homedir(), '.local', 'bin');
const executablePaths = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
if (!executablePaths.includes(localBin)) executablePaths.push(localBin);

module.exports = {
  apps: [
    {
      name: 'agentuse',
      script: path.resolve(__dirname, '..', 'bin', 'cli.js'),
      args: 'serve',
      cwd: process.env.HOME,
      env: { PATH: executablePaths.join(path.delimiter) },
      exec_mode: 'fork',
      treekill: false,
      kill_timeout: 15000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      merge_logs: true,
    },
  ],
};
