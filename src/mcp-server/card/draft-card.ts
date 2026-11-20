/**
 * The "Turn on" card an MCP app (Claude, ChatGPT, VS Code) draws under a
 * draft_agent or propose_fix result. Runs in the host's sandboxed frame.
 * Bundled with its dependencies into one HTML page by
 * scripts/build-mcp-card.ts; the result is src/generated/mcp-draft-card.ts.
 *
 * Turn on calls the same apply_draft tool a typed yes uses, so serve applies
 * the same low-risk check. A risky draft shows why and a link to review it.
 */
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';

interface DraftResult {
  id?: string;
  draft_id?: string;
  fix_id?: string;
  project?: string;
  context?: string;
  kind?: 'draft' | 'fix';
  name?: string;
  summary?: string;
  schedule?: string;
  can_turn_on_by_yes?: boolean;
  needs_review_because?: string[];
  review_url?: string;
  files?: Array<{ path: string; op: string; capability_changes?: string[] }>;
}

const root = document.getElementById('card')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(app: App, data: DraftResult): void {
  const id = data.id ?? data.draft_id ?? data.fix_id;
  root.replaceChildren();
  const title = el('div', 'title');
  title.append(el('span', 'kind', data.kind === 'fix' ? 'Fix ready' : 'Draft ready'), el('span', 'name', data.name ?? 'agent'));
  root.append(title);
  if (data.summary) root.append(el('p', 'summary', data.summary));

  const facts = el('dl', 'facts');
  const fact = (label: string, value: string) => facts.append(el('dt', '', label), el('dd', '', value));
  if (data.schedule) fact('Runs', data.schedule);
  const changes = (data.files ?? []).flatMap((file) => file.capability_changes ?? []);
  if (changes.length) fact('Can', changes.join(' · '));
  fact('Files', (data.files ?? []).map((file) => file.path).join(', ') || 'none');
  root.append(facts);

  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  const actions = el('div', 'actions');
  const details = el('button', 'secondary', 'Details');
  details.type = 'button';
  details.onclick = () => { if (data.review_url) void app.openLink({ url: data.review_url }); };

  if (data.can_turn_on_by_yes && id && data.project) {
    const turnOn = el('button', 'primary', data.kind === 'fix' ? 'Apply fix' : 'Turn on');
    turnOn.type = 'button';
    turnOn.onclick = async () => {
      turnOn.disabled = true;
      status.textContent = 'Turning on…';
      try {
        const result = await app.callServerTool({
          name: 'apply_draft',
          arguments: { project: data.project, id, ...(data.context ? { context: data.context } : {}) },
        });
        const text = result.content?.find((part) => part.type === 'text');
        if (result.isError) {
          status.textContent = text && 'text' in text ? text.text : 'Could not turn it on. Open Details to review it.';
          turnOn.disabled = false;
          return;
        }
        status.textContent = data.kind === 'fix' ? 'Applied. You can undo it from the notification.' : 'On. You can undo it from the notification.';
        turnOn.remove();
      } catch (error) {
        status.textContent = `Could not turn it on: ${(error as Error).message}`;
        turnOn.disabled = false;
      }
    };
    actions.append(turnOn, details);
  } else {
    const reasons = data.needs_review_because?.length ? data.needs_review_because.join(', ') : 'needs a closer look';
    status.textContent = `Needs your review, because it ${reasons}.`;
    const review = el('button', 'primary', 'Review and apply');
    review.type = 'button';
    review.onclick = details.onclick;
    actions.append(review);
  }
  root.append(actions, status);
}

const app = new App({ name: 'agentuse-draft-card', version: '1.0.0' });
app.ontoolresult = (result) => {
  const data = result.structuredContent as DraftResult | undefined;
  if (data) render(app, data);
};
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
};
void app.connect().then(() => {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.dataset.theme = theme;
});
