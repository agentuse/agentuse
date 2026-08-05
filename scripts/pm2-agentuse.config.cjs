// pm2 config for the long-running `agentuse serve` daemon.
//
// Apply with:  pm2 startOrRestart scripts/pm2-agentuse.config.cjs && pm2 save
//
// The setting that matters is `treekill: false`. pm2's default (true) signals the
// whole process tree, so on `pm2 restart` the daemon's agent worker children get
// SIGINT at t=0 and exit 130 before the daemon's own shutdown handler has run --
// every in-flight agent dies instantly and its session is stranded at 'running'.
// With treekill off, only the daemon is signalled; it drains in-flight approval
// resumes/continuations, then shuts its workers down itself.
//
// `kill_timeout` must stay above the daemon's SHUTDOWN_DRAIN_MS (8s, see
// src/cli/serve.ts) plus its 2s worker force-kill grace, or pm2 SIGKILLs the
// daemon mid-drain and the drain buys nothing.
//
// This still does not let a long-running agent survive a restart -- nothing in
// serve does today. Use scripts/serve-restart.sh, which waits for idle first.
//
// `script` must point at bin/cli.js, NOT the `agentuse` bin on PATH. That bin is
// a pnpm /bin/sh shim that spawns node as a *child*, so with treekill off pm2
// signals the shim and orphans the real daemon -- which then holds the port and
// crash-loops every replacement on EADDRINUSE. Naming cli.js directly makes the
// pid pm2 manages the daemon itself.
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'agentuse',
      script: path.resolve(__dirname, '..', 'bin', 'cli.js'),
      args: 'serve',
      cwd: process.env.HOME,
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
