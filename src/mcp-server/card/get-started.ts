/**
 * The setup card Cloud's get_started tool draws: sign in, get AgentUse on a
 * machine, connect it. Works before sign-in. Runs in the host's sandboxed
 * frame; scripts/build-mcp-card.ts bundles it into
 * src/generated/mcp-get-started.ts.
 */
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { GET_STARTED_TOOL, type GetStartedArgs, type GetStartedResult } from '../context-protocol';

const POLL_MS = 3000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const CODEX_LOGIN = 'codex mcp login agentuse';
const CONNECT_TEXT = 'It shows a code. Paste it at cloud.agentuse.io/connect.';

type View = 'auto' | 'waiting' | 'no_machine';

const root = document.getElementById('card')!;
const app = new App({ name: 'agentuse-get-started', version: '1.0.0' });
let data: GetStartedResult | undefined;
let request: string | undefined;
let view: View = 'auto';
let statusText = '';
let busy = false;
let copied = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollStarted = 0;
let pollExpired = false;
let showSignInHelp = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text: string, kind: 'primary' | 'secondary' | 'link' | 'copy', onClick: () => void, id?: string): HTMLButtonElement {
  const node = el('button', text, kind === 'secondary' ? undefined : kind);
  node.type = 'button';
  if (id) node.id = id;
  node.disabled = busy && kind !== 'copy' && kind !== 'link';
  node.onclick = onClick;
  return node;
}

function doneMark(): HTMLElement {
  const mark = el('span', '✓', 'mark done');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', 'Done');
  return mark;
}

interface StepSpec { done?: boolean; current?: boolean; title: string; text?: string; extra?: Node[] }

function steps(items: StepSpec[]): HTMLOListElement {
  const list = el('ol', undefined, 'steps');
  items.forEach((item, index) => {
    const row = el('li', undefined, item.current ? 'step current' : 'step');
    if (item.current) row.setAttribute('aria-current', 'step');
    const mark = item.done ? doneMark() : el('span', String(index + 1), 'mark');
    const body = el('div', undefined, 'body');
    body.append(el('span', item.title, 'name'));
    if (item.text) body.append(el('p', item.text));
    if (item.extra) body.append(...item.extra);
    row.append(mark, body);
    list.append(row);
  });
  return list;
}

function actions(...nodes: Node[]): HTMLDivElement {
  const row = el('div', undefined, 'actions');
  row.append(...nodes);
  return row;
}

function pill(text: string, kind: 'wait' | 'warn'): HTMLSpanElement {
  const node = el('span', undefined, `pill ${kind}`);
  node.append(el('span', undefined, 'dot'), document.createTextNode(text));
  return node;
}

function relative(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function open(url: string | undefined): void {
  if (url) void app.openLink({ url }).catch(() => undefined);
}

function signedInStep(d: GetStartedResult): StepSpec {
  return { done: true, title: d.account ? `Signed in as ${d.account}` : 'Signed in' };
}

type SignInApp = 'codex' | 'claude-code' | 'other';

function signInApp(): SignInApp {
  if (data?.client) return data.client;
  const host = app.getHostVersion()?.name ?? '';
  if (/codex|openai/i.test(host)) return 'codex';
  if (/claude[- ]?code/i.test(host)) return 'claude-code';
  return 'other';
}

/**
 * How to sign in from this app. Apps start sign-in themselves, from their own
 * connector settings; a card can't, and asking the model only loops back here.
 */
function signInSteps(): Node[] {
  const command = (text: string, value: string) => {
    const code = el('div', undefined, 'code');
    code.append(el('code', value), button(copied ? 'Copied' : 'Copy', 'copy', () => { void copy(value); }, 'copy'));
    return [el('p', text), code];
  };
  const kind = signInApp();
  if (kind === 'codex') return [...command('Press Connect when Codex asks. If it doesn\'t ask, run this in a terminal:', CODEX_LOGIN), el('p', 'If this card still says to sign in afterwards, restart Codex.', 'small')];
  if (kind === 'claude-code') return [el('p', 'Type /mcp, choose agentuse, then Authenticate.')];
  return [el('p', 'Open this app\'s connector settings, find AgentUse, and press Connect.')];
}

function renderSignIn(): Node[] {
  const extra = showSignInHelp
    ? [...signInSteps(), actions(button('Check again', 'secondary', () => { void signIn(); }, 'sign-in'))]
    : [actions(button('Sign in', 'primary', () => { void signIn(); }, 'sign-in'))];
  return [
    el('h1', 'Set up AgentUse'),
    el('p', 'Your agents run on your own machine. AgentUse Cloud passes messages between it and this chat.'),
    steps([
      { current: true, title: 'Sign in to AgentUse Cloud', text: 'With Google, GitHub, or a code sent to your email.', extra },
      { title: 'Get AgentUse on your machine', text: 'The Mac app, or one command on Linux or a Mac.' },
      { title: 'Connect the machine', text: CONNECT_TEXT },
    ]),
    el('p', 'Free account · 1 person · 1 machine', 'small'),
  ];
}

function renderNoMachine(d: GetStartedResult): Node[] {
  const code = el('div', undefined, 'code');
  code.append(el('code', d.install_command), button(copied ? 'Copied' : 'Copy', 'copy', () => { void copy(d.install_command); }, 'copy'));
  const download = actions(button('Download for Mac', 'primary', () => open(d.download_url), 'download'), el('span', 'Apple silicon · DMG', 'small'));
  return [
    el('h1', 'Set up AgentUse'),
    el('p', 'Next, put AgentUse on the machine your agents will run on.'),
    steps([
      signedInStep(d),
      { current: true, title: 'Get AgentUse on your machine', extra: [download, el('p', 'Or in a terminal on Linux or a Mac:'), code, el('p', 'In Claude Code or Codex, say “set it up” and it runs this for you.', 'small')] },
      { title: 'Connect the machine', text: CONNECT_TEXT, extra: [actions(button('Open cloud.agentuse.io/connect', 'secondary', () => { open(d.connect_url); startWaiting(); }, 'open-connect'))] },
    ]),
  ];
}

function renderWaiting(d: GetStartedResult): Node[] {
  const nodes: Node[] = [
    el('h1', 'Set up AgentUse'),
    el('p', 'Almost there. Connect the machine to finish.'),
    pill('Waiting for your machine', 'wait'),
    steps([
      signedInStep(d),
      { done: true, title: 'AgentUse is on your machine' },
      { current: true, title: 'Connect your machine', text: 'Your machine is showing a code. Paste it at cloud.agentuse.io/connect and press Connect.', extra: [actions(button('Open cloud.agentuse.io/connect', 'primary', () => open(d.connect_url), 'open-connect'))] },
    ]),
    el('p', 'This card updates by itself once the machine connects.', 'small'),
  ];
  if (pollExpired) nodes.push(actions(button('Check again', 'secondary', () => { startWaiting(); }, 'check-again')));
  return nodes;
}

function renderReady(d: GetStartedResult): Node[] {
  const machine = d.machine?.name ?? 'your machine';
  const facts = el('dl', undefined, 'facts');
  const fact = (label: string, value: string) => {
    const row = el('div', undefined, 'fact');
    const ok = el('span', '✓', 'ok');
    ok.setAttribute('role', 'img');
    ok.setAttribute('aria-label', 'Done');
    row.append(ok, el('dt', label), el('dd', value));
    facts.append(row);
  };
  if (d.account) fact('Account', d.account);
  fact('Machine', `${machine} · online`);
  if (d.project) fact('Project', d.project);
  let dashboard: string | undefined;
  try { dashboard = `${new URL(d.connect_url).origin}/`; } catch { dashboard = undefined; }
  const buttons = actions(button('Continue my request', 'primary', () => { void continueRequest(); }, 'continue'));
  if (dashboard) buttons.append(button('Open dashboard', 'link', () => open(dashboard), 'dashboard'));
  return [
    el('h1', 'AgentUse is ready'),
    el('p', `Agents you make here run on ${machine}, on schedule, even when this chat is closed.`),
    facts,
    buttons,
  ];
}

function renderOffline(d: GetStartedResult): Node[] {
  const machine = d.machine?.name ?? 'Your machine';
  const head = el('div', undefined, 'head');
  head.append(el('h1', `${machine} is offline`));
  if (d.machine?.lastSeen) head.append(el('span', `last seen ${relative(d.machine.lastSeen)}`, 'small'));
  const tips = el('ul', undefined, 'soft');
  const terminal = el('li');
  terminal.append(document.createTextNode('On Linux or a server, run '), el('code', 'agentuse status'));
  tips.append(el('li', 'Wake the Mac, or open the AgentUse app'), terminal);
  return [
    head,
    pill('Waiting on you', 'warn'),
    el('p', 'Your agents run on this machine, so it has to be on with AgentUse running. Nothing was lost; scheduled runs start again once it\'s back.'),
    tips,
    actions(
      button('Check again', 'primary', () => { void checkAgain(); }, 'check-again'),
      button('Use another machine', 'secondary', () => { view = 'no_machine'; statusText = ''; render(); }, 'another'),
    ),
  ];
}

function render(): void {
  const focusedId = document.activeElement?.id;
  const d = data;
  if (!d) {
    root.replaceChildren();
  } else if (d.state === 'sign_in') {
    root.replaceChildren(...renderSignIn());
  } else if (d.state === 'ready') {
    root.replaceChildren(...renderReady(d));
  } else if (view === 'waiting') {
    root.replaceChildren(...renderWaiting(d));
  } else if (d.state === 'offline' && view !== 'no_machine') {
    root.replaceChildren(...renderOffline(d));
  } else {
    root.replaceChildren(...renderNoMachine(d));
  }
  const shown = statusText || (d?.state === 'ready' && request ? `Picking up where you left off: “${request}”` : '');
  const status = el('p', shown, 'status');
  status.setAttribute('role', 'status');
  root.append(status);
  root.setAttribute('aria-busy', String(busy));
  if (focusedId) document.getElementById(focusedId)?.focus();
}

async function fetchState(): Promise<GetStartedResult> {
  const args: GetStartedArgs = request ? { request } : {};
  const result = await app.callServerTool({ name: GET_STARTED_TOOL, arguments: { ...args } });
  const content = result.structuredContent as GetStartedResult | undefined;
  if (result.isError || !content || typeof content.state !== 'string') {
    const text = result.content?.find(part => part.type === 'text');
    throw new Error(text && 'text' in text ? text.text : 'Could not check AgentUse. Try again.');
  }
  return content;
}

function receive(result: GetStartedResult): void {
  data = result;
  if (result.request) request = result.request;
  if (result.state === 'ready' || result.state === 'sign_in') view = 'auto';
  render();
}

function stopPolling(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

/** Polls get_started until `done` says the wait is over, for at most ten minutes. */
function poll(done: (result: GetStartedResult) => boolean): void {
  stopPolling();
  pollStarted = Date.now();
  pollExpired = false;
  const tick = async () => {
    pollTimer = undefined;
    try {
      const result = await fetchState();
      if (done(result)) { onPollDone(result); return; }
      if (data?.state !== result.state) { data = result; render(); }
    } catch {
      // A missed check is retried on the next tick.
    }
    if (Date.now() - pollStarted >= POLL_LIMIT_MS) { pollExpired = true; statusText = view === 'waiting' ? '' : statusText; render(); return; }
    pollTimer = setTimeout(() => { void tick(); }, POLL_MS);
  };
  pollTimer = setTimeout(() => { void tick(); }, POLL_MS);
}

function onPollDone(result: GetStartedResult): void {
  statusText = '';
  receive(result);
  if (result.state === 'ready') void tellModelReady(result);
}

async function tellModelReady(result: GetStartedResult): Promise<void> {
  const capabilities = app.getHostCapabilities();
  const machine = result.machine?.name ?? 'the machine';
  const text = `AgentUse is set up and ${machine} is online. Continue the user's request.`;
  const modalities = capabilities?.updateModelContext;
  if (!modalities?.text && !modalities?.structuredContent) return;
  await app.updateModelContext({
    ...(modalities.text ? { content: [{ type: 'text' as const, text }] } : {}),
    ...(modalities.structuredContent ? { structuredContent: { ...result } } : {}),
  }).catch(() => undefined);
}

function startWaiting(): void {
  view = 'waiting';
  statusText = '';
  render();
  poll(result => result.state === 'ready');
}

async function signIn(): Promise<void> {
  busy = true;
  statusText = '';
  render();
  let signedIn = false;
  try {
    const result = await app.callServerTool({ name: 'list_machines', arguments: {} });
    signedIn = !result.isError;
  } catch {
    signedIn = false;
  }
  if (signedIn) {
    try {
      const result = await fetchState();
      busy = false;
      receive(result);
      return;
    } catch {
      // Fall through to asking the app to sign in.
    }
  }
  // Codex shows its Connect prompt when the model calls a protected tool, not when a card does.
  if (!showSignInHelp && signInApp() === 'codex' && app.getHostCapabilities()?.message?.text) {
    await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Sign me in to AgentUse.' }] }).catch(() => undefined);
  }
  busy = false;
  showSignInHelp = true;
  statusText = 'This card updates once you sign in.';
  render();
  poll(result => result.state !== 'sign_in');
}

async function checkAgain(): Promise<void> {
  busy = true;
  statusText = 'Checking…';
  render();
  try {
    const result = await fetchState();
    statusText = result.state === 'offline' ? `Still offline. Checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
    busy = false;
    receive(result);
  } catch (error) {
    busy = false;
    statusText = (error as Error).message;
    render();
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
    render();
    setTimeout(() => { copied = false; render(); }, 2000);
  } catch {
    // Some frames block the clipboard; the command stays visible to copy by hand.
  }
}

async function continueRequest(): Promise<void> {
  const text = `AgentUse is set up. Continue my request.${request ? ` My request: “${request}”` : ''}`;
  if (!app.getHostCapabilities()?.message?.text) {
    statusText = 'Tell your assistant to continue your request.';
    render();
    return;
  }
  busy = true;
  render();
  const sent = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch(() => ({ isError: true }));
  busy = false;
  statusText = sent.isError ? 'Tell your assistant to continue your request.' : 'Continuing your request.';
  render();
}

app.ontoolinput = params => {
  const value = (params.arguments as GetStartedArgs | undefined)?.request;
  if (typeof value === 'string' && value.trim()) request = value.trim();
};
app.ontoolresult = result => {
  const content = result.structuredContent as GetStartedResult | undefined;
  if (content && typeof content.state === 'string') { stopPolling(); statusText = ''; receive(content); }
};
app.onhostcontextchanged = context => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
};
void app.connect().then(async () => {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.dataset.theme = theme;
  // Hosts send the tool result right after connecting; ask for it only if none came.
  await new Promise(resolve => setTimeout(resolve, 1500));
  if (!data) receive(await fetchState());
}).catch(() => {
  if (data) return;
  statusText = 'Could not connect to the app. Ask your assistant to call get_started.';
  render();
});
