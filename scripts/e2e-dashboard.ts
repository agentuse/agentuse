/**
 * Functional smoke test for the real `agentuse serve` dashboard.
 *
 * Most assertions exercise daemon contracts through HTTP so routine UI copy,
 * layout, and component changes cannot break the release signal. The browser
 * is only a bundle canary: it loads the dashboard and reports runtime errors.
 * Agent authoring uses a disposable loopback OpenAI-compatible mock, so this
 * cannot call an external provider or perform an external action.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentCreationProvider } from '../src/agents/create';
import type { AgentDraftRecord } from '../src/agents/draft';
import type { AgentSummary } from '../src/cli/serve/types';

const root = resolve(import.meta.dir, '..');
const browserSession = `agentuse-dashboard-${process.pid}`;
const disposableKey = 'e2e-disposable-key';
let daemon: ChildProcess | undefined;
let authorDaemon: ChildProcess | undefined;
let workspace: string | undefined;
let browserStarted = false;
let daemonOutput = '';
let authorDaemonOutput = '';
let authorBaseUrl = '';

interface InfoPayload {
  default: string | null;
  projects: Array<{ id: string; path: string }>;
}

interface AgentsPayload {
  success: true;
  agents: AgentSummary[];
  errors: Array<{ projectId: string; path: string; message: string }>;
}

interface AgentCreationOptionsPayload {
  success: true;
  providers: AgentCreationProvider[];
  projects: Array<{ id: string; path: string }>;
  default: string | null;
}

interface StartAgentPayload {
  success: true;
  job: { id: string; projectId: string; status: string };
}

interface AgentDraftPayload extends AgentDraftRecord {
  sessionHref: string;
}

function diagnostics(): string {
  const sections: string[] = [];
  if (daemonOutput.trim()) sections.push(`Daemon output:\n${daemonOutput.slice(-12_000)}`);
  if (authorDaemonOutput.trim()) sections.push(`Author output:\n${authorDaemonOutput.slice(-12_000)}`);
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

function fail(message: string): never {
  throw new Error(`${message}${diagnostics()}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
  console.log(`  ✓ ${message}`);
}

function browser(args: string[]): string {
  const result = spawnSync('agent-browser', ['--session', browserSession, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AGENT_BROWSER_HEADED: 'false' },
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
    if (daemon?.exitCode !== null) fail('serve exited before it became ready');
    try {
      const response = await fetch(`${baseUrl}/api`);
      if (response.ok) return;
    } catch {
      // The socket is expected to refuse connections during startup.
    }
    await Bun.sleep(100);
  }
  fail('serve did not become ready within 20 seconds');
}

async function waitForAuthorDaemon(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (authorDaemon?.exitCode !== null) fail('author server exited before startup');
    try {
      if ((await fetch(`${authorBaseUrl}/requests`)).ok) return;
    } catch {
      // The socket is expected to refuse connections during startup.
    }
    await Bun.sleep(50);
  }
  fail('author server did not become ready within 10 seconds');
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body && { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    fail(`${init?.method ?? 'GET'} ${path} returned non-JSON (${response.status}):\n${text}`);
  }
  if (!response.ok) {
    fail(`${init?.method ?? 'GET'} ${path} failed (${response.status}):\n${JSON.stringify(payload, null, 2)}`);
  }
  return payload as T;
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  return requestJson<T>(baseUrl, path, { method: 'POST', body: JSON.stringify(body) });
}

async function waitForDraft(baseUrl: string, projectId: string, jobId: string): Promise<AgentDraftPayload> {
  const deadline = Date.now() + 60_000;
  let last: AgentDraftPayload | undefined;
  while (Date.now() < deadline) {
    const payload = await requestJson<{ success: true; draft: AgentDraftPayload }>(
      baseUrl,
      `/api/agents/drafts/${encodeURIComponent(jobId)}?project=${encodeURIComponent(projectId)}`,
    );
    last = payload.draft;
    if (last.status === 'drafted') return last;
    if (last.status === 'error') {
      fail(`Agent creator failed: ${last.error?.code ?? 'UNKNOWN'}: ${last.error?.message ?? 'No message'}`);
    }
    await Bun.sleep(150);
  }
  fail(`Agent creator did not produce a draft within 60 seconds. Last state: ${JSON.stringify(last, null, 2)}`);
}

async function authorRequestCount(): Promise<number> {
  const response = await fetch(`${authorBaseUrl}/requests`);
  const payload = await response.json() as { requests: number };
  return payload.requests;
}

async function seedProject(projectRoot: string): Promise<void> {
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
---

Summarize new account changes.
`);
  await writeFile(join(agentsDir, 'review.agentuse'), `---
name: Renewal Review
model: demo:test
description: Reviews renewal recommendations
dependsOn: ./source.agentuse
metadata:
  owner: Customer Success
---

Review renewal recommendations before acting.
`);
}

async function runFunctionalSmoke(baseUrl: string, projectRoot: string): Promise<void> {
  console.log('Dashboard functional smoke');

  const info = await requestJson<InfoPayload>(baseUrl, '/api');
  check(info.projects.length === 1, 'real daemon exposes the disposable project');
  const projectId = info.projects[0]!.id;

  const initialAgents = await requestJson<AgentsPayload>(baseUrl, '/api/agents');
  const source = initialAgents.agents.find((agent) => agent.name === 'Source Monitor');
  const review = initialAgents.agents.find((agent) => agent.name === 'Renewal Review');
  check(
    initialAgents.errors.length === 0
      && source?.metadata?.owner === 'Data Operations'
      && review?.dependsOn?.includes(source.path) === true,
    'agent discovery preserves metadata and dependency relationships',
  );

  const providerResult = await postJson<Record<string, unknown>>(baseUrl, '/api/providers/api-key', {
    provider: 'openai',
    key: disposableKey,
  });
  check(
    providerResult.success === true && !JSON.stringify(providerResult).includes(disposableKey),
    'provider setup persists a credential without returning its value',
  );

  const providers = await requestJson<Record<string, unknown>>(baseUrl, '/api/providers?readiness=defer');
  check(
    providers.success === true && !JSON.stringify(providers).includes(disposableKey),
    'provider status remains redacted when read back',
  );

  const options = await requestJson<AgentCreationOptionsPayload>(
    baseUrl,
    `/api/agents/create?project=${encodeURIComponent(projectId)}`,
  );
  const openai = options.providers.find((provider) => provider.id === 'openai');
  const authoringModel = openai?.defaultModel ?? openai?.models[0];
  check(Boolean(authoringModel), 'agent creation exposes a configured authoring model');

  const started = await postJson<StartAgentPayload>(baseUrl, '/api/agents', {
    project: projectId,
    objective: 'Summarize new support tickets every morning and highlight urgent replies.',
    model: authoringModel!,
    reasoning: 'medium',
  });
  check(
    started.success && started.job.projectId === projectId && started.job.status === 'running',
    'agent creation starts a real creator session',
  );

  const createdPath = join(projectRoot, 'agents', 'summarize-new-support-tickets-every-morning.agentuse');
  const draft = await waitForDraft(baseUrl, projectId, started.job.id);
  const latest = draft.drafts.at(-1);
  check(
    latest?.fileName === 'summarize-new-support-tickets-every-morning.agentuse'
      && latest.source.includes('Summarize new support tickets'),
    'mocked creator produces a valid draft through the real worker',
  );
  check(!(await Bun.file(createdPath).exists()), 'creator keeps the project unchanged until Save');

  const saved = await postJson<{ success: true; agent: AgentSummary }>(
    baseUrl,
    `/api/agents/drafts/${encodeURIComponent(started.job.id)}/save?project=${encodeURIComponent(projectId)}`,
    {},
  );
  const savedSource = await readFile(createdPath, 'utf8');
  check(
    saved.success
      && saved.agent.projectId === projectId
      && saved.agent.runPath.endsWith('summarize-new-support-tickets-every-morning.agentuse')
      && savedSource.includes('Summarize new support tickets'),
    'Save persists the reviewed draft as a discoverable agent',
  );
  check((await authorRequestCount()) >= 2, 'creator and capability review use the loopback model server');
}

function runBrowserCanary(baseUrl: string): void {
  console.log('Dashboard browser canary');
  browserStarted = true;
  browser(['open', `${baseUrl}/agents`]);
  browser(['wait', '--load', 'domcontentloaded']);
  const ready = browser(['eval', "document.readyState === 'interactive' || document.readyState === 'complete'"]);
  check(ready === 'true', 'built dashboard loads in a real browser');
  const pageErrors = browser(['errors']);
  check(
    !pageErrors.trim() || /No page errors found/i.test(pageErrors) || pageErrors.trim() === '[]',
    `dashboard reports no browser runtime errors${pageErrors.trim() ? `: ${pageErrors}` : ''}`,
  );
}

async function main(): Promise<void> {
  const dependencyCheck = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' });
  if (dependencyCheck.status !== 0) {
    fail('agent-browser is required for test:e2e (install it with `npm install -g agent-browser`)');
  }

  workspace = await mkdtemp(join(tmpdir(), 'agentuse-dashboard-e2e-'));
  const projectRoot = join(workspace, 'project');
  const stateRoot = join(workspace, 'state');
  const configDir = join(workspace, 'config');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await seedProject(projectRoot);

  const authorPort = await freePort();
  authorBaseUrl = `http://127.0.0.1:${authorPort}`;
  authorDaemon = spawn(process.execPath, ['scripts/e2e-author-server.ts', String(authorPort)], {
    cwd: root,
    env: { ...process.env, AGENTUSE_DATA_DIR: stateRoot, AGENTUSE_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  authorDaemon.stdout?.on('data', (chunk) => { authorDaemonOutput += String(chunk); });
  authorDaemon.stderr?.on('data', (chunk) => { authorDaemonOutput += String(chunk); });
  await waitForAuthorDaemon();

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
      AGENTUSE_DATA_DIR: stateRoot,
      AGENTUSE_CONFIG_DIR: configDir,
      OPENAI_BASE_URL: `${authorBaseUrl}/v1`,
      SLACK_APP_TOKEN: '',
      SLACK_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout?.on('data', (chunk) => { daemonOutput += String(chunk); });
  daemon.stderr?.on('data', (chunk) => { daemonOutput += String(chunk); });
  await waitForDaemon(baseUrl);

  await runFunctionalSmoke(baseUrl, projectRoot);
  runBrowserCanary(baseUrl);
}

try {
  await main();
} finally {
  if (browserStarted) {
    try {
      browser(['close']);
    } catch {
      // Cleanup must not hide the original assertion or startup failure.
    }
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
