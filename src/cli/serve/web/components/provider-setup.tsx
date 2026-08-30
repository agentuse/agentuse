import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProviderStatus } from '../../../../auth/provider-status';
import {
  completeProviderOAuth,
  fetchProviderSetup,
  removeCustomProvider,
  removeProviderCredential,
  saveCustomProvider,
  saveProviderApiKey,
  startProviderOAuth,
  type ProviderSetupPayload,
} from '../lib/api';

export function hasConfiguredProvider(status: ProviderStatus | undefined): boolean {
  return Boolean(status?.providers.some((provider) => provider.configured)
    || status?.customProviders.some((provider) => provider.hasApiKey));
}

function ProviderSetupForm(props: {
  payload: ProviderSetupPayload;
  initialProvider?: string;
  allowCustom?: boolean;
  onUpdated: (payload: ProviderSetupPayload) => void;
  onComplete: (payload: ProviderSetupPayload) => void;
}) {
  const initial = props.initialProvider && (props.allowCustom || props.initialProvider !== 'custom')
    ? props.initialProvider
    : props.payload.catalog[0]?.id ?? 'anthropic';
  const [provider, setProvider] = useState(initial);
  const entry = props.payload.catalog.find((item) => item.id === provider);
  const [method, setMethod] = useState<'oauth' | 'api_key'>(entry?.authMethods.includes('oauth') ? 'oauth' : 'api_key');
  const [key, setKey] = useState('');
  const [flow, setFlow] = useState<{ id: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [customName, setCustomName] = useState('');
  const [customURL, setCustomURL] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFlow(null);
    setCode('');
    setError(null);
    const next = props.payload.catalog.find((item) => item.id === provider);
    setMethod(next?.authMethods.includes('oauth') ? 'oauth' : 'api_key');
  }, [provider]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let next: ProviderSetupPayload;
      if (provider === 'custom') {
        next = await saveCustomProvider(customName, customURL, customKey || undefined);
      } else if (method === 'api_key') {
        next = await saveProviderApiKey(provider, key);
      } else if (!flow) {
        const started = await startProviderOAuth(provider);
        setFlow({ id: started.flowId, url: started.authorizationUrl });
        return;
      } else {
        next = await completeProviderOAuth(flow.id, code);
      }
      setKey('');
      setCustomKey('');
      props.onUpdated(next);
      props.onComplete(next);
    } catch (caught) {
      setError((caught as Error).message || 'Provider setup failed.');
    } finally {
      setBusy(false);
    }
  };

  const oauthCopy = provider === 'openai'
    ? 'Sign in with ChatGPT, then paste the full callback URL below.'
    : 'Authorize AgentUse, then paste the authorization code below.';

  return (
    <div class="provider-setup-form">
      <label class="provider-field">
        <span>Provider</span>
        <select value={provider} onChange={(event) => setProvider((event.target as HTMLSelectElement).value)} disabled={busy}>
          {props.payload.catalog.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          {props.allowCustom && <option value="custom">Custom provider</option>}
        </select>
      </label>

      {provider === 'custom' ? (
        <div class="provider-custom-fields">
          <label class="provider-field"><span>Name</span><input value={customName} placeholder="my-provider" onInput={(event) => setCustomName((event.target as HTMLInputElement).value)} disabled={busy} /></label>
          <label class="provider-field"><span>Base URL</span><input value={customURL} placeholder="https://api.example.com/v1" onInput={(event) => setCustomURL((event.target as HTMLInputElement).value)} disabled={busy} /></label>
          <label class="provider-field"><span>API key <em>optional</em></span><input type="password" value={customKey} onInput={(event) => setCustomKey((event.target as HTMLInputElement).value)} disabled={busy} /></label>
        </div>
      ) : (
        <>
          {entry && entry.authMethods.length > 1 && !flow && (
            <span class="provider-method-toggle" role="group" aria-label="Authentication method">
              <button type="button" aria-pressed={method === 'oauth'} onClick={() => setMethod('oauth')} disabled={busy}>OAuth</button>
              <button type="button" aria-pressed={method === 'api_key'} onClick={() => setMethod('api_key')} disabled={busy}>API key</button>
            </span>
          )}
          {method === 'api_key' ? (
            <label class="provider-field"><span>API key</span><input type="password" value={key} onInput={(event) => setKey((event.target as HTMLInputElement).value)} disabled={busy} /></label>
          ) : flow ? (
            <div class="provider-oauth-complete">
              <p>{oauthCopy}</p>
              <a href={flow.url} target="_blank" rel="noreferrer">Open authorization page</a>
              <label class="provider-field"><span>{provider === 'openai' ? 'Callback URL or code' : 'Authorization code'}</span><input value={code} onInput={(event) => setCode((event.target as HTMLInputElement).value)} disabled={busy} /></label>
            </div>
          ) : <p class="provider-method-hint">Continue in your browser. AgentUse stores the resulting OAuth credential in its local credential store.</p>}
        </>
      )}

      {error && <p class="provider-setup-error" role="alert">{error}</p>}
      <div class="provider-setup-actions">
        {flow && <button type="button" class="provider-setup-secondary" onClick={() => { setFlow(null); setCode(''); }} disabled={busy}>Back</button>}
        <button type="button" class="provider-setup-primary" onClick={() => void submit()} disabled={busy} aria-busy={busy}>
          {busy ? 'Working…' : provider === 'custom' || method === 'api_key' ? 'Save provider' : flow ? 'Finish connecting' : `Continue to ${entry?.name ?? 'provider'}`}
        </button>
      </div>
    </div>
  );
}

export function ProviderSetupDialog(props: {
  open: boolean;
  title?: string;
  initialProvider?: string;
  allowCustom?: boolean;
  onComplete: (payload: ProviderSetupPayload) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [payload, setPayload] = useState<ProviderSetupPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    setPayload(null);
    setError(null);
    void fetchProviderSetup().then(setPayload, (caught) => setError((caught as Error).message || 'Could not load providers.'));
  }, [props.open]);

  return (
    <dialog class="provider-setup-dialog" ref={dialogRef} aria-labelledby="provider-setup-title" onClose={props.onClose} onClick={(event) => { if (event.target === dialogRef.current) props.onClose(); }}>
      <div class="dialog-head"><span id="provider-setup-title" class="title">{props.title ?? 'connect a provider'}</span><button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button></div>
      <div class="provider-setup-body">
        <div class="provider-setup-intro"><strong>Connect a model provider</strong><span>Your agents use this credential when they run from this Dashboard.</span></div>
        {!payload && !error && <p class="provider-setup-loading">Loading providers…</p>}
        {error && <p class="provider-setup-error" role="alert">{error}</p>}
        {payload && <ProviderSetupForm key={props.initialProvider ?? 'default'} payload={payload} {...(props.initialProvider ? { initialProvider: props.initialProvider } : {})} {...(props.allowCustom !== undefined ? { allowCustom: props.allowCustom } : {})} onUpdated={setPayload} onComplete={props.onComplete} />}
      </div>
    </dialog>
  );
}

export function ProviderSettingsGroup() {
  const [payload, setPayload] = useState<ProviderSetupPayload | null>(null);
  const [dialogProvider, setDialogProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => { void fetchProviderSetup().then(setPayload, (caught) => setError((caught as Error).message || 'Could not load providers.')); }, []);
  const catalog = payload?.catalog ?? [];
  const providers = useMemo(() => catalog.map((entry) => ({ entry, status: payload?.status.providers.find((item) => item.id === entry.id) })), [catalog, payload]);

  const remove = async (provider: string, kind: 'oauth' | 'api_key') => {
    const key = `${provider}:${kind}`;
    setBusyKey(key);
    setError(null);
    try { setPayload(await removeProviderCredential(provider, kind)); }
    catch (caught) { setError((caught as Error).message || 'Could not remove credential.'); }
    finally { setBusyKey(null); }
  };

  const removeCustom = async (name: string) => {
    setBusyKey(`custom:${name}`);
    setError(null);
    try { setPayload(await removeCustomProvider(name)); }
    catch (caught) { setError((caught as Error).message || 'Could not remove provider.'); }
    finally { setBusyKey(null); }
  };

  return (
    <>
      <section class="settings-group provider-settings-group">
        <h2 class="settings-group-title">Providers</h2>
        <p class="settings-group-hint">Credentials available to agents running from this Dashboard.</p>
        {!payload && !error && <p class="settings-group-hint">Loading providers…</p>}
        {error && <p class="settings-check-error" role="alert">{error}</p>}
        {providers.map(({ entry, status }) => {
          const active = status?.sources.find((source) => source.active);
          const stored = status?.sources.filter((source) => source.stored) ?? [];
          return (
            <div class="settings-row provider-settings-row" key={entry.id}>
              <div class="settings-row-text"><div class="settings-row-label">{entry.name}</div><div class="settings-row-hint">{active ? active.name : `${entry.description} · ${entry.authMethods.map((method) => method === 'api_key' ? 'API key' : 'OAuth').join(' or ')}`}</div></div>
              <div class="settings-row-control provider-settings-control">
                <span class={`provider-status${status?.configured ? ' is-ready' : ''}`}>{status?.configured ? 'Connected' : 'Not connected'}</span>
                {stored.map((source) => <button key={`${entry.id}:${source.kind}`} type="button" class="settings-item" disabled={busyKey === `${entry.id}:${source.kind}`} onClick={() => void remove(entry.id, source.kind === 'oauth' ? 'oauth' : 'api_key')}>Remove {source.kind === 'oauth' ? 'OAuth' : 'key'}</button>)}
                <button type="button" class="settings-item" onClick={() => setDialogProvider(entry.id)}>{status?.configured ? 'Add method' : 'Connect'}</button>
              </div>
            </div>
          );
        })}
        {payload?.status.customProviders.map((provider) => (
          <div class="settings-row provider-settings-row" key={provider.id}>
            <div class="settings-row-text"><div class="settings-row-label">{provider.id}</div><div class="settings-row-hint">{provider.baseURL}</div></div>
            <div class="settings-row-control provider-settings-control"><span class={`provider-status${provider.hasApiKey ? ' is-ready' : ''}`}>{provider.hasApiKey ? 'Connected' : 'No key'}</span><button type="button" class="settings-item" disabled={busyKey === `custom:${provider.id}`} onClick={() => void removeCustom(provider.id)}>Remove</button></div>
          </div>
        ))}
        {payload && <div class="settings-row"><div class="settings-row-text"><div class="settings-row-label">Custom provider</div><div class="settings-row-hint">Add an OpenAI-compatible endpoint.</div></div><div class="settings-row-control"><button type="button" class="settings-item" onClick={() => setDialogProvider('custom')}>Add provider</button></div></div>}
      </section>
      <ProviderSetupDialog open={dialogProvider !== null} {...(dialogProvider ? { initialProvider: dialogProvider } : {})} allowCustom title={dialogProvider === 'custom' ? 'add custom provider' : 'connect a provider'} onComplete={(next) => { setPayload(next); setDialogProvider(null); }} onClose={() => setDialogProvider(null)} />
    </>
  );
}
