/**
 * New-user onboarding, end to end, in a clean macOS VM: a headless Claude Code
 * follows the agentuse-dev-testing skill (build this branch, copy it into the
 * VM, reset to a new user, walk setup with a screenshot of every step) and
 * hands back a verdict this script turns into an exit code.
 *
 *   bun run test:onboarding        the Mac app and the CLI
 *   bun run test:onboarding app    the Mac app only
 *   bun run test:onboarding cli    `agentuse setup` in a terminal only
 *
 * An agent drives it rather than a fixed script because the screens change
 * often and the point is what a person would notice, not that one label still
 * matches. It needs what the skill needs: the cua MCP server, the VM host
 * reachable, and a Claude Code login (it uses yours, and takes a while).
 * Local only; nothing here can run on CI.
 *
 * Exit code: 0 pass, 1 a new user would hit a problem, 2 the test could not run.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const FLOWS = { app: 'the Mac app, from first launch', cli: '`agentuse setup` in a terminal' } as const;
type Flow = keyof typeof FLOWS;
const TIMEOUT_MS = 75 * 60_000;

interface StepReport { name: string; ok: boolean; screenshot?: string; note?: string }
interface FlowReport { name: string; verdict: 'pass' | 'fail' | 'blocked'; ran_this_branch: string; steps: StepReport[] }
interface Report {
  verdict: 'pass' | 'fail' | 'blocked';
  summary: string;
  flows: FlowReport[];
  concerns: string[];
  could_not_test: string[];
  artifact_url?: string;
}

const schema = {
  type: 'object',
  required: ['verdict', 'summary', 'flows', 'concerns', 'could_not_test'],
  properties: {
    verdict: { enum: ['pass', 'fail', 'blocked'] },
    summary: { type: 'string' },
    flows: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'verdict', 'ran_this_branch', 'steps'],
        properties: {
          name: { type: 'string' },
          verdict: { enum: ['pass', 'fail', 'blocked'] },
          ran_this_branch: { type: 'string', description: 'The proof that the build under test answered, or why there is none' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'ok'],
              properties: { name: { type: 'string' }, ok: { type: 'boolean' }, screenshot: { type: 'string' }, note: { type: 'string' } },
            },
          },
        },
      },
    },
    concerns: { type: 'array', items: { type: 'string' } },
    could_not_test: { type: 'array', items: { type: 'string' } },
    artifact_url: { type: 'string' },
  },
};

function prompt(flows: Flow[], runDir: string): string {
  return `/agentuse-dev-testing Run this as an automated end-to-end test of new-user onboarding for the code on the current branch. Nobody is watching, so do not ask questions: decide, and report.

Flows to walk, each from a full reset: ${flows.map((flow) => FLOWS[flow]).join('; ')}.

Save the screenshots and index.md in ${runDir}.

What passing means, per flow: the VM ran the build made from this branch (the skill's proof of what answered), and a new user gets from the first screen to a working AgentUse (the dashboard opens and loads, or setup finishes and the service answers) without an error, a dead end, a screen that stays stuck, or a step they could not work out. Use the skill's proxy model for the AI step.

Report three different things, and keep them apart:
- fail: something a new user would hit. Name the step and its screenshot.
- concerns: things that look off but did not stop the flow (wording, layout, a slow step). These do not fail the test.
- blocked: the test itself could not run (VM unreachable, upload failed, build failed). Say what stopped it. A flow you could not reach is blocked, not passed.

The overall verdict is fail if any flow failed, otherwise blocked if any flow was blocked, otherwise pass. Before you finish, stop anything you started on the VM host, as the skill says. Do not post a handback card or submit an artifact: whoever ran this test reports its result.`;
}

const asked = process.argv.slice(2);
const unknown = asked.filter((flow) => !(flow in FLOWS));
if (unknown.length) {
  console.error(`Unknown flow: ${unknown.join(', ')}. Use app, cli, or nothing for both.`);
  process.exit(2);
}
const flows = (asked.length ? asked : Object.keys(FLOWS)) as Flow[];
const runDir = resolve(root, 'tmp', `onboarding-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(runDir, { recursive: true });
const transcriptPath = resolve(runDir, 'claude.jsonl');
const transcript = createWriteStream(transcriptPath);
console.log(`Onboarding e2e: ${flows.join(' + ')}. This takes a while. Transcript: ${transcriptPath}`);

const child = spawn('claude', [
  '-p', prompt(flows, runDir),
  '--output-format', 'stream-json', '--verbose',
  '--json-schema', JSON.stringify(schema),
], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
const timer = setTimeout(() => { console.error('Timed out; stopping Claude Code.'); child.kill(); }, TIMEOUT_MS);

interface ResultEvent { type: 'result'; is_error?: boolean; result?: string; structured_output?: Report }
let final: ResultEvent | undefined;
let pending = '';
child.stdout.on('data', (chunk: Buffer) => {
  transcript.write(chunk);
  pending += String(chunk);
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: { type?: string; message?: { content?: unknown } };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event.type === 'result') final = event as ResultEvent;
    const content = Array.isArray(event.message?.content) ? event.message.content as Array<{ type?: string; text?: string }> : [];
    // Claude's own words are the progress log; tool traffic stays in the transcript.
    for (const part of content) if (event.type === 'assistant' && part.type === 'text' && part.text?.trim()) console.log(`  ${part.text.trim().split('\n')[0]}`);
  }
});
const exitCode = await new Promise<number | null>((done) => child.on('close', done));
clearTimeout(timer);
transcript.end();

const report = final?.structured_output;
if (!report || final?.is_error) {
  console.error(`\nClaude Code ended without a verdict (exit ${exitCode}). ${final?.result ?? ''}\nRead ${transcriptPath}`);
  process.exit(2);
}
await writeFile(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n${report.verdict.toUpperCase()}: ${report.summary}`);
for (const flow of report.flows) {
  console.log(`\n${flow.name}: ${flow.verdict}\n  ran this branch: ${flow.ran_this_branch}`);
  for (const step of flow.steps) console.log(`  ${step.ok ? '✓' : '✗'} ${step.name}${step.note ? ` (${step.note})` : ''}${step.screenshot ? ` [${step.screenshot}]` : ''}`);
}
if (report.concerns.length) console.log(`\nLooks off, did not block:\n${report.concerns.map((item) => `  - ${item}`).join('\n')}`);
if (report.could_not_test.length) console.log(`\nCould not test:\n${report.could_not_test.map((item) => `  - ${item}`).join('\n')}`);
console.log(`\nScreenshots and report: ${runDir}${report.artifact_url ? `\nArtifact: ${report.artifact_url}` : ''}`);
process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2);
