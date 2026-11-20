/**
 * The page scripts/check-cards.ts loads in a browser: a stand-in for the chat
 * app that hosts an MCP card. It puts one card in a frame, hands it a tool
 * result, answers its tool calls from the scenario, and records what the card
 * asks the app to do.
 */
import { AppBridge, PostMessageTransport, type McpUiHostCapabilities } from '@modelcontextprotocol/ext-apps/app-bridge';

export interface CardScenario {
  card: string;
  width: number;
  theme: 'light' | 'dark';
  hostName?: string;
  toolResult: Record<string, unknown>;
  /** Tool name to the structured result it returns. A tool not listed answers with an error, as a signed-out server does. */
  tools?: Record<string, Record<string, unknown>>;
}

export interface CardSnapshot {
  text: string;
  buttons: string[];
  overflows: boolean;
  log: Array<Record<string, unknown>>;
}

declare global {
  interface Window {
    cardSnapshot?: () => string;
    cardPress?: (label: string) => string;
    cardChoose?: (id: string, value: string) => string;
    cardError?: string;
  }
}

window.addEventListener('error', (event) => { window.cardError = event.message; });
window.addEventListener('unhandledrejection', (event) => { window.cardError = String(event.reason); });

const scenario = JSON.parse(new URLSearchParams(location.search).get('s') ?? 'null') as CardScenario;
const log: Array<Record<string, unknown>> = [];
const frame = document.createElement('iframe');
frame.style.cssText = `width:${scenario.width}px;height:720px;border:0`;
document.body.append(frame);

const capabilities: McpUiHostCapabilities = { openLinks: {}, serverTools: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {} } };
const bridge = new AppBridge(null, { name: scenario.hostName ?? 'card-check', version: '1.0.0' }, capabilities, { hostContext: { theme: scenario.theme } });
bridge.oncalltool = async (params) => {
  log.push({ call: params.name, arguments: params.arguments ?? {} });
  const structuredContent = scenario.tools?.[params.name];
  if (!structuredContent) return { isError: true, content: [{ type: 'text', text: 'Sign in required' }] };
  return { content: [{ type: 'text', text: 'ok' }], structuredContent };
};
bridge.onopenlink = async (params) => { log.push({ open: params.url }); return {}; };
bridge.onmessage = async (params) => { log.push({ message: params.content }); return {}; };
bridge.onupdatemodelcontext = async (params) => { log.push({ context: params.content ?? [] }); return {}; };
bridge.addEventListener('initialized', () => {
  void bridge.sendToolResult({ content: [], structuredContent: scenario.toolResult });
});

const cardWindow = frame.contentWindow;
if (!cardWindow) throw new Error('The card frame has no window');
await bridge.connect(new PostMessageTransport(cardWindow, cardWindow));
frame.srcdoc = await (await fetch(`/card/${scenario.card}`)).text();

function cardDocument(): Document {
  const doc = frame.contentDocument;
  if (!doc) throw new Error('The card frame has no document');
  return doc;
}

window.cardSnapshot = () => {
  const doc = cardDocument();
  const snapshot: CardSnapshot = {
    text: doc.getElementById('card')?.innerText ?? '',
    buttons: [...doc.querySelectorAll('button')].map((button) => `${button.textContent ?? ''}${button.disabled ? ' (off)' : ''}`),
    overflows: doc.documentElement.scrollWidth > doc.documentElement.clientWidth,
    log,
  };
  return JSON.stringify(snapshot);
};
window.cardPress = (label) => {
  const node = [...cardDocument().querySelectorAll('button')].find((button) => button.textContent === label);
  if (!node) throw new Error(`No "${label}" button on the card`);
  node.click();
  return 'pressed';
};
window.cardChoose = (id, value) => {
  const node = cardDocument().getElementById(id) as HTMLSelectElement | null;
  if (!node) throw new Error(`No field #${id} on the card`);
  node.value = value;
  node.dispatchEvent(new Event('change'));
  return 'chosen';
};
