/**
 * The chat path end to end: a clean Claude Code types /automate and must make
 * the agent through the AgentUse MCP tools, never by writing files or running
 * the agentuse command line.
 *
 *   bun run test:chat            both roads
 *   bun run test:chat local      Set up points Claude Code at this computer's serve
 *   bun run test:chat cloud      Claude Code reaches serve through AgentUse Cloud
 *
 * Everything runs under a throwaway HOME, so none of the person's own skills,
 * plugins or MCP servers load. Claude Code is real; it signs in with
 * CLAUDE_CODE_OAUTH_TOKEN (make one with `claude setup-token`). The work
 * agent's model is the loopback mock from the dashboard E2E, so practice runs
 * never reach a provider. The cloud road runs `wrangler dev` from the sibling
 * agentuse-cloud checkout (AGENTUSE_CLOUD_REPO to move it) and reuses its
 * sign-in and connect scripts.
 *
 * What it cannot cover: Claude Code's own OAuth sign-in to Cloud (the cloud
 * road hands it a token in a header, as the plugin's sign-in would), and
 * other chat apps.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Road = 'local' | 'cloud';

const root = resolve(import.meta.dir, '..');
const cloudRepo = resolve(process.env.AGENTUSE_CLOUD_REPO ?? join(root, '..', 'agentuse-cloud'));
const CLOUD_BASE = 'http://localhost:8787';
const GOAL = '/automate Every weekday at 8am, read notes/inbox.md in this project and write a three-line summary of it to reports/daily.md.';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const children: ChildProcess[] = [];
let workspace: string | undefined;
let failures = 0;

function check(ok: unknown, message: string, detail = ''): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${message}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures += 1;
  return Boolean(ok);
}

function fail(message: string): never {
  throw new Error(message);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate a local port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Start a child that dies with this script. Output goes straight to `log`, which the cloud scripts read sign-in codes from. */
function start(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string }): ChildProcess {
  const fd = openSync(opts.log, 'a');
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  children.push(child);
  return child;
}

async function waitFor(url: string, child: ChildProcess, what: string, log: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`${what} exited during startup. Log: ${log}`);
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // Refused while starting.
    }
    await Bun.sleep(150);
  }
  fail(`${what} did not start within ${ms / 1000}s. Log: ${log}`);
}

/** Environment for anything that must see only the throwaway HOME. */
function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTUSE_') || key.startsWith('CLAUDE_CONFIG') || key === 'XDG_DATA_HOME' || key === 'XDG_CONFIG_HOME') delete env[key];
  }
  return { ...env, HOME: home, XDG_DATA_HOME: join(home, 'xdg'), NO_TTY: 'true', SLACK_APP_TOKEN: '', SLACK_BOT_TOKEN: '', ...extra };
}

async function seedProject(project: string): Promise<void> {
  await mkdir(join(project, 'agents'), { recursive: true });
  await mkdir(join(project, 'notes'), { recursive: true });
  await writeFile(join(project, 'ABOUT.md'), '---\nname: Chat Test\ndescription: A project for the chat path test\n---\n');
  await writeFile(join(project, 'notes', 'inbox.md'), '- Call the landlord about the leak\n- Renew the domain before Friday\n- Draft the Q4 plan\n');
  await writeFile(join(project, 'agents', 'hello.agentuse'), '---\nname: Hello\nmodel: demo:test\ndescription: Says hello\n---\n\nSay hello.\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'seed');
}

async function startServe(home: string, project: string, mockUrl: string, logDir: string): Promise<string> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = join(logDir, 'serve.log');
  const env = isolatedEnv(home, { OPENAI_BASE_URL: `${mockUrl}/v1`, AGENTUSE_CLOUD_URL: CLOUD_BASE });
  const serve = start(process.execPath, ['src/index.ts', 'serve', '--port', String(port), '--directory', project, '--no-log-file'], { cwd: root, env, log });
  await waitFor(`${base}/api`, serve, 'serve', log);
  const key = await fetch(`${base}/api/providers/api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', key: 'e2e-disposable-key' }),
  });
  if (!key.ok) fail(`could not give serve the mock provider key: ${key.status} ${await key.text()}`);
  return base;
}

interface ToolCall { name: string; input: Record<string, unknown>; isError?: boolean; result?: string }

/** The person's answer when Claude stops to confirm the computer and project, which it must do on the cloud road. */
const REPLY = 'Yes, use Test Mac and its only project. Go ahead and draft it.';
const MAX_REPLIES = 2;

const mcp = (call: ToolCall, tool: string) => call.name === `mcp__agentuse__${tool}`;

/**
 * Talk to Claude Code headless in the project and collect every tool it tried,
 * allowed or not. If it stops before drafting, answer once or twice as the person would.
 */
function runClaude(home: string, project: string, logDir: string): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  let sessionId: string | undefined;
  let transcript = '';
  for (let turn = 0; turn <= MAX_REPLIES; turn += 1) {
    const result = spawnSync('claude', [
      '-p', turn === 0 ? GOAL : REPLY,
      ...(sessionId ? ['--resume', sessionId] : []),
      '--output-format', 'stream-json', '--verbose',
      '--max-turns', '40',
      // MCP tools and reading are allowed; anything else is denied but still shows up as an attempt.
      '--allowedTools', 'mcp__agentuse', 'Read', 'Glob', 'Grep', 'Skill',
    ], { cwd: project, env: isolatedEnv(home), encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    transcript += result.stdout ?? '';
    void writeFile(join(logDir, 'claude.jsonl'), transcript);
    if (result.error) fail(`claude failed to run: ${result.error.message}`);
    for (const line of (result.stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type: string; session_id?: string; message?: { content?: unknown }; result?: string; is_error?: boolean };
      sessionId = event.session_id ?? sessionId;
      const content = Array.isArray(event.message?.content) ? event.message.content as Array<Record<string, unknown>> : [];
      for (const part of content) {
        if (part.type === 'tool_use') calls.set(String(part.id), { name: String(part.name), input: (part.input ?? {}) as Record<string, unknown> });
        if (part.type === 'tool_result') {
          const call = calls.get(String(part.tool_use_id));
          if (call) {
            call.isError = part.is_error === true;
            call.result = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
          }
        }
      }
      if (event.type === 'result' && event.is_error) fail(`Claude Code ended with an error: ${event.result ?? ''}`);
    }
    if ([...calls.values()].some((c) => mcp(c, 'draft_agent'))) break;
    if (turn < MAX_REPLIES) console.log(`  Claude stopped before drafting; replying: "${REPLY}"`);
  }
  return [...calls.values()];
}

function judge(road: Road, project: string, calls: ToolCall[]): void {
  console.log(`  tools tried: ${calls.map((c) => c.name.replace('mcp__agentuse__', '')).join(', ') || 'none'}`);
  const drafts = calls.filter((c) => mcp(c, 'draft_agent'));
  check(drafts.length > 0, 'made the agent with draft_agent');
  check(drafts.some((c) => !c.isError && !/"isError":true/.test(c.result ?? '')), 'draft_agent accepted a draft', drafts.map((c) => c.result?.slice(0, 300)).join('\n      '));
  check(calls.some((c) => mcp(c, 'test_draft')), 'practice-ran the draft with test_draft');
  check(!calls.some((c) => mcp(c, 'apply_draft')), 'did not turn the agent on without a yes');
  const fileWrites = calls.filter((c) => FILE_TOOLS.has(c.name));
  check(fileWrites.length === 0, 'never tried to write files itself', fileWrites.map((c) => `${c.name} ${String(c.input.file_path ?? '')}`).join(', '));
  const cli = calls.filter((c) => c.name === 'Bash' && /\bagentuse\b/.test(String(c.input.command ?? '')));
  check(cli.length === 0, 'never tried the agentuse command line', cli.map((c) => String(c.input.command)).join(' | '));
  if (road === 'cloud') {
    const first = calls.findIndex((c) => c.name.startsWith('mcp__agentuse__') && !mcp(c, 'list_machines') && !mcp(c, 'get_workflow'));
    check(first >= 0 && mcp(calls[first]!, 'choose_context'), 'picked a computer and project with choose_context first', calls[first]?.name);
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).stdout.trim();
  check(status === '', 'project files untouched (drafts live in AgentUse, not the repo)', status);
}

async function setUpLocal(home: string, base: string): Promise<void> {
  // The real Set up button: writes ~/.claude.json and the automate skill.
  const res = await fetch(`${base}/api/coding-agents/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'claude-code' }),
  });
  const body = await res.json() as { agent?: { state?: string } };
  if (!check(res.ok && body.agent?.state === 'set-up', 'Set up added AgentUse to Claude Code', JSON.stringify(body))) fail('Set up failed');
  const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, { url?: string }> };
  check(config.mcpServers?.agentuse?.url === `${base}/mcp`, 'Claude Code points at this computer', JSON.stringify(config.mcpServers));
}

function python(args: string[], env: NodeJS.ProcessEnv, what: string): string {
  const result = spawnSync('python3', args, { cwd: cloudRepo, env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) fail(`${what} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function startCloud(logDir: string): Promise<string> {
  if (!existsSync(join(cloudRepo, 'wrangler.jsonc'))) fail(`agentuse-cloud not found at ${cloudRepo} (set AGENTUSE_CLOUD_REPO)`);
  if (!existsSync(join(cloudRepo, '.dev.vars'))) fail(`${cloudRepo}/.dev.vars is missing; see its README "Run it locally"`);
  const busy = spawnSync('lsof', ['-nP', '-iTCP:8787', '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
  if (busy) fail(`port 8787 is taken; stop the other wrangler dev first:\n${busy}`);
  const state = join(logDir, 'wrangler-state');
  const migrate = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'agentuse-relay', '--local', '--persist-to', state],
    { cwd: cloudRepo, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (migrate.status !== 0) fail(`D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  const log = join(logDir, 'wrangler.log');
  const dev = start('pnpm', ['exec', 'wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1', '--persist-to', state], { cwd: cloudRepo, env: process.env, log });
  await waitFor(`${CLOUD_BASE}/.well-known/oauth-protected-resource`, dev, 'wrangler dev', log, 90_000);
  return log;
}

/** Connect the computer to the local Cloud and return an MCP token, as the plugin's sign-in would. */
async function connectCloud(home: string, wranglerLog: string): Promise<string> {
  python(['scripts/connect-flow-check.py', wranglerLog, root, home], isolatedEnv(home), 'agentuse connect');
  check(existsSync(join(home, '.agentuse', 'cloud.json')), 'agentuse connect saved this computer\'s token');
  const { email } = JSON.parse(await readFile(join(home, 'flow-state.json'), 'utf8')) as { email: string };
  const out = python(['-c', [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("h", "scripts/oauth_helpers.py"); h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)',
    'h.sign_in(sys.argv[1], email=sys.argv[2])',
    'print("TOKEN=" + h.oauth_token(scope="agents:read agents:draft agents:run projects:read offline_access"))',
  ].join('\n'), wranglerLog, email], process.env, 'chat sign-in');
  return /TOKEN=(\S+)/.exec(out)?.[1] ?? fail(`no token in sign-in output:\n${out}`);
}

async function waitOnline(token: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = '';
  while (Date.now() < deadline) {
    const res = await fetch(`${CLOUD_BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_machines', arguments: {} } }),
    });
    last = await res.text();
    if (/"online":\s*true/.test(last)) return void check(true, 'the computer is online in Cloud');
    await Bun.sleep(500);
  }
  check(false, 'the computer is online in Cloud', last.slice(0, 300));
  fail('serve never came online in Cloud');
}

async function setUpCloud(home: string, token: string): Promise<void> {
  // What the plugin adds: only the Cloud MCP server. The token stands in for its OAuth sign-in.
  await writeFile(join(home, '.claude.json'), `${JSON.stringify({
    mcpServers: { agentuse: { type: 'http', url: `${CLOUD_BASE}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
  }, null, 2)}\n`);
}

async function runRoad(road: Road, mockUrl: string): Promise<void> {
  console.log(`\n${road === 'local' ? 'Local road: Set up → serve on this computer' : 'Cloud road: plugin → AgentUse Cloud → serve'}`);
  const dir = join(workspace!, road);
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  await mkdir(join(home, '.claude'), { recursive: true });
  await seedProject(project);

  if (road === 'local') {
    const base = await startServe(home, project, mockUrl, dir);
    await setUpLocal(home, base);
  } else {
    const wranglerLog = await startCloud(dir);
    const token = await connectCloud(home, wranglerLog);
    await startServe(home, project, mockUrl, dir); // after connect: serve opens its line to Cloud at startup
    await waitOnline(token);
    await setUpCloud(home, token);
  }

  console.log('  running Claude Code (a few minutes)…');
  judge(road, project, runClaude(home, project, dir));
  console.log(`  logs: ${dir}`);
}

async function main(): Promise<void> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    fail('CLAUDE_CODE_OAUTH_TOKEN is not set. Make one with `claude setup-token`, then run under agent-secret-run or export it.');
  }
  const arg = process.argv[2];
  const roads: Road[] = arg === 'local' || arg === 'cloud' ? [arg] : ['local', 'cloud'];
  workspace = await mkdtemp(join(tmpdir(), 'agentuse-chat-e2e-'));

  const mockPort = await freePort();
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const mockLog = join(workspace, 'mock.log');
  const mock = start(process.execPath, ['scripts/e2e-author-server.ts', String(mockPort)], { cwd: root, env: process.env, log: mockLog });
  await waitFor(`${mockUrl}/requests`, mock, 'mock model', mockLog);

  for (const road of roads) await runRoad(road, mockUrl);
}

let crashed = false;
try {
  await main();
} catch (error) {
  crashed = true;
  console.error(`\n✗ ${(error as Error).message}`);
} finally {
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await Bun.sleep(500);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
}
if (crashed || failures > 0) {
  console.log(`\nFAIL${failures ? ` (${failures} check${failures === 1 ? '' : 's'})` : ''}. Logs kept in ${workspace}`);
  process.exit(1);
}
console.log('\nPASS');
if (workspace) await rm(workspace, { recursive: true, force: true });
