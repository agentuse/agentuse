/**
 * Browser smoke test for the real `agentuse serve` dashboard.
 *
 * The daemon, project, global config, and XDG state are all disposable. The
 * fixture agents have no schedules and the browser never submits a run or an
 * approval, so this cannot call a provider or perform an external action.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

const root = resolve(import.meta.dir, '..');
const evidenceDir = join(root, 'tmp', 'e2e');
const browserSession = `agentuse-dashboard-${process.pid}`;
let daemon: ChildProcess | undefined;
let workspace: string | undefined;
let daemonOutput = '';

function fail(message: string): never {
  throw new Error(message);
}

function browser(args: string[], input?: string): string {
  const result = spawnSync('agent-browser', ['--session', browserSession, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      AGENT_BROWSER_HEADED: 'false',
      AGENT_BROWSER_SCREENSHOT_DIR: evidenceDir,
    },
    timeout: 30_000,
  });
  if (result.error?.message.includes('ENOENT')) {
    fail('agent-browser is required for test:e2e (install it with `npm install -g agent-browser`)');
  }
  if (result.status !== 0) {
    const timeoutHint = result.signal ? ` (terminated by ${result.signal})` : '';
    fail(`agent-browser ${args.join(' ')} failed${timeoutHint}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function expectBrowser(expression: string, message: string): void {
  const result = browser(['eval', '--stdin'], expression);
  if (result !== 'true') fail(`${message}\nBrowser result: ${result}`);
  console.log(`  ✓ ${message}`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForDaemon(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon?.exitCode !== null) {
      fail(`serve exited before it became ready:\n${daemonOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/agents`);
      if (response.ok) return;
    } catch {
      // The socket is expected to refuse connections during startup.
    }
    await Bun.sleep(100);
  }
  fail(`serve did not become ready within 20 seconds:\n${daemonOutput}`);
}

async function seedProject(projectRoot: string): Promise<string> {
  const agentsDir = join(projectRoot, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(projectRoot, 'ABOUT.md'), `---
name: Revenue Operations
description: Pipeline and renewal automations
owner: Operations Platform
---

This workspace contains the automations used by the revenue team.
`);
  await writeFile(join(agentsDir, 'source.agentuse'), `---
name: Source Monitor
model: demo:test
description: Collects account changes
metadata:
  owner: Data Operations
  tier: upstream
---

Summarize new account changes.
`);
  const reviewFile = join(agentsDir, 'review.agentuse');
  await writeFile(reviewFile, `---
name: Renewal Review
model: demo:test
description: Reviews renewal recommendations
dependsOn: ./source.agentuse
metadata:
  owner: Customer Success
  tier: decision
---

Review renewal recommendations and request approval before acting.
`);

  await initStorage(projectRoot);
  const manager = new SessionManager();
  const agentId = 'agents/review';
  const sessionId = await manager.createSession({
    agent: {
      id: agentId,
      name: 'Renewal Review',
      description: 'Reviews renewal recommendations',
      filePath: reviewFile,
      isSubAgent: false,
    },
    model: 'demo:test',
    version: 'e2e',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'Prepare a renewal recommendation.' } },
    assistant: {
      system: [],
      modelID: 'demo:test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  await manager.addPart(sessionId, agentId, messageId, {
    type: 'tool',
    callID: 'call-e2e-approval',
    tool: 'await_human',
    state: {
      status: 'pending',
      input: {
        prompt: 'Which renewal plan should we use?',
        summary: 'Choose the plan that should be presented to the customer.',
        options: [
          {
            id: 'fast',
            label: 'Fast renewal',
            description: 'Keep the current scope and renew this week.',
            recommended: true,
          },
          {
            id: 'thorough',
            label: 'Thorough review',
            description: 'Revisit scope and pricing before renewal.',
          },
        ],
      },
      suspendedAt: Date.now(),
      resumePayload: {
        kind: 'await_human',
        prompt: 'Which renewal plan should we use?',
        resumeToken: 'e2e-resume-token',
      },
    },
  } as any);
  await manager.setSessionSuspended(sessionId, agentId);
  return sessionId;
}

async function main(): Promise<void> {
  const dependencyCheck = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' });
  if (dependencyCheck.status !== 0) {
    fail('agent-browser is required for test:e2e (install it with `npm install -g agent-browser`)');
  }

  workspace = await mkdtemp(join(tmpdir(), 'agentuse-dashboard-e2e-'));
  await mkdir(evidenceDir, { recursive: true });
  const projectRoot = join(workspace, 'project');
  const stateRoot = join(workspace, 'state');
  const configPath = join(workspace, 'config.json');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    serve: {
      brand: { name: 'AgentUse Control Room' },
      terms: { project: 'workspace', folder: 'team' },
    },
  }));

  process.env.XDG_DATA_HOME = stateRoot;
  const sessionId = await seedProject(projectRoot);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  daemon = spawn(process.execPath, [
    'src/index.ts',
    'serve',
    '--port', String(port),
    '--directory', projectRoot,
    '--no-auth',
    '--no-log-file',
  ], {
    cwd: root,
    env: {
      ...process.env,
      XDG_DATA_HOME: stateRoot,
      AGENTUSE_CONFIG: configPath,
      SLACK_APP_TOKEN: '',
      SLACK_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout?.on('data', (chunk) => { daemonOutput += String(chunk); });
  daemon.stderr?.on('data', (chunk) => { daemonOutput += String(chunk); });
  await waitForDaemon(baseUrl);

  console.log('Dashboard browser smoke');
  browser(['set', 'viewport', '1440', '1000']);
  browser(['open', `${baseUrl}/agents`]);
  browser(['wait', '--text', 'Renewal Review']);
  expectBrowser(
    `document.body.innerText.includes('AgentUse Control Room')`,
    'brand renders on the Agents page',
  );
  expectBrowser(
    `document.body.innerText.toLowerCase().includes('revenue operations')`,
    'ABOUT.md identity renders on the Agents page',
  );

  browser(['select', 'select[aria-label="Add column"]', 'meta:owner']);
  expectBrowser(
    `document.body.innerText.includes('Customer Success') && JSON.parse(localStorage.getItem('agentuse-agents-columns-v2')).includes('meta:owner')`,
    'custom metadata column renders and persists',
  );
  browser(['reload']);
  browser(['wait', '--text', 'Customer Success']);
  expectBrowser(
    `document.body.innerText.includes('Customer Success')`,
    'persisted metadata column survives reload',
  );

  browser(['find', 'role', 'button', 'click', '--name', 'Graph']);
  expectBrowser(
    `document.body.innerText.includes('depends on') && document.body.innerText.includes('Renewal Review') && document.body.innerText.includes('Source Monitor')`,
    'graph view exposes dependsOn relationships',
  );
  browser(['screenshot', join(evidenceDir, 'agents-graph.png'), '--full']);

  browser(['open', `${baseUrl}/sessions/${encodeURIComponent(sessionId)}`]);
  browser(['wait', '1200']);
  const sessionBody = browser(['eval', 'document.body.innerText']);
  if (!sessionBody.toLowerCase().includes('pick one')) {
    fail(`Session approval UI did not render. Page text:\n${sessionBody}\nDaemon output:\n${daemonOutput}`);
  }
  expectBrowser(
    `document.querySelector('input[value="fast"]')?.checked === true && document.body.innerText.toLowerCase().includes('recommended')`,
    'recommended approval option is selected by default',
  );
  browser(['click', 'input[value="thorough"]']);
  expectBrowser(
    `[...document.querySelectorAll('button')].some((button) => button.innerText.includes('Approve') && button.innerText.includes('Thorough review'))`,
    'approval action tracks the reviewer’s selected option',
  );
  browser(['screenshot', join(evidenceDir, 'approval-options.png'), '--full']);

  browser(['open', `${baseUrl}/settings`]);
  browser(['wait', '1200']);
  expectBrowser(
    `document.body.innerText.toLowerCase().includes('pending approvals') && document.body.innerText.toLowerCase().includes('session completions')`,
    'PWA notification preferences are visible',
  );
  expectBrowser(
    `document.querySelector('link[rel="manifest"]')?.getAttribute('href') === '/manifest.webmanifest'`,
    'dashboard shell links the web app manifest',
  );
  expectBrowser(
    `fetch('/manifest.webmanifest').then((response) => response.json()).then((manifest) => Boolean(manifest.name && manifest.icons?.length))`,
    'web app manifest is fetchable and declares install icons',
  );
  expectBrowser(
    `navigator.serviceWorker.ready.then((registration) => registration.scope === location.origin + '/')`,
    'root-scoped service worker registers successfully',
  );
  browser(['screenshot', join(evidenceDir, 'settings-pwa.png'), '--full']);

  const pageErrors = browser(['errors']);
  if (pageErrors.trim() && !/No page errors found/i.test(pageErrors) && pageErrors.trim() !== '[]') {
    fail(`Browser page errors were reported:\n${pageErrors}`);
  }
  console.log(`  ✓ no browser page errors\n  evidence: ${evidenceDir}`);
}

try {
  await main();
} finally {
  try {
    browser(['close']);
  } catch {
    // Cleanup must not hide the original assertion or startup failure.
  }
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolveExit) => daemon!.once('exit', () => resolveExit())),
      Bun.sleep(2_000),
    ]);
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
  }
  if (workspace) await rm(workspace, { recursive: true, force: true });
}
