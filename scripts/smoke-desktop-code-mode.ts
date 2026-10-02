/**
 * Exercise the shipped CLI, compiler child, QuickJS, and filesystem dispatcher.
 * Only the model is a loopback stub. Tools execute against a disposable project;
 * no development modules or external provider credentials are used by the app.
 *
 * bun scripts/smoke-desktop-code-mode.ts /path/to/AgentUse.app
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface ModelRequest {
  stream?: boolean;
  messages?: Array<{ role: string; tool_call_id?: string; content?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

interface CodeResult {
  status?: string;
  error?: { message?: string };
  value?: { sum?: number; last?: number };
  telemetry?: { nestedCalls?: number };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function toolResponse(name: string, id: string, input: Record<string, unknown>, stream: boolean): Response {
  const tool = { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
  const common = { id: 'desktop-smoke', created: 0, model: 'desktop-smoke' };
  const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
  if (!stream) {
    return Response.json({ ...common, object: 'chat.completion', usage,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tool] }, finish_reason: 'tool_calls' }] });
  }
  const chunks = [
    { ...common, object: 'chat.completion.chunk', choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] },
    { ...common, object: 'chat.completion.chunk', usage,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function runCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cli, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-24_000); });
    child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-24_000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun(output);
      else reject(new Error(`Packaged CLI ${args[0]} failed (${signal ?? code}):\n${output}`));
    });
  });
}

export async function smokeDesktopCodeMode(appDir: string): Promise<void> {
  const cli = join(appDir, 'Contents', 'Resources', 'bin', 'agentuse');
  check(existsSync(cli), `Packaged CLI not found: ${cli}`);
  const workspace = await mkdtemp(join(tmpdir(), 'agentuse-desktop-code-mode-'));
  const project = join(workspace, 'project');
  const rejectedPath = join(project, 'must-not-exist.txt');
  const writtenPath = join(project, 'result.json');
  const agent = join(project, 'smoke.agentuse');
  let rejected = false;
  let completed = false;
  let failure: Error | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        try {
          check(new URL(request.url).pathname === '/v1/chat/completions', 'Unexpected model endpoint');
          const body = await request.json() as ModelRequest;
          check(body.tools?.some(tool => tool.function?.name === 'code_exec'), 'Packaged run did not expose code_exec');
          const result = (id: string): CodeResult | undefined => {
            const message = body.messages?.find(item => item.role === 'tool' && item.tool_call_id === id);
            return message?.content ? JSON.parse(message.content) as CodeResult : undefined;
          };
          const invalid = result('smoke-invalid');
          if (!invalid) {
            return toolResponse('code_exec', 'smoke-invalid', {
              code: `const n: number = "bad"; await tools.tools__filesystem_write({ file_path: ${JSON.stringify(rejectedPath)}, content: String(n) });`,
            }, body.stream === true);
          }
          check(invalid.status === 'failed' && invalid.error?.message?.includes('TS2322'),
            `Packaged TypeScript preflight did not return the expected diagnostic: ${JSON.stringify(invalid)}`);
          check(invalid.telemetry?.nestedCalls === 0 && !existsSync(rejectedPath), 'Invalid TypeScript executed a filesystem write');
          rejected = true;
          const valid = result('smoke-valid');
          if (!valid) {
            return toolResponse('code_exec', 'smoke-valid', {
              code: `const values = await Promise.all([2, 3].map(async n => n * 2));
const sums = new Map<string, number>([["sum", values.reduce((a, b) => a + b, 0)]]);
const value = { sum: sums.get("sum"), last: values.at(-1) };
await tools.tools__filesystem_write({ file_path: ${JSON.stringify(writtenPath)}, content: JSON.stringify(value) });
return value;`,
            }, body.stream === true);
          }
          check(valid.status === 'completed' && valid.value?.sum === 10 && valid.value?.last === 6
            && valid.telemetry?.nestedCalls === 1, `Packaged code_exec failed: ${JSON.stringify(valid)}`);
          completed = true;
          return toolResponse('report_outcome', 'smoke-complete', {
            status: 'complete', headline: 'Packaged Code Mode smoke passed', artifacts: [writtenPath],
          }, body.stream === true);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          return new Response(failure.message, { status: 400 });
        }
      },
    });
    await mkdir(project, { recursive: true });
    await mkdir(join(workspace, 'config'));
    await writeFile(agent, `---
model: openai:desktop-smoke
description: Exercise the packaged Code Mode runtime in a disposable project
intent: false
maxSteps: 4
skills:
  auto: false
tools:
  filesystem:
    - path: "."
      permissions: [read, write]
---
Validate Code Mode type errors, then write the computed result to result.json.
`);
    // Do not inherit credentials, model overrides, mock modes, or NODE_PATH from
    // the host. The packaged app must supply all of its own runtime dependencies.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      AGENTUSE_DATA_DIR: join(workspace, 'state'),
      AGENTUSE_CONFIG_DIR: join(workspace, 'config'),
      AGENTUSE_TELEMETRY_DISABLED: 'true',
      OPENAI_API_KEY: 'desktop-smoke-disposable',
      OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    };
    await runCli(cli, ['doctor', agent], project, env);
    const output = await runCli(cli, ['run', agent, '--json', '--timeout', '45'], project, env);
    if (failure) throw failure;
    check(rejected && completed, `Packaged run did not exercise both code_exec cases:\n${output}`);
    check(!existsSync(rejectedPath), 'Invalid TypeScript wrote a file');
    const written = JSON.parse(await readFile(writtenPath, 'utf8')) as { sum: number; last: number };
    check(written.sum === 10 && written.last === 6, 'Packaged filesystem tool wrote the wrong result');
    console.log('Desktop Code Mode passed: invalid types rejected before tools; Promise/Map/Array.at and filesystem write executed.');
  } catch (error) {
    throw failure ?? error;
  } finally {
    server?.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const appDir = process.argv[2];
  if (!appDir) throw new Error('Usage: bun scripts/smoke-desktop-code-mode.ts /path/to/AgentUse.app');
  await smokeDesktopCodeMode(resolve(appDir));
}
