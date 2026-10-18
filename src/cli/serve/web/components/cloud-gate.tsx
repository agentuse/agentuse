import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  chooseMachine,
  fetchCloudMachines,
  rememberedMachineId,
  requestMachineUpdate,
  selectedMachineId,
  selectMachine,
  type CloudMachine,
  type CloudMachinesPayload,
} from '../lib/cloud';
import { formatRelativeTime } from '../lib/format';

/**
 * Cloud mode only: decide which computer this page shows before any daemon
 * request goes out, and stand in for the dashboard when there is nothing to
 * reach (no computer chosen, offline, or too old to relay the dashboard).
 */

type GateState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: CloudMachinesPayload; machine: CloudMachine | undefined };

/**
 * A link to one of Cloud's own pages (/account, /setup), which are not routes
 * of this app. `target="_top"` keeps the router from taking the click, so the
 * browser loads the page.
 */
function CloudPageLink(props: { href: string; class?: string; children: ComponentChildren }) {
  return <a href={props.href} target="_top" {...(props.class && { class: props.class })}>{props.children}</a>;
}

function dismissBootLoader() {
  document.getElementById('boot')?.remove();
}

/** Open the dashboard on another computer: a full load, so nothing from the last one lingers. */
export function switchMachine(id: string): void {
  selectMachine(id);
  location.assign(`/?m=${encodeURIComponent(id)}`);
}

let machinesCache: CloudMachinesPayload | undefined;

/** The account's computers, as the gate last loaded them (for the header switcher). */
export function cloudMachines(): CloudMachine[] {
  return machinesCache?.machines ?? [];
}

export function CloudGate(props: { children: ComponentChildren }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  useEffect(() => {
    const requested = new URL(location.href).searchParams.get('m') ?? undefined;
    fetchCloudMachines(requested).then((payload) => {
      machinesCache = payload;
      const id = chooseMachine(payload, requested, rememberedMachineId());
      if (id) selectMachine(id);
      setState({ kind: 'ready', payload, machine: payload.machines.find((machine) => machine.id === id) });
    }, (error: Error) => setState({ kind: 'error', message: error.message }));
  }, []);

  useEffect(() => {
    if (state.kind !== 'loading' && !(state.kind === 'ready' && usable(state.machine))) dismissBootLoader();
  }, [state]);

  if (state.kind === 'loading') return null;
  if (state.kind === 'error') return <GatePage title="Could not reach AgentUse Cloud" body={state.message} />;
  const { machine, payload } = state;
  if (!machine) return <MachinePicker machines={payload.machines} />;
  if (!machine.online) {
    return (
      <GatePage
        title="This computer is offline"
        body={`${machine.name} is not connected to AgentUse Cloud right now${machine.lastSeen ? `. It was last seen ${formatRelativeTime(machine.lastSeen)}` : ''}. Open AgentUse on it, or start agentuse serve, and this page will work again.`}
        machines={payload.machines}
        current={machine.id}
      />
    );
  }
  if (!machine.compatible) return <NeedsUpdate machine={machine} machines={payload.machines} />;
  return <>{props.children}</>;
}

const usable = (machine: CloudMachine | undefined): boolean => Boolean(machine?.online && machine.compatible);

function GatePage(props: { title: string; body: string; machines?: CloudMachine[]; current?: string; children?: ComponentChildren }) {
  const others = (props.machines ?? []).filter((machine) => machine.id !== props.current);
  return (
    <div class="page-home cloud-gate">
      <main>
        <h1>{props.title}</h1>
        <p class="cloud-gate-body">{props.body}</p>
        {props.children}
        {others.length > 0 && (
          <>
            <p class="cloud-gate-label">Or open another computer</p>
            <MachineList machines={others} />
          </>
        )}
        <p class="cloud-gate-foot"><CloudPageLink href="/account">Your account and computers</CloudPageLink></p>
      </main>
    </div>
  );
}

function MachinePicker(props: { machines: CloudMachine[] }) {
  if (props.machines.length === 0) {
    return (
      <GatePage
        title="No computers yet"
        body="Connect a computer to see its agents, runs and approvals here."
      >
        <p><CloudPageLink class="empty-action" href="/setup">Connect a computer</CloudPageLink></p>
      </GatePage>
    );
  }
  return (
    <GatePage title="Pick a computer" body="Your agents run on your own computers. Pick the one to open.">
      <MachineList machines={props.machines} />
    </GatePage>
  );
}

function MachineList(props: { machines: CloudMachine[] }) {
  return (
    <ul class="cloud-machine-list">
      {props.machines.map((machine) => (
        <li key={machine.id}>
          <button type="button" class="cloud-machine" onClick={() => switchMachine(machine.id)}>
            <span class={`cloud-machine-dot${machine.online ? ' is-online' : ''}`} aria-hidden="true" />
            <span class="cloud-machine-name">{machine.name}</span>
            <span class="cloud-machine-meta">{machine.online ? (machine.compatible ? 'Online' : 'Needs an update') : 'Offline'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NeedsUpdate(props: { machine: CloudMachine; machines: CloudMachine[] }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const canUpdate = props.machine.features.includes('update');
  const update = () => {
    setStatus('sending');
    requestMachineUpdate(props.machine.id).then(() => setStatus('sent'), (failure: Error) => {
      setError(failure.message);
      setStatus('error');
    });
  };
  return (
    <GatePage
      title="This computer needs an update"
      body={`${props.machine.name} runs AgentUse ${props.machine.version ?? '(an older version)'}, which cannot show this dashboard through AgentUse Cloud yet.`}
      machines={props.machines}
      current={props.machine.id}
    >
      {canUpdate
        ? (
          <p>
            <button type="button" class="empty-action" disabled={status === 'sending' || status === 'sent'} onClick={update}>
              {status === 'sent' ? 'Update requested' : 'Update'}
            </button>
            {status === 'sent' && <span class="cloud-gate-note"> It installs once no agent is running on it.</span>}
            {status === 'error' && <span class="cloud-gate-note"> {error}</span>}
          </p>
        )
        : <p class="cloud-gate-note">On that computer, update the AgentUse app, or run <code>npm i -g agentuse@latest</code> and restart <code>agentuse serve</code>.</p>}
    </GatePage>
  );
}

/** The header's computer switcher, shown in cloud mode once a computer is open. */
export function MachineSwitcher() {
  const machines = cloudMachines();
  const current = selectedMachineId();
  if (!current || machines.length === 0) return null;
  return (
    <div class="cloud-switcher">
      <select
        aria-label="Computer"
        value={current}
        onChange={(event) => {
          const id = (event.currentTarget as HTMLSelectElement).value;
          if (id !== current) switchMachine(id);
        }}
      >
        {machines.map((machine) => (
          <option key={machine.id} value={machine.id}>
            {machine.name}{machine.online ? '' : ' (offline)'}
          </option>
        ))}
      </select>
      <div class="cloud-switcher-links">
        <CloudPageLink href="/setup">Add a computer</CloudPageLink>
        <CloudPageLink href="/account">Manage</CloudPageLink>
      </div>
    </div>
  );
}
