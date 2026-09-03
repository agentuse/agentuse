import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProviderAuthSourceStatus, ProviderStatus } from '../../../../auth/provider-status';
import {
  checkCustomProvider,
  completeProviderPluginOAuth,
  completeProviderOAuth,
  fetchProviderSetup,
  inspectProviderPlugin,
  installProviderPlugin,
  cancelProviderOAuth,
  removeCustomProvider,
  removeProviderCredential,
  removeProviderPlugin,
  refreshCustomProviderModels,
  saveCustomProvider,
  saveProviderApiKey,
  startProviderPluginOAuth,
  startUnreviewedProviderPluginOAuth,
  startProviderOAuth,
  type CustomProviderApiSelection,
  type ProviderSetupPayload,
  updateProviderPlugin,
} from '../lib/api';
import type { PluginSourceInspection } from '../../../../plugin/provider-installer';
import { DashboardSelect } from './dashboard-select';

export function hasConfiguredProvider(status: ProviderStatus | undefined): boolean {
  return Boolean(status?.providers.some((provider) => provider.configured)
    || status?.customProviders.length);
}

const pluginSelection = (id: string) => `plugin:${id}`;
const advancedPluginSelection = 'plugin:advanced';
export type ProviderSetupScope = 'all' | 'provider' | 'plugins';

function authMethodLabel(methods: readonly ('oauth' | 'api_key')[]): string {
  return methods.map((method) => method === 'api_key' ? 'API key' : 'OAuth').join(' or ');
}

export function providerSetupOptions(
  payload: ProviderSetupPayload,
  allowCustom?: boolean,
  scope: ProviderSetupScope = 'all',
  initialProvider?: string,
) {
  const builtIn = payload.catalog.map((item) => ({
      value: item.id,
      label: item.name,
      group: 'Built in',
      meta: authMethodLabel(item.authMethods),
    }));
  const installedNames = new Set(payload.installedPlugins.map((item) => item.packageName));
  const community = payload.pluginRegistry.map((item) => ({
      value: pluginSelection(item.id),
      label: item.name,
      group: 'Community plugins',
      meta: `${item.publisher} · v${item.version}`,
      badge: 'Community',
    }));
  const uninstalledCommunity = community.filter((_, index) => {
    const plugin = payload.pluginRegistry[index];
    return plugin && !installedNames.has(plugin.packageName);
  });
  const advancedPlugin = {
      value: advancedPluginSelection,
      label: 'Install plugin from GitHub…',
      group: 'Advanced',
      meta: 'Pinned release or commit',
  };
  const custom = { value: 'custom', label: 'Custom provider', group: 'Built in' };

  if (scope === 'plugins') return [...uninstalledCommunity, advancedPlugin];
  if (scope === 'provider') {
    if (initialProvider === 'custom') return [custom];
    const selectedPlugin = payload.pluginRegistry.find((item) => pluginSelection(item.id) === initialProvider);
    const providerId = selectedPlugin?.provider ?? initialProvider;
    return [
      ...builtIn.filter((item) => item.value === providerId),
      // Uninstalled shortlist plugins stay visible so a Claude Pro/Max user
      // starting from the Anthropic row can install from here.
      ...community.filter((_, index) => payload.pluginRegistry[index]?.provider === providerId),
    ];
  }
  return [...builtIn, ...(allowCustom ? [custom] : []), ...community];
}

export function defaultProviderSetupSelection(
  payload: ProviderSetupPayload,
  initialProvider?: string,
  allowCustom?: boolean,
  scope: ProviderSetupScope = 'all',
): string {
  const options = providerSetupOptions(payload, allowCustom, scope, initialProvider);
  if (initialProvider && options.some((option) => option.value === initialProvider)) return initialProvider;
  const migration = payload.pluginRegistry.find((plugin) =>
    payload.status.providers.find((provider) => provider.id === plugin.provider)?.actionRequired,
  );
  const migrationSelection = migration ? pluginSelection(migration.id) : undefined;
  if (migrationSelection && options.some((option) => option.value === migrationSelection)) return migrationSelection;
  return options[0]?.value ?? payload.catalog[0]?.id ?? 'anthropic';
}

function ProviderSetupForm(props: {
  payload: ProviderSetupPayload;
  initialProvider?: string;
  allowCustom?: boolean;
  scope?: ProviderSetupScope;
  onUpdated: (payload: ProviderSetupPayload) => void;
  onComplete: (payload: ProviderSetupPayload) => void;
}) {
  const scope = props.scope ?? 'all';
  const setupOptions = providerSetupOptions(props.payload, props.allowCustom, scope, props.initialProvider);
  const initial = defaultProviderSetupSelection(props.payload, props.initialProvider, props.allowCustom, scope);
  const [provider, setProvider] = useState(initial);
  const entry = props.payload.catalog.find((item) => item.id === provider);
  const pluginEntry = props.payload.pluginRegistry.find((item) => pluginSelection(item.id) === provider);
  const installedPlugin = pluginEntry
    ? props.payload.installedPlugins.find((item) => item.packageName === pluginEntry.packageName)
    : undefined;
  const [method, setMethod] = useState<'oauth' | 'api_key'>(pluginEntry || entry?.authMethods.includes('oauth') ? 'oauth' : 'api_key');
  const [key, setKey] = useState('');
  const [flow, setFlow] = useState<{
    id: string;
    url: string;
    kind: 'builtin' | 'plugin';
    plugin?: { packageName: string; version: string; source: string; wasInstalled: boolean };
  } | null>(null);
  const [code, setCode] = useState('');
  const [pluginSource, setPluginSource] = useState('');
  const [pluginInspection, setPluginInspection] = useState<PluginSourceInspection | null>(null);
  const [customName, setCustomName] = useState('');
  const [customURL, setCustomURL] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [customApi, setCustomApi] = useState<CustomProviderApiSelection>('auto');
  const [customModels, setCustomModels] = useState('');
  const [customCheck, setCustomCheck] = useState<{ baseURL: string; models: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFlow(null);
    setCode('');
    setPluginInspection(null);
    setError(null);
    const next = props.payload.catalog.find((item) => item.id === provider);
    const nextPlugin = props.payload.pluginRegistry.find((item) => pluginSelection(item.id) === provider);
    setMethod(nextPlugin || next?.authMethods.includes('oauth') ? 'oauth' : 'api_key');
  }, [provider]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let next: ProviderSetupPayload;
      if (provider === advancedPluginSelection) {
        if (!pluginInspection) {
          const inspected = await inspectProviderPlugin(pluginSource);
          setPluginInspection(inspected.plugin);
          return;
        }
        const started = await startUnreviewedProviderPluginOAuth(pluginInspection.source, pluginInspection.commit);
        if (started.connected) {
          next = started;
        } else {
          setFlow({
            id: started.flowId,
            url: started.authorizationUrl,
            kind: 'plugin',
            plugin: {
              packageName: pluginInspection.name,
              version: pluginInspection.version,
              source: pluginInspection.source,
              wasInstalled: false,
            },
          });
          return;
        }
      } else if (provider === 'custom') {
        const manualModels = customModels.split(/[\n,]+/).map((model) => model.trim()).filter(Boolean);
        if (!customCheck) {
          const checked = await checkCustomProvider(customName, customURL, customApi, customKey || undefined, manualModels);
          setCustomURL(checked.baseURL);
          setCustomModels(checked.models.join('\n'));
          setCustomApi(checked.api);
          setCustomCheck({ baseURL: checked.baseURL, models: checked.models });
          return;
        }
        next = await saveCustomProvider(
          customName,
          customCheck.baseURL,
          customApi,
          customKey || undefined,
          customCheck.models,
        );
      } else if (pluginEntry && !flow) {
        const started = await startProviderPluginOAuth(pluginEntry.id);
        if (started.connected) {
          next = started;
        } else {
          setFlow({
            id: started.flowId,
            url: started.authorizationUrl,
            kind: 'plugin',
            plugin: {
              packageName: pluginEntry.packageName,
              version: pluginEntry.version,
              source: pluginEntry.source,
              wasInstalled: Boolean(installedPlugin),
            },
          });
          return;
        }
      } else if (method === 'api_key') {
        next = await saveProviderApiKey(provider, key);
      } else if (!flow) {
        const started = await startProviderOAuth(provider);
        setFlow({ id: started.flowId, url: started.authorizationUrl, kind: 'builtin' });
        return;
      } else {
        next = flow.kind === 'plugin'
          ? await completeProviderPluginOAuth(flow.id, code)
          : await completeProviderOAuth(flow.id, code);
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
    : `Authorize ${pluginEntry?.name ?? pluginInspection?.name ?? 'the provider plugin'}, then paste the authorization code below.`;

  return (
    <div class="provider-setup-form">
      {setupOptions.length > 1 && (
        <div class="provider-field">
          <span>{scope === 'provider' ? 'Authentication method' : scope === 'plugins' ? 'Plugin' : 'Provider'}</span>
          <DashboardSelect
            value={provider}
            options={setupOptions}
            onChange={setProvider}
            ariaLabel={scope === 'provider' ? 'Authentication method' : scope === 'plugins' ? 'Plugin' : 'Provider'}
            disabled={busy}
          />
        </div>
      )}

      {provider === 'custom' ? (
        <div class="provider-custom-fields">
          <label class="provider-field"><span>Name</span><input value={customName} placeholder="my-provider" onInput={(event) => { setCustomName((event.target as HTMLInputElement).value); setCustomCheck(null); }} disabled={busy} /></label>
          <label class="provider-field"><span>Base URL</span><input value={customURL} placeholder="https://api.example.com/v1" onInput={(event) => { setCustomURL((event.target as HTMLInputElement).value); setCustomCheck(null); }} disabled={busy} /></label>
          <label class="provider-field"><span>API format</span><select value={customApi} onChange={(event) => { setCustomApi((event.target as HTMLSelectElement).value as CustomProviderApiSelection); setCustomCheck(null); }} disabled={busy}><option value="auto">Detect automatically</option><option value="openai-completions">OpenAI Chat Completions compatible</option><option value="openai-responses">OpenAI Responses compatible</option><option value="anthropic-messages">Anthropic Messages compatible</option></select><small>AgentUse detects the protocol during the endpoint check. Choose an override only when detection fails.</small></label>
          <label class="provider-field"><span>API key <em>optional</em></span><input type="password" value={customKey} onInput={(event) => { setCustomKey((event.target as HTMLInputElement).value); setCustomCheck(null); }} disabled={busy} /></label>
          <label class="provider-field"><span>Model IDs <em>optional when discovery is supported</em></span><textarea value={customModels} placeholder={'One model ID per line\nqwen3.5-35b-a3b'} onInput={(event) => { setCustomModels((event.target as HTMLTextAreaElement).value); setCustomCheck(null); }} disabled={busy} /><small>AgentUse checks the runtime endpoint and discovers models before anything is saved.</small></label>
          {customCheck && <div class="provider-model-check" role="status"><strong>Endpoint ready</strong><span>{customCheck.models.length} {customCheck.models.length === 1 ? 'model' : 'models'} found at <code>{customCheck.baseURL}</code></span><ul>{customCheck.models.map((model) => <li key={model}><code>{model}</code></li>)}</ul></div>}
        </div>
      ) : provider === advancedPluginSelection && !flow ? (
        <div class="provider-plugin-source">
          <label class="provider-field">
            <span>Source</span>
            <input
              value={pluginSource}
              placeholder="owner/repo@v1.0.0"
              onInput={(event) => { setPluginSource((event.target as HTMLInputElement).value); setPluginInspection(null); }}
              disabled={busy}
            />
            <small>Use owner/repo@tag or a full commit. AgentUse will not track a moving branch.</small>
          </label>
          {pluginInspection && (
            <div class="provider-plugin-card is-unreviewed">
              <div class="provider-plugin-card-head">
                <strong>{pluginInspection.name}</strong>
                <span class="provider-plugin-badge is-unreviewed">Unreviewed</span>
              </div>
              <p>Manifest read without running plugin code. AgentUse plugin API v{pluginInspection.apiVersion}.</p>
              <dl>
                <dt>Package</dt><dd><code>{pluginInspection.name}@{pluginInspection.version}</code></dd>
                <dt>Source</dt><dd><a href={pluginInspection.repository} target="_blank" rel="noreferrer">{pluginInspection.repository.replace('https://', '')}@{pluginInspection.ref}</a></dd>
                <dt>Publisher</dt><dd><code>{pluginInspection.publisher}</code></dd>
                <dt>Provides</dt><dd>{pluginInspection.providers.length > 0
                  ? pluginInspection.providers.map((item) => <code key={item.id}>{item.id}{item.auth.length ? ` · ${authMethodLabel(item.auth)}` : ''}</code>)
                  : 'Declared when the plugin is activated'}</dd>
              </dl>
              <div class="provider-plugin-warning">This plugin is not on the reviewed shortlist that ships with AgentUse. Install it only if you trust <strong>{pluginInspection.publisher}</strong>.</div>
            </div>
          )}
        </div>
      ) : (
        <>
          {entry && entry.authMethods.length > 1 && !flow && (
            <span class="provider-method-toggle" role="group" aria-label="Authentication method">
              <button type="button" aria-pressed={method === 'oauth'} onClick={() => setMethod('oauth')} disabled={busy}>OAuth</button>
              <button type="button" aria-pressed={method === 'api_key'} onClick={() => setMethod('api_key')} disabled={busy}>API key</button>
            </span>
          )}
          {flow ? (
            <div class="provider-oauth-complete">
              {flow.kind === 'plugin' && flow.plugin && (
                <div class="provider-plugin-progress" role="status">
                  <span><i class="is-complete" />{flow.plugin.wasInstalled ? 'Loaded' : 'Downloaded'} <code>{flow.plugin.packageName}@{flow.plugin.version}</code></span>
                  <span><i class="is-complete" />Verified source <code>{flow.plugin.source}</code></span>
                  <span><i />Waiting for authorization</span>
                </div>
              )}
              <p>{oauthCopy}</p>
              <a href={flow.url} target="_blank" rel="noreferrer">Open authorization page</a>
              <label class="provider-field"><span>{provider === 'openai' ? 'Callback URL or code' : 'Authorization code'}</span><input value={code} onInput={(event) => setCode((event.target as HTMLInputElement).value)} disabled={busy} /></label>
            </div>
          ) : method === 'api_key' ? (
            <label class="provider-field"><span>API key</span><input type="password" value={key} onInput={(event) => setKey((event.target as HTMLInputElement).value)} disabled={busy} /></label>
          ) : pluginEntry ? (
            <div class="provider-plugin-card is-community">
              <div class="provider-plugin-card-head">
                <strong>{pluginEntry.name}</strong>
                <span class="provider-plugin-badge">Community</span>
              </div>
              <p>{pluginEntry.description}</p>
              <dl>
                <dt>Package</dt><dd><code>{pluginEntry.packageName}@{pluginEntry.version}</code></dd>
                <dt>Source</dt><dd><a href={pluginEntry.repository} target="_blank" rel="noreferrer">{pluginEntry.repository.replace('https://', '')}@v{pluginEntry.version}</a></dd>
                <dt>Publisher</dt><dd><code>{pluginEntry.publisher}</code></dd>
                <dt>Provides</dt><dd><code>{pluginEntry.provider} · {authMethodLabel(pluginEntry.authMethods)}</code></dd>
              </dl>
              {installedPlugin
                ? <div class="provider-method-hint">Installed on this server. Continue to connect its provider account.</div>
                : <div class="provider-plugin-warning">Installing runs code published by <strong>{pluginEntry.publisher}</strong>, not by AgentUse. It is reviewed for this release but not maintained by us. It can read the credentials it creates.</div>}
            </div>
          ) : <p class="provider-method-hint">Continue in your browser. AgentUse stores the resulting OAuth credential on the server host in its shared credential store.</p>}
        </>
      )}

      {error && <p class="provider-setup-error" role="alert">{error}</p>}
      <div class="provider-setup-actions">
        {(flow || (scope === 'all' && pluginEntry) || (provider === advancedPluginSelection && pluginInspection)) && <button type="button" class="provider-setup-secondary" onClick={() => {
          if (flow) { void cancelProviderOAuth(flow.id).catch(() => {}); setFlow(null); setCode(''); }
          else if (provider === advancedPluginSelection && pluginInspection) setPluginInspection(null);
          else setProvider(setupOptions[0]?.value ?? props.payload.catalog[0]?.id ?? 'anthropic');
        }} disabled={busy}>Back</button>}
        <button type="button" class="provider-setup-primary" onClick={() => void submit()} disabled={busy} aria-busy={busy}>
          {busy ? flow ? 'Connecting…' : provider === advancedPluginSelection && !pluginInspection ? 'Reading manifest…' : provider === advancedPluginSelection || (pluginEntry && !installedPlugin) ? 'Installing…' : pluginEntry ? 'Connecting…' : 'Working…'
            : provider === advancedPluginSelection ? pluginInspection ? 'Install and connect' : 'Read manifest'
            : provider === 'custom' ? customCheck ? 'Save provider' : 'Check endpoint'
            : method === 'api_key' ? 'Save provider'
            : flow ? 'Finish connecting'
            : pluginEntry ? installedPlugin ? 'Connect' : 'Install and connect'
            : `Continue to ${entry?.name ?? 'provider'}`}
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
  scope?: ProviderSetupScope;
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
        <div class="provider-setup-intro"><strong>{props.scope === 'plugins' ? 'Install a provider plugin' : 'Connect a model provider'}</strong><span>{props.scope === 'plugins' ? 'Choose a reviewed plugin or inspect an immutable GitHub source before installing it.' : 'Credentials are stored on the AgentUse server host and shared by projects that use its credential store.'}</span></div>
        {!payload && !error && <p class="provider-setup-loading">Loading providers…</p>}
        {error && <p class="provider-setup-error" role="alert">{error}</p>}
        {payload && <ProviderSetupForm key={`${props.scope ?? 'all'}:${props.initialProvider ?? 'default'}`} payload={payload} {...(props.initialProvider ? { initialProvider: props.initialProvider } : {})} {...(props.allowCustom !== undefined ? { allowCustom: props.allowCustom } : {})} {...(props.scope ? { scope: props.scope } : {})} onUpdated={setPayload} onComplete={props.onComplete} />}
      </div>
    </dialog>
  );
}

export function ProviderSettingsGroup() {
  const [payload, setPayload] = useState<ProviderSetupPayload | null>(null);
  const [dialog, setDialog] = useState<{
    scope: ProviderSetupScope;
    title: string;
    initialProvider?: string;
    allowCustom?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmingPlugin, setConfirmingPlugin] = useState<string | null>(null);

  useEffect(() => { void fetchProviderSetup().then(setPayload, (caught) => setError((caught as Error).message || 'Could not load providers.')); }, []);
  const catalog = payload?.catalog ?? [];
  const providers = useMemo(() => catalog.map((entry) => ({ entry, status: payload?.status.providers.find((item) => item.id === entry.id) })), [catalog, payload]);
  // Providers that exist only because an installed plugin registered them.
  // They have no dashboard login bridge yet, so the row shows status and
  // points at the CLI instead of opening a dialog that would be empty.
  const pluginProviders = useMemo(() => (payload?.status.providers ?? [])
    .filter((status) => !catalog.some((entry) => entry.id === status.id))
    .map((status) => ({ status, plugin: payload?.installedPlugins.find((item) => item.providers.some((provided) => provided.id === status.id)) })),
  [catalog, payload]);

  /** Busy key shared by a stored credential's Remove button and its handler. */
  const credentialKey = (provider: string, source: ProviderAuthSourceStatus) =>
    `${provider}:${source.kind === 'oauth' ? 'oauth' : 'api_key'}:${source.plugin?.name ?? 'core'}:${source.plugin?.authMethodId ?? ''}`;

  /** Run one mutating provider action with a busy key and a fallback error message. */
  const run = async (
    key: string,
    action: () => Promise<ProviderSetupPayload>,
    fallback: string,
    after?: (next: ProviderSetupPayload) => void,
  ) => {
    setBusyKey(key);
    setError(null);
    try {
      const next = await action();
      setPayload(next);
      after?.(next);
    } catch (caught) {
      setError((caught as Error).message || fallback);
    } finally {
      setBusyKey(null);
    }
  };

  const remove = (provider: string, source: ProviderAuthSourceStatus) => {
    const kind = source.kind === 'oauth' ? 'oauth' : 'api_key';
    return run(credentialKey(provider, source), () => removeProviderCredential(provider, kind, source.plugin), 'Could not remove credential.');
  };
  const removeCustom = (name: string) => run(`custom:${name}`, () => removeCustomProvider(name), 'Could not remove provider.');
  const refreshCustom = (name: string) => run(`refresh:${name}`, () => refreshCustomProviderModels(name), 'Could not refresh models.');
  const continueUpgrade = (plugin: string, provider: string) => run(`plugin:${plugin}`, () => installProviderPlugin(plugin), 'Could not install provider plugin.', (next) => {
    if (!next.status.providers.find((item) => item.id === provider)?.configured) {
      setDialog({
        scope: 'provider',
        title: `connect ${next.catalog.find((item) => item.id === provider)?.name ?? provider}`,
        initialProvider: pluginSelection(plugin),
      });
    }
  });
  const updatePlugin = (name: string) => run(`update-plugin:${name}`, () => updateProviderPlugin(name), 'Could not update plugin.');
  const removePlugin = async (name: string) => {
    await run(`remove-plugin:${name}`, () => removeProviderPlugin(name), 'Could not remove plugin.');
    setConfirmingPlugin(null);
  };

  return (
    <>
      <section class="settings-group provider-settings-group">
        <div class="settings-group-heading">
          <h2 class="settings-group-title">Providers</h2>
          <button type="button" class="settings-item" onClick={() => setDialog({ scope: 'all', title: 'add connection', allowCustom: true })}>Add connection</button>
        </div>
        <p class="settings-group-hint">Connections are available to every project on this server.</p>
        {!payload && !error && <p class="settings-group-hint">Loading providers…</p>}
        {error && <p class="settings-check-error" role="alert">{error}</p>}
        {providers.map(({ entry, status }) => {
          const active = status?.sources.find((source) => source.active);
          const stored = status?.sources.filter((source) => source.stored) ?? [];
          const servingPlugin = payload?.installedPlugins.find((plugin) =>
            plugin.providers.some((provided) => provided.id === entry.id),
          );
          const migrationPlugin = payload?.pluginRegistry.find((plugin) =>
            plugin.provider === entry.id && status?.actionRequired,
          );
          const migrationKey = migrationPlugin ? `plugin:${migrationPlugin.id}` : null;
          return (
            <div class="settings-row provider-settings-row" key={entry.id}>
              <div class="settings-row-text"><div class="settings-row-label">{entry.name}</div><div class="settings-row-hint">{status?.configured && servingPlugin ? `${entry.id === 'anthropic' ? 'Claude Pro or Max subscription' : entry.description} · via ${servingPlugin.name}` : active ? active.name : `${entry.description} · ${authMethodLabel(entry.authMethods)}`}</div></div>
              <div class="settings-row-control provider-settings-control">
                <span class={`provider-status${status?.configured ? ' is-ready' : ''}`}>{status?.configured ? 'Connected' : 'Not connected'}</span>
                {stored.map((source) => {
                  const removeKey = credentialKey(entry.id, source);
                  return <button key={removeKey} type="button" class="settings-item" disabled={busyKey === removeKey} onClick={() => void remove(entry.id, source)}>Remove {source.kind === 'oauth' ? 'OAuth' : 'key'}</button>;
                })}
                <button
                  type="button"
                  class="settings-item"
                  disabled={migrationKey !== null && busyKey === migrationKey}
                  onClick={() => migrationPlugin
                    ? void continueUpgrade(migrationPlugin.id, migrationPlugin.provider)
                    : setDialog({
                        scope: 'provider',
                        title: status?.configured ? `add ${entry.name} method` : `connect ${entry.name}`,
                        initialProvider: entry.id,
                      })}
                >{migrationKey !== null && busyKey === migrationKey ? 'Upgrading…' : migrationPlugin ? 'Continue upgrade' : status?.configured ? 'Add method' : 'Connect'}</button>
              </div>
            </div>
          );
        })}
        {pluginProviders.map(({ status, plugin }) => (
          <div class="settings-row provider-settings-row" key={status.id}>
            <div class="settings-row-text">
              <div class="settings-row-label">{status.name}</div>
              <div class="settings-row-hint">{plugin ? `via ${plugin.name} · ` : ''}{status.configured ? status.sources.find((source) => source.active)?.name ?? 'Connected' : <>Connect with <code>agentuse provider login {status.id}</code></>}</div>
            </div>
            <div class="settings-row-control provider-settings-control">
              <span class={`provider-status${status.configured ? ' is-ready' : ''}`}>{status.configured ? 'Connected' : 'Not connected'}</span>
              {status.sources.filter((source) => source.stored).map((source) => {
                const removeKey = credentialKey(status.id, source);
                return <button key={removeKey} type="button" class="settings-item" disabled={busyKey === removeKey} onClick={() => void remove(status.id, source)}>Remove {source.kind === 'oauth' ? 'OAuth' : 'key'}</button>;
              })}
            </div>
          </div>
        ))}
        {payload?.status.customProviders.map((provider) => (
          <div class="settings-row provider-settings-row" key={provider.id}>
            <div class="settings-row-text"><div class="settings-row-label">{provider.id}</div><div class="settings-row-hint">{provider.baseURL} · {provider.models?.length ?? 0} {provider.models?.length === 1 ? 'model' : 'models'}</div></div>
            <div class="settings-row-control provider-settings-control"><span class="provider-status is-ready">{provider.hasApiKey ? 'Connected' : 'Connected · keyless'}</span><button type="button" class="settings-item" disabled={busyKey === `refresh:${provider.id}`} onClick={() => void refreshCustom(provider.id)}>{busyKey === `refresh:${provider.id}` ? 'Refreshing…' : 'Refresh models'}</button><button type="button" class="settings-item" disabled={busyKey === `custom:${provider.id}`} onClick={() => void removeCustom(provider.id)}>Remove</button></div>
          </div>
        ))}
        {payload && <div class="settings-row"><div class="settings-row-text"><div class="settings-row-label">Custom provider</div><div class="settings-row-hint">Add a compatible model endpoint.</div></div><div class="settings-row-control"><button type="button" class="settings-item" onClick={() => setDialog({ scope: 'provider', title: 'add custom provider', initialProvider: 'custom', allowCustom: true })}>Add provider</button></div></div>}
      </section>
      {payload && (
        <section class="settings-group provider-plugin-settings-group">
          <div class="settings-group-heading">
            <h2 class="settings-group-title">Installed plugins</h2>
            <button type="button" class="settings-item" onClick={() => setDialog({ scope: 'plugins', title: 'install provider plugin' })}>Install plugin</button>
          </div>
          {payload.installedPlugins.length === 0 && <p class="settings-group-hint">No provider plugins installed.</p>}
          {payload.installedPlugins.map((plugin) => (
            <div class="settings-row provider-settings-row" key={plugin.packageName}>
              <div class="settings-row-text">
                <div class="settings-row-label provider-installed-plugin-name">
                  {plugin.name}
                  <span class={`provider-plugin-badge${plugin.provenance === 'unreviewed' ? ' is-unreviewed' : ''}`}>{plugin.provenance === 'community' ? 'Community' : 'Unreviewed'}</span>
                </div>
                <div class="settings-row-hint"><code>{plugin.packageName}@{plugin.version}</code> · {plugin.publisher}</div>
              </div>
              <div class="settings-row-control provider-settings-control">
                <button type="button" class="settings-item" disabled={busyKey === `update-plugin:${plugin.packageName}`} onClick={() => void updatePlugin(plugin.packageName)}>{busyKey === `update-plugin:${plugin.packageName}` ? 'Updating…' : 'Update'}</button>
                {confirmingPlugin === plugin.packageName ? (
                  <>
                    <span class="settings-row-hint provider-remove-warning" role="status">
                      {plugin.providers.length > 0
                        ? `Logins through ${plugin.providers.map((provided) => provided.id).join(', ')} stop working until it is reinstalled. Saved credentials are kept.`
                        : 'Saved credentials are kept.'}
                    </span>
                    <button type="button" class="settings-item" disabled={busyKey === `remove-plugin:${plugin.packageName}`} onClick={() => setConfirmingPlugin(null)}>Cancel</button>
                    <button type="button" class="settings-item is-danger" disabled={busyKey === `remove-plugin:${plugin.packageName}`} onClick={() => void removePlugin(plugin.packageName)}>{busyKey === `remove-plugin:${plugin.packageName}` ? 'Removing…' : 'Confirm remove'}</button>
                  </>
                ) : (
                  <button type="button" class="settings-item" onClick={() => setConfirmingPlugin(plugin.packageName)}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
      <ProviderSetupDialog
        open={dialog !== null}
        {...(dialog?.initialProvider ? { initialProvider: dialog.initialProvider } : {})}
        {...(dialog?.allowCustom !== undefined ? { allowCustom: dialog.allowCustom } : {})}
        {...(dialog?.scope ? { scope: dialog.scope } : {})}
        title={dialog?.title ?? 'connect a provider'}
        onComplete={(next) => { setPayload(next); setDialog(null); }}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
