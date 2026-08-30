/**
 * Browser smoke test for the real `agentuse serve` dashboard.
 *
 * The daemon, project, global config, and XDG state are all disposable. The
 * fixture agents have no schedules and the browser never submits a run or an
 * approval. Agent authoring uses a disposable loopback OpenAI-compatible mock,
 * so this cannot call an external provider or perform an external action.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { ONBOARDING_AGENT_ID, ONBOARDING_AGENT_NAME, ONBOARDING_MODEL } from '../src/onboarding';

const root = resolve(import.meta.dir, '..');
const evidenceDir = join(root, 'tmp', 'e2e');
const browserSession = `agentuse-dashboard-${process.pid}`;
let daemon: ChildProcess | undefined;
let authorDaemon: ChildProcess | undefined;
let workspace: string | undefined;
let daemonOutput = '';
let authorDaemonOutput = '';
let authorBaseUrl = '';

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

async function waitForAuthorDaemon(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (authorDaemon?.exitCode !== null) fail(`author server exited before startup:\n${authorDaemonOutput}`);
    try {
      if ((await fetch(`${authorBaseUrl}/requests`)).ok) return;
    } catch {
      // The socket is expected to refuse connections during startup.
    }
    await Bun.sleep(50);
  }
  fail(`author server did not become ready:\n${authorDaemonOutput}`);
}

async function authorRequestCount(): Promise<number> {
  const response = await fetch(`${authorBaseUrl}/requests`);
  return ((await response.json()) as { requests: number }).requests;
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

async function seedOnboardingProject(projectRoot: string): Promise<string> {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'ABOUT.md'), `---\nname: Getting Started\ndescription: Empty onboarding workspace\n---\n`);
  await initStorage(projectRoot);
  const manager = new SessionManager();
  const onboardingSessionId = await manager.createSession({
    agent: {
      id: ONBOARDING_AGENT_ID,
      name: ONBOARDING_AGENT_NAME,
      isSubAgent: false,
    },
    model: ONBOARDING_MODEL,
    version: 'e2e',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
    trigger: 'onboarding',
  });
  await manager.setSessionCompleted(onboardingSessionId, ONBOARDING_AGENT_ID);
  return onboardingSessionId;
}

async function main(): Promise<void> {
  const dependencyCheck = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' });
  if (dependencyCheck.status !== 0) {
    fail('agent-browser is required for test:e2e (install it with `npm install -g agent-browser`)');
  }

  workspace = await mkdtemp(join(tmpdir(), 'agentuse-dashboard-e2e-'));
  await mkdir(evidenceDir, { recursive: true });
  const projectRoot = join(workspace, 'project');
  const onboardingProjectRoot = join(workspace, 'onboarding');
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
  const approvalSessionId = await seedProject(projectRoot);
  const onboardingSessionId = await seedOnboardingProject(onboardingProjectRoot);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authorPort = await freePort();
  authorBaseUrl = `http://127.0.0.1:${authorPort}`;
  authorDaemon = spawn(process.execPath, ['scripts/e2e-author-server.ts', String(authorPort)], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  authorDaemon.stdout?.on('data', (chunk) => { authorDaemonOutput += String(chunk); });
  authorDaemon.stderr?.on('data', (chunk) => { authorDaemonOutput += String(chunk); });
  await waitForAuthorDaemon();
  daemon = spawn(process.execPath, [
    'src/index.ts',
    'serve',
    '--port', String(port),
    '--directory', projectRoot,
    '--directory', onboardingProjectRoot,
    '--no-auth',
    '--no-log-file',
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: workspace,
      XDG_DATA_HOME: stateRoot,
      AGENTUSE_CONFIG: configPath,
      OPENAI_BASE_URL: `${authorBaseUrl}/v1`,
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

  browser(['open', `${baseUrl}/sessions/${encodeURIComponent(approvalSessionId)}`]);
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

  browser(['open', `${baseUrl}/sessions/${encodeURIComponent(onboardingSessionId)}?project=onboarding`]);
  browser(['wait', '1200']);
  const onboardingBody = browser(['eval', 'document.body.innerText']);
  if (!onboardingBody.includes('Create my first agent')) {
    fail(`Completed onboarding session did not render its first-agent handoff. Page text:\n${onboardingBody}\nDaemon output:\n${daemonOutput}`);
  }
  browser(['eval', `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Create my first agent')); button?.click(); return Boolean(button); })()`]);
  browser(['wait', '--text', 'Connect a model provider']);
  expectBrowser(
    `document.querySelector('.provider-setup-dialog[open]') !== null && document.querySelector('.cca-dialog[open]') === null`,
    'completed sample handoff gates agent creation on provider setup',
  );
  browser(['screenshot', join(evidenceDir, 'onboarding-provider-gate.png')]);
  browser(['click', '.provider-setup-dialog .dialog-close']);

  expectBrowser(
    `fetch('/api/providers/api-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', key: 'e2e-disposable-key' }) }).then((response) => response.json()).then((payload) => payload.success === true && !JSON.stringify(payload).includes('e2e-disposable-key'))`,
    'provider setup persists a credential without returning its value',
  );
  browser(['eval', `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Create my first agent')); button?.click(); return Boolean(button); })()`]);
  browser(['wait', '--text', 'Describe the job']);
  expectBrowser(
    `document.querySelector('.agent-create-dialog[open]') !== null && document.querySelector('.cca-dialog[open]') === null`,
    'provider-ready onboarding opens native persistent agent creation',
  );
  expectBrowser(
    `document.querySelector('.agent-create-dialog input[placeholder="Support digest"]') === null && document.querySelector('.agent-create-handoff')?.innerText.includes('more hands-on') === true`,
    'agent creation asks only for the job and separates the hands-on coding-agent path',
  );
  browser(['click', '.agent-create-dialog .dashboard-select-trigger[aria-label="Creator model"]']);
  expectBrowser(
    `(() => { const menu = document.querySelector('.agent-create-dialog .dashboard-select-menu'); const options = menu?.querySelectorAll('[role="option"]') ?? []; return Boolean(menu) && options.length > 1 && getComputedStyle(menu).backgroundColor !== 'rgb(255, 255, 255)'; })()`,
    'agent creation uses a bounded dark model listbox instead of a native select popup',
  );
  browser(['screenshot', join(evidenceDir, 'onboarding-create-agent-model-picker.png')]);
  browser(['click', '.agent-create-dialog .dashboard-select-trigger[aria-label="Creator model"]']);
  browser(['eval', `(() => {
    const set = (selector, value) => { const element = document.querySelector(selector); if (!element) return false; element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    return set('.agent-create-field textarea', 'Summarize new support tickets every morning and highlight urgent replies.');
  })()`]);
  browser(['click', '.agent-create-escape']);
  browser(['wait', '--text', 'Preview instructions']);
  expectBrowser(
    `document.querySelector('.cca-dialog[open]') !== null && document.querySelector('.cca-dialog textarea')?.value.includes('Summarize new support tickets') === true && !document.querySelector('.cca-dialog textarea')?.value.includes('Preferred model')`,
    'coding-agent escape hatch preserves the native creation draft',
  );
  browser(['screenshot', join(evidenceDir, 'create-agent-coding-escape.png')]);
  browser(['click', '.cca-dialog .dialog-close']);
  browser(['eval', `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Create my first agent')); button?.click(); return Boolean(button); })()`]);
  browser(['wait', '--text', 'Describe the job']);
  browser(['screenshot', join(evidenceDir, 'onboarding-create-agent.png')]);
  browser(['click', '.agent-create-primary']);
  browser(['wait', '--text', 'Creating your agent']);
  expectBrowser(
    `(async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (document.querySelector('.agent-create-progress.is-creating') !== null && document.querySelector('.agent-create-log')?.value.includes('[model draft]') === true) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    })()`,
    'agent creation replaces the form with a live model-authored creation log',
  );
  browser(['screenshot', join(evidenceDir, 'onboarding-create-agent-progress.png')]);
  browser(['wait', '--text', 'Creation complete']);
  const creationError = JSON.parse(browser(['eval', `document.querySelector('.agent-create-error')?.textContent ?? ''`])) as string;
  if (creationError) fail(`Model-backed onboarding creation failed: ${creationError}\nAuthor requests: ${await authorRequestCount()}\nDaemon output:\n${daemonOutput}`);
  expectBrowser(
    `document.querySelector('.agent-create-log')?.value.includes('[agentuse] Created Summarize New Support Tickets Every Morning') === true`,
    'creation log carries the model draft through validation and persistence',
  );
  browser(['click', '.agent-create-progress-actions .agent-create-primary']);
  const creationOutcome = JSON.parse(browser(['eval', '--stdin'], `(async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (document.body.innerText.includes('Your agent is ready')) return 'ready';
      const error = document.querySelector('.agent-create-error')?.textContent;
      if (error) return 'error:' + error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return 'timeout';
  })()`)) as string;
  if (creationOutcome !== 'ready') {
    fail(`Model-backed onboarding creation ${creationOutcome}\nAuthor requests: ${await authorRequestCount()}\nDaemon output:\n${daemonOutput}`);
  }
  expectBrowser(
    `document.body.innerText.includes('Summarize New Support Tickets Every Morning') && document.querySelector('.agent-create-dialog[open]') === null`,
    'onboarding persists the first agent and renders its ready state',
  );
  const onboardingAgentSource = await readFile(join(onboardingProjectRoot, 'agents', 'summarize-new-support-tickets-every-morning.agentuse'), 'utf8');
  if (!onboardingAgentSource.includes('model: openai:gpt-5.4-mini') || !onboardingAgentSource.includes('Summarize new support tickets')) {
    fail(`Onboarding agent source was not persisted correctly:\n${onboardingAgentSource}`);
  }

  browser(['open', `${baseUrl}/agents/onboarding`]);
  browser(['wait', '--text', 'Summarize New Support Tickets Every Morning']);
  expectBrowser(`document.body.innerText.includes('New agent')`, 'Agents view exposes the persistent New agent action');
  browser(['click', '.new-agent-button']);
  browser(['wait', '--text', 'Describe the job']);
  browser(['eval', `(() => {
    const set = (selector, value) => { const element = document.querySelector(selector); if (!element) return false; element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    return set('.agent-create-field textarea', 'Review yesterday’s work and identify the most important follow-up.');
  })()`]);
  browser(['click', '.agent-create-primary']);
  browser(['wait', '--text', 'Creation complete']);
  browser(['click', '.agent-create-progress-actions .agent-create-primary']);
  browser(['wait', '--text', 'Review Yesterday Work']);
  expectBrowser(
    `location.pathname.includes('/agents/onboarding/') && document.body.innerText.includes('Review Yesterday Work')`,
    'normal Agents view creates and opens a persistent agent',
  );
  const normalAgentSource = await readFile(join(onboardingProjectRoot, 'agents', 'review-yesterday-work.agentuse'), 'utf8');
  if (!normalAgentSource.includes('Review yesterday’s work')) fail(`Normal agent source was not persisted correctly:\n${normalAgentSource}`);
  const authorRequests = await authorRequestCount();
  if (authorRequests < 2) fail(`Expected both native creations to call the selected model; observed ${authorRequests} author request(s)`);
  console.log('  ✓ native creation uses the selected creator model and persists its independently chosen runtime model');

  browser(['open', `${baseUrl}/settings`]);
  browser(['wait', '1200']);
  expectBrowser(
    `document.body.innerText.toLowerCase().includes('pending approvals') && document.body.innerText.toLowerCase().includes('session completions')`,
    'PWA notification preferences are visible',
  );
  expectBrowser(
    `document.body.innerText.toLowerCase().includes('providers') && document.body.innerText.includes('Anthropic') && document.body.innerText.includes('OpenRouter')`,
    'provider status is integrated into Preferences',
  );
  expectBrowser(
    `fetch('/api/providers').then((response) => response.json()).then((payload) => payload.success === true && payload.catalog.length >= 4 && !JSON.stringify(payload).includes('access_token'))`,
    'provider API returns a redacted catalog and status snapshot',
  );
  browser(['eval', `(() => { const rows = [...document.querySelectorAll('.provider-settings-row')]; const row = rows.find((item) => item.textContent?.includes('OpenRouter')); const button = row && [...row.querySelectorAll('button')].find((item) => item.textContent?.includes('Connect')); button?.click(); return Boolean(button); })()`]);
  browser(['wait', '--text', 'Connect a model provider']);
  expectBrowser(
    `document.querySelector('.provider-setup-dialog[open]') !== null && document.querySelector('.provider-setup-dialog input[type="password"]') !== null`,
    'provider setup dialog opens from Preferences without writing credentials',
  );
  browser(['screenshot', join(evidenceDir, 'settings-provider-dialog.png')]);
  browser(['click', '.provider-setup-dialog .dialog-close']);
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
  if (authorDaemon && authorDaemon.exitCode === null) authorDaemon.kill('SIGTERM');
  if (workspace) await rm(workspace, { recursive: true, force: true });
}
