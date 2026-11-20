import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { CHOOSE_CONTEXT_TOOL, type ChooseContextArgs, type ContextPickerResult } from '../context-protocol';

const root = document.getElementById('card')!;
const app = new App({ name: 'agentuse-context-picker', version: '1.0.0' });
let data: ContextPickerResult = { machines: [] };
let machineId = '';
let projectId = '';
let activity: 'idle' | 'projects' | 'refresh' | 'confirm' = 'idle';
let selected = false;
let statusText = '';
let revision = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function request(args: ChooseContextArgs): Promise<ContextPickerResult> {
  const result = await app.callServerTool({ name: CHOOSE_CONTEXT_TOOL, arguments: { ...args } });
  const content = result.structuredContent as ContextPickerResult | undefined;
  if (result.isError || !content || !Array.isArray(content.machines)) {
    const text = result.content?.find(part => part.type === 'text');
    throw new Error(content?.error?.message ?? (text && 'text' in text ? text.text : 'Could not load destinations. Try again.'));
  }
  if (content.error) throw new Error(content.error.message);
  return content;
}

function render(): void {
  const focusedId = document.activeElement?.id;
  const loading = activity !== 'idle';
  root.replaceChildren(el('h1', selected ? 'Destination selected' : 'Choose where to work'));
  if (selected && data.selection) {
    const facts = el('dl', undefined, 'selection');
    facts.append(el('dt', 'Machine'), el('dd', data.selection.machine.name), el('dt', 'Project'), el('dd', data.selection.project.name));
    const change = el('button', 'Change machine/project');
    change.type = 'button';
    change.onclick = () => { void refresh(); };
    root.append(facts, change);
  } else {
    root.append(el('p', 'Choose the connected machine and project for this request.'));
    const fields = el('div', undefined, 'fields');
    const machine = el('select');
    machine.id = 'machine';
    const placeholder = el('option', 'Choose a machine');
    placeholder.value = '';
    machine.append(placeholder);
    for (const item of data.machines) {
      const option = el('option', `${item.name}${item.online ? '' : ' (offline)'}`);
      option.value = item.id;
      option.disabled = !item.online;
      machine.append(option);
    }
    machine.value = machineId;
    machine.disabled = activity === 'confirm' || activity === 'refresh';
    machine.onchange = () => { void loadProjects(machine.value); };
    const project = el('select');
    project.id = 'project';
    const projectPlaceholder = el('option', loading ? 'Loading projects…' : 'Choose a project');
    projectPlaceholder.value = '';
    project.append(projectPlaceholder);
    for (const item of data.projects ?? []) {
      const option = el('option', item.name);
      option.value = item.id;
      project.append(option);
    }
    project.value = projectId;
    project.disabled = loading || !machineId || !data.projects?.length;
    project.onchange = () => { projectId = project.value; statusText = ''; render(); };
    for (const [label, input] of [['Machine', machine], ['Project', project]] as const) {
      const field = el('div', undefined, 'field');
      const caption = el('label', label);
      caption.htmlFor = input.id;
      field.append(caption, input);
      fields.append(field);
    }
    const actions = el('div', undefined, 'actions');
    const next = el('button', loading ? 'Loading…' : 'Continue', 'primary');
    next.type = 'button';
    next.disabled = loading || !projectId || !data.machines.some(item => item.id === machineId && item.online);
    next.onclick = () => { void confirm(); };
    const refreshButton = el('button', 'Refresh');
    refreshButton.type = 'button';
    refreshButton.disabled = loading;
    refreshButton.onclick = () => { void refresh(); };
    actions.append(next, refreshButton);
    if (data.setup_url && !data.machines.some(item => item.online)) {
      const setup = el('button', 'Connect a machine');
      setup.type = 'button';
      setup.onclick = () => { if (data.setup_url) void app.openLink({ url: data.setup_url }); };
      actions.append(setup);
    }
    root.append(fields, actions);
  }
  const status = el('p', statusText, 'status');
  status.setAttribute('role', 'status');
  root.append(status);
  root.setAttribute('aria-busy', String(loading));
  if (focusedId) document.getElementById(focusedId)?.focus();
}

async function loadProjects(id: string): Promise<void> {
  const current = ++revision;
  machineId = id;
  projectId = '';
  data = { ...data, projects: [] };
  activity = id ? 'projects' : 'idle';
  statusText = '';
  render();
  if (!id) return;
  try {
    const result = await request({ machine_id: id });
    if (current !== revision) return;
    data = result;
    const projects = result.projects ?? [];
    projectId = projects.length === 1 ? projects[0]!.id : '';
    statusText = projects.length ? '' : 'No projects on this machine. Add a project in AgentUse, then refresh.';
  } catch (error) {
    if (current !== revision) return;
    statusText = (error as Error).message;
  } finally {
    if (current === revision) { activity = 'idle'; render(); }
  }
}

function receive(result: ContextPickerResult): void {
  ++revision;
  data = result;
  machineId = result.machine_id ?? '';
  projectId = result.project ?? '';
  selected = Boolean(result.context && result.selection);
  activity = 'idle';
  statusText = result.error?.message ?? '';
  if (!selected && !machineId && !result.error) {
    const online = result.machines.filter(item => item.online);
    if (online.length === 1) { void loadProjects(online[0]!.id); return; }
    if (!online.length) statusText = 'No machines online. Connect a machine, then refresh.';
  }
  render();
}

async function refresh(): Promise<void> {
  const current = ++revision;
  selected = false;
  activity = 'refresh';
  machineId = '';
  projectId = '';
  data = { machines: data.machines };
  statusText = 'Refreshing connected machines…';
  render();
  try {
    const result = await request({});
    if (current === revision) receive(result);
  } catch (error) {
    if (current === revision) { activity = 'idle'; statusText = (error as Error).message; render(); }
  }
}

async function confirm(): Promise<void> {
  const current = ++revision;
  activity = 'confirm';
  statusText = 'Selecting destination…';
  render();
  try {
    const result = await request({ machine_id: machineId, project: projectId });
    if (current !== revision) return;
    if (!result.context || !result.selection || result.selection.machine.id !== machineId || result.selection.project.id !== projectId) {
      throw new Error('The destination could not be confirmed. Refresh and try again.');
    }
    data = result;
    selected = true;
    const capabilities = app.getHostCapabilities();
    const contextText = `The user selected an AgentUse destination. Pass this context unchanged on subsequent AgentUse calls: ${result.context}`;
    const canUpdate = capabilities?.updateModelContext?.text || capabilities?.updateModelContext?.structuredContent;
    if (canUpdate) {
      await app.updateModelContext({
        ...(capabilities.updateModelContext?.text ? { content: [{ type: 'text' as const, text: contextText }] } : {}),
        ...(capabilities.updateModelContext?.structuredContent ? { structuredContent: { context: result.context, selection: result.selection } } : {}),
      });
      if (current !== revision) return;
      statusText = 'Destination selected. You can continue your request.';
    } else {
      statusText = `This host cannot share the selection automatically. Tell your assistant to call choose_context with machine_id ${JSON.stringify(machineId)} and project ${JSON.stringify(projectId)}.`;
    }
    if (current !== revision) return;
    if (capabilities?.message?.text) {
      const sent = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `Continue my AgentUse request using the destination I selected.${canUpdate ? '' : ` ${contextText}`}` }] });
      if (!sent.isError) statusText = 'Destination selected. Continuing your request.';
      else if (canUpdate) statusText = 'Destination selected. Ask your assistant to continue.';
    }
  } catch (error) {
    if (current === revision) statusText = (error as Error).message;
  } finally {
    if (current === revision) { activity = 'idle'; render(); }
  }
}

app.ontoolresult = result => {
  const content = result.structuredContent as ContextPickerResult | undefined;
  if (content && Array.isArray(content.machines)) receive(content);
};
app.onhostcontextchanged = context => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
};
void app.connect().then(() => {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.dataset.theme = theme;
}).catch(() => {
  statusText = 'Could not connect to the app. Ask your assistant to choose a machine and project with choose_context.';
  render();
});
