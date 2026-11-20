/**
 * Draws the three MCP cards in a real browser, in every state they have, with
 * no chat app and no Cloud. scripts/lib/card-host.ts stands in for the app.
 *
 *   bun run test:cards            every state
 *   bun run test:cards <name>     states whose name contains <name>
 *
 * The card tests in tests/ only prove the bundles are fresh. This proves what a
 * person sees: the words and buttons for each state, what the card asks the app
 * to do when a button is pressed, and that nothing runs off the side at a
 * narrow chat width. Screenshots land in tmp/cards/ for a look by eye.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONTEXT_PICKER_HTML } from '../src/generated/mcp-context-picker';
import { DRAFT_CARD_HTML } from '../src/generated/mcp-draft-card';
import { GET_STARTED_HTML } from '../src/generated/mcp-get-started';
import type { ContextPickerResult, GetStartedResult } from '../src/mcp-server/context-protocol';
import type { CardScenario, CardSnapshot } from './lib/card-host';

const root = resolve(import.meta.dir, '..');
const shots = resolve(root, 'tmp/cards');
const session = `agentuse-cards-${process.pid}`;
const cards: Record<string, string> = { 'get-started': GET_STARTED_HTML, 'context-picker': CONTEXT_PICKER_HTML, 'draft-card': DRAFT_CARD_HTML };

interface Expectation {
  shows?: string[];
  hides?: string[];
  buttons?: string[];
  asked?: (log: CardSnapshot['log']) => boolean;
}

interface Step extends Expectation {
  press?: string;
  choose?: { field: string; value: string };
}

interface Case {
  name: string;
  card: keyof typeof cards;
  hostName?: string;
  toolResult: Record<string, unknown>;
  tools?: CardScenario['tools'];
  first: Expectation;
  then?: Step[];
}

const links = {
  connect_url: 'https://cloud.agentuse.io/connect',
  download_url: 'https://agentuse.io/api/download/mac/apple-silicon',
  install_command: 'curl -fsSL https://agentuse.io/install.sh | sh -s -- --cloud',
};
const account = 'test+cards@stepcase.net';
const longMachine = { id: 'm1', name: 'a-very-long-machine-name-that-has-to-wrap.local', online: true };
const getStarted = (result: Omit<GetStartedResult, keyof typeof links>): Record<string, unknown> => ({ ...links, ...result });
const called = (name: string) => (log: CardSnapshot['log']) => log.some((entry) => entry.call === name);
const sentMessage = (log: CardSnapshot['log']) => log.some((entry) => 'message' in entry);
const signInFirst: Expectation = { shows: ['Set up AgentUse', 'Sign in to AgentUse Cloud'], buttons: ['Sign in'] };

const picker: ContextPickerResult = {
  machines: [{ id: 'm1', name: 'Studio', online: true }, { id: 'm2', name: 'Old Mini', online: false }],
  machine_id: 'm1',
  projects: [{ id: 'p1', name: 'my-agents' }, { id: 'p2', name: 'Revenue Operations' }],
  context: 'ctx-1',
  selection: { machine: { id: 'm1', name: 'Studio' }, project: { id: 'p1', name: 'my-agents' } },
};
const draft = {
  id: 'd1', project: 'p1', kind: 'draft', name: 'Daily summary', summary: 'Reads notes/inbox.md and writes a three-line summary.',
  schedule: 'Weekdays at 8am', review_url: 'https://cloud.agentuse.io/review/d1', files: [{ path: 'agents/daily-summary.agentuse', op: 'create' }],
};

const cases: Case[] = [
  {
    name: 'get-started sign in, Claude Code',
    card: 'get-started',
    toolResult: getStarted({ state: 'sign_in', client: 'claude-code' }),
    first: signInFirst,
    then: [{ press: 'Sign in', shows: ['Type /mcp, choose agentuse, then Authenticate.'], hides: ['codex mcp login'], buttons: ['Check again'], asked: (log) => called('list_machines')(log) && !sentMessage(log) }],
  },
  {
    name: 'get-started sign in, Codex',
    card: 'get-started',
    toolResult: getStarted({ state: 'sign_in', client: 'codex' }),
    first: signInFirst,
    then: [{ press: 'Sign in', shows: ['Press Connect when Codex asks', 'codex mcp login agentuse'], hides: ['/mcp, choose'], buttons: ['Copy', 'Check again'], asked: sentMessage }],
  },
  {
    name: 'get-started sign in, Codex known only by the app name',
    card: 'get-started',
    hostName: 'Codex',
    toolResult: getStarted({ state: 'sign_in' }),
    first: signInFirst,
    then: [{ press: 'Sign in', shows: ['codex mcp login agentuse'], asked: sentMessage }],
  },
  {
    name: 'get-started sign in, another app',
    card: 'get-started',
    toolResult: getStarted({ state: 'sign_in' }),
    first: signInFirst,
    then: [{ press: 'Sign in', shows: ['connector settings'], hides: ['codex mcp login', '/mcp, choose'], asked: (log) => !sentMessage(log) }],
  },
  {
    name: 'get-started sign in, already signed in',
    card: 'get-started',
    toolResult: getStarted({ state: 'sign_in' }),
    tools: { list_machines: {}, get_started: getStarted({ state: 'no_machine', account }) },
    first: signInFirst,
    then: [{ press: 'Sign in', shows: [`Signed in as ${account}`, 'Download for Mac'], hides: ['Sign in to AgentUse Cloud'] }],
  },
  {
    name: 'get-started no machine',
    card: 'get-started',
    toolResult: getStarted({ state: 'no_machine', account }),
    first: { shows: [`Signed in as ${account}`, links.install_command], buttons: ['Download for Mac', 'Copy', 'Open cloud.agentuse.io/connect'] },
    then: [
      { press: 'Download for Mac', asked: (log) => log.some((entry) => entry.open === links.download_url) },
      { press: 'Open cloud.agentuse.io/connect', shows: ['Waiting for your machine', 'AgentUse is on your machine'], asked: (log) => log.some((entry) => entry.open === links.connect_url) },
    ],
  },
  {
    name: 'get-started ready',
    card: 'get-started',
    toolResult: getStarted({ state: 'ready', account, machine: longMachine, project: 'my-agents', request: 'summarize my inbox every weekday at 8am' }),
    first: { shows: ['AgentUse is ready', `${longMachine.name} · online`, 'Picking up where you left off'], buttons: ['Continue my request', 'Open dashboard'] },
    then: [{ press: 'Continue my request', shows: ['Continuing your request.'], asked: sentMessage }],
  },
  {
    name: 'get-started offline',
    card: 'get-started',
    toolResult: getStarted({ state: 'offline', machine: { id: 'm1', name: 'Studio', online: false, lastSeen: Date.now() - 3 * 60 * 60 * 1000 } }),
    tools: { get_started: getStarted({ state: 'offline', machine: { id: 'm1', name: 'Studio', online: false } }) },
    first: { shows: ['Studio is offline', 'last seen 3 hours ago', 'Waiting on you'], buttons: ['Check again', 'Use another machine'] },
    then: [
      { press: 'Check again', shows: ['Still offline. Checked'], asked: called('get_started') },
      { press: 'Use another machine', shows: ['Download for Mac'], hides: ['is offline'] },
    ],
  },
  {
    name: 'picker choose and confirm',
    card: 'context-picker',
    toolResult: { machines: picker.machines },
    tools: { choose_context: { ...picker } },
    first: { shows: ['Choose where to work', 'Old Mini (offline)', 'Revenue Operations'], buttons: ['Continue (off)', 'Refresh'], asked: called('choose_context') },
    then: [
      { choose: { field: 'project', value: 'p1' }, buttons: ['Continue', 'Refresh'] },
      { press: 'Continue', shows: ['Destination selected', 'Studio', 'my-agents'], asked: (log) => log.some((entry) => 'context' in entry) && sentMessage(log) },
    ],
  },
  {
    name: 'picker nothing online',
    card: 'context-picker',
    toolResult: { machines: [{ id: 'm2', name: 'Old Mini', online: false }], setup_url: links.connect_url },
    first: { shows: ['Old Mini (offline)'], buttons: ['Continue (off)', 'Refresh', 'Connect a computer'] },
  },
  {
    name: 'draft that a yes can turn on',
    card: 'draft-card',
    toolResult: { ...draft, can_turn_on_by_yes: true },
    tools: { apply_draft: {} },
    first: { shows: ['Daily summary', 'Weekdays at 8am', 'agents/daily-summary.agentuse'], hides: ['Needs your review'], buttons: ['Turn on', 'Details'] },
    then: [{ press: 'Turn on', shows: ['On. You can undo it from the notification.'], buttons: ['Details'], asked: called('apply_draft') }],
  },
  {
    name: 'draft that needs review, with reasons',
    card: 'draft-card',
    toolResult: { ...draft, can_turn_on_by_yes: false, needs_review_because: ['sends email', 'runs shell commands'] },
    first: { shows: ['Needs your review, because it sends email, runs shell commands.'], buttons: ['Review and apply'] },
    then: [{ press: 'Review and apply', asked: (log) => log.some((entry) => entry.open === draft.review_url) }],
  },
  {
    name: 'draft that needs review, no reason given',
    card: 'draft-card',
    toolResult: { ...draft, can_turn_on_by_yes: false },
    first: { shows: ['Needs your review, because it needs a closer look.'], hides: ['it it'], buttons: ['Review and apply'] },
  },
  {
    name: 'fix that a yes can apply',
    card: 'draft-card',
    toolResult: { ...draft, kind: 'fix', can_turn_on_by_yes: true },
    tools: { apply_draft: {} },
    first: { shows: ['Fix ready'], buttons: ['Apply fix', 'Details'] },
  },
];

const failures: string[] = [];

function browser(args: string[]): Promise<string> {
  return new Promise((done, failed) => {
    // Not spawnSync: this process also serves the page the browser is loading.
    const child = spawn('agent-browser', ['--session', session, ...args], { cwd: root, env: { ...process.env, AGENT_BROWSER_HEADED: 'false' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', failed);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout.trim());
      else failed(new Error(`agent-browser ${args[0]} failed:\n${stderr || stdout}`));
    });
  });
}

async function snapshot(): Promise<CardSnapshot> {
  return JSON.parse(JSON.parse(await browser(['eval', 'window.cardSnapshot()'])) as string) as CardSnapshot;
}

/** Waits for the card to meet the expectation, since it redraws after each answer from the app. */
async function expectCard(label: string, expected: Expectation): Promise<void> {
  const deadline = Date.now() + 5000;
  let problems: string[] = [];
  for (;;) {
    const seen = await snapshot();
    // Compared without case: a card may capitalise a label in CSS.
    const text = seen.text.toLowerCase();
    problems = [
      ...(expected.shows ?? []).filter((wanted) => !text.includes(wanted.toLowerCase())).map((wanted) => `does not show "${wanted}"`),
      ...(expected.hides ?? []).filter((unwanted) => text.includes(unwanted.toLowerCase())).map((unwanted) => `shows "${unwanted}"`),
      ...(expected.buttons && expected.buttons.join(' | ') !== seen.buttons.join(' | ') ? [`buttons are [${seen.buttons.join(' | ')}], not [${expected.buttons.join(' | ')}]`] : []),
      ...(expected.asked && !expected.asked(seen.log) ? [`asked the app for the wrong things: ${JSON.stringify(seen.log)}`] : []),
      ...(seen.overflows ? ['runs off the side'] : []),
    ];
    if (!problems.length || Date.now() > deadline) break;
    await Bun.sleep(150);
  }
  if (problems.length) {
    failures.push(...problems.map((problem) => `${label}: ${problem}`));
    console.log(`  ✗ ${label}\n      ${problems.join('\n      ')}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

if (spawnSync('agent-browser', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error('agent-browser is required for test:cards (install it with `npm install -g agent-browser`)');
  process.exit(1);
}

const host = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'lib/card-host.ts')], target: 'browser', format: 'esm' });
if (!host.success) {
  for (const entry of host.logs) console.error(entry);
  throw new Error('Could not bundle the card host page');
}
const hostScript = await host.outputs[0]!.text();
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/card/')) return new Response(cards[path.slice('/card/'.length)] ?? '', { headers: { 'Content-Type': 'text/html' } });
    if (path === '/host.js') return new Response(hostScript, { headers: { 'Content-Type': 'text/javascript' } });
    return new Response('<!doctype html><body style="margin:0;background:#fff"><script type="module" src="/host.js"></script>', { headers: { 'Content-Type': 'text/html' } });
  },
});

const only = process.argv[2];
const chosen = cases.filter((item) => !only || item.name.includes(only));
await mkdir(shots, { recursive: true });
try {
  for (const [index, item] of chosen.entries()) {
    // Alternate so every card is seen narrow and wide, light and dark, across the run.
    const scenario: CardScenario = {
      card: item.card,
      width: index % 2 ? 420 : 300,
      theme: index % 2 ? 'light' : 'dark',
      toolResult: item.toolResult,
      ...(item.hostName ? { hostName: item.hostName } : {}),
      ...(item.tools ? { tools: item.tools } : {}),
    };
    const file = item.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await browser(['open', `${server.url}?s=${encodeURIComponent(JSON.stringify(scenario))}`]);
    await expectCard(item.name, item.first);
    await browser(['screenshot', resolve(shots, `${file}.png`)]);
    for (const [stepIndex, step] of (item.then ?? []).entries()) {
      const action = step.press ? `window.cardPress(${JSON.stringify(step.press)})` : `window.cardChoose(${JSON.stringify(step.choose?.field)}, ${JSON.stringify(step.choose?.value)})`;
      try {
        await browser(['eval', action]);
      } catch (error) {
        failures.push(`${item.name}: ${(error as Error).message}`);
        console.log(`  ✗ ${item.name}: ${(error as Error).message}`);
        break;
      }
      await expectCard(`${item.name}, then ${step.press ?? `choose ${step.choose?.value}`}`, step);
      await browser(['screenshot', resolve(shots, `${file}-${stepIndex + 1}.png`)]);
    }
    const pageError = JSON.parse(await browser(['eval', 'window.cardError ?? ""'])) as string;
    if (pageError) failures.push(`${item.name}: page error: ${pageError}`);
  }
} finally {
  await browser(['close']).catch(() => undefined);
  await server.stop(true);
}

if (failures.length) {
  console.error(`\n${failures.length} card problem${failures.length === 1 ? '' : 's'}:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${chosen.length} card states look right. Screenshots: ${shots}`);
