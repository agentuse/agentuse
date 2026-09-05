import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProviderAuthSourceStatus, ProviderAuthStatus, ProviderStatus } from '../../../../auth/provider-status';
import {
  checkCustomProvider,
  completeProviderPluginOAuth,
  completeProviderOAuth,
  applyProviderReadiness,
  fetchProviderReadiness,
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
  return methods.map((method) => method === 'api_key' ? 'API key' : 'Account sign-in').join(' or ');
}

/** Two-letter mark so a row is recognisable before its name is read. */
function monogram(name: string): string {
  // Split CamelCase too, so OpenAI and OpenRouter do not both read "OP".
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '··';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/**
 * `owner/repo@ref` (or a github URL) becomes a browsable link. A locally
 * installed plugin's source is a filesystem path, which has nowhere to link to.
 */
function pluginSourceLink(source: string): { href: string; label: string } | null {
  const path = source.replace(/^(?:github:|git:)/, '').replace(/^https:\/\/github\.com\//, '');
  if (!/^[\w.-]+\/[\w.-]+(?:@.+)?$/.test(path)) return null;
  const repo = path.split('@')[0] ?? path;
  return { href: `https://github.com/${repo}`, label: `github.com/${path}` };
}

/** Existing credentials, including environment keys, occupy their auth method. */
export function missingProviderMethods(payload: ProviderSetupPayload): ProviderSetupPayload {
  const sources = (id: string) => payload.status.providers.find((p) => p.id === id)?.sources ?? [];
  return {
    ...payload,
    catalog: payload.catalog.map((entry) => ({
      ...entry,
      authMethods: entry.authMethods.filter((method) => !sources(entry.id).some((source) =>
        !source.plugin && (source.kind === method || (method === 'api_key' && source.kind === 'environment')))),
    })).filter((entry) => entry.authMethods.length > 0),
    pluginRegistry: payload.pluginRegistry.filter((plugin) => !sources(plugin.provider).some((source) =>
      source.plugin?.name === plugin.packageName && source.plugin.authMethodId === plugin.authMethodId)),
  };
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
  return [...builtIn, ...(allowCustom ? [custom] : []), ...community, advancedPlugin];
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
  onComplete: (payload: ProviderSetupPayload, connectedName: string) => void;
  onStep?: (step: 1 | 2 | 3) => void;
  /** Replace a rejected credential: always run the sign-in flow. */
  reconnect?: boolean;
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
  const [pluginTrusted, setPluginTrusted] = useState(false);
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
    setPluginTrusted(false);
    setError(null);
    const next = props.payload.catalog.find((item) => item.id === provider);
    const nextPlugin = props.payload.pluginRegistry.find((item) => pluginSelection(item.id) === provider);
    setMethod(nextPlugin || next?.authMethods.includes('oauth') ? 'oauth' : 'api_key');
  }, [provider]);

  // Only the reviewed shortlist offers a pick; an empty shortlist lands
  // straight on the GitHub source field.
  const pluginsOnlyAdvanced = scope === 'plugins' && setupOptions.every((option) => option.value === advancedPluginSelection);
  const isApiKeyStep = provider !== 'custom' && provider !== advancedPluginSelection && method === 'api_key';
  const step: 1 | 2 | 3 = flow || isApiKeyStep || provider === 'custom' || pluginInspection ? 2 : 1;
  const reportStep = props.onStep;
  useEffect(() => { reportStep?.(step); }, [step, reportStep]);

  const connectedName = () => entry?.name
    ?? pluginEntry?.name
    ?? pluginInspection?.name
    ?? (provider === 'custom' ? customName || 'The provider' : provider);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let next: ProviderSetupPayload;
      if (provider === advancedPluginSelection && !flow) {
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
        const started = await startProviderPluginOAuth(pluginEntry.id, props.reconnect === true);
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
      } else if (method === 'api_key' && !flow) {
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
      const name = connectedName();
      setKey('');
      setCustomKey('');
      props.onUpdated(next);
      props.onComplete(next, name);
    } catch (caught) {
      setError((caught as Error).message || 'Provider setup failed.');
    } finally {
      setBusy(false);
    }
  };

  const oauthCopy = provider === 'openai'
    ? 'Sign in with ChatGPT, then paste the full callback URL below.'
    : `Authorize ${pluginEntry?.name ?? pluginInspection?.name ?? 'the provider plugin'}, then paste the authorization code below.`;

  const blockedByTrust = provider === advancedPluginSelection && pluginInspection !== null && !flow && !pluginTrusted;

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
          {pluginsOnlyAdvanced && (
            <>
              <div class="provider-all-installed"><i aria-hidden="true" />All reviewed plugins are already installed. Manage them from the list behind this dialog.</div>
              <div class="provider-source-divider">or from GitHub</div>
            </>
          )}
          <label class="provider-field">
            <span>Source</span>
            <input
              value={pluginSource}
              placeholder="owner/repo@v1.0.0"
              onInput={(event) => { setPluginSource((event.target as HTMLInputElement).value); setPluginInspection(null); setPluginTrusted(false); }}
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
              <div class="provider-plugin-trust">
                <span>This plugin is not on the reviewed shortlist that ships with AgentUse. Installing runs code published by <strong>{pluginInspection.publisher}</strong>, and it can read the credentials it creates.</span>
                <label>
                  <input type="checkbox" checked={pluginTrusted} onChange={(event) => setPluginTrusted((event.target as HTMLInputElement).checked)} disabled={busy} />
                  I trust this publisher
                </label>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {entry && entry.authMethods.length > 1 && !flow && (
            <span class="provider-method-toggle" role="group" aria-label="Authentication method">
              <button type="button" aria-pressed={method === 'oauth'} onClick={() => setMethod('oauth')} disabled={busy}>Account sign-in</button>
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
          else if (provider === advancedPluginSelection && pluginInspection) { setPluginInspection(null); setPluginTrusted(false); }
          else setProvider(setupOptions[0]?.value ?? props.payload.catalog[0]?.id ?? 'anthropic');
        }} disabled={busy}>Back</button>}
        <button type="button" class="provider-setup-primary" onClick={() => void submit()} disabled={busy || blockedByTrust} aria-busy={busy}>
          {busy ? flow ? 'Connecting…' : provider === advancedPluginSelection && !pluginInspection ? 'Reading manifest…' : provider === advancedPluginSelection || (pluginEntry && !installedPlugin) ? 'Installing…' : pluginEntry ? 'Connecting…' : 'Working…'
            : flow ? 'Finish connecting'
            : provider === advancedPluginSelection ? pluginInspection ? 'Install and continue' : 'Read manifest'
            : provider === 'custom' ? customCheck ? 'Save provider' : 'Check endpoint'
            : method === 'api_key' ? 'Save provider'
            : pluginEntry ? installedPlugin ? 'Connect' : 'Install and continue'
            : `Continue to ${entry?.name ?? 'provider'}`}
        </button>
      </div>
    </div>
  );
}

const STEP_LABELS = ['Choose', 'Sign in', 'Done'] as const;

/** Where the flow is: choosing, authenticating, or finished. */
function ProviderSetupSteps({ step }: { step: 1 | 2 | 3 }) {
  const items: ComponentChildren[] = [];
  STEP_LABELS.forEach((label, index) => {
    if (index > 0) items.push(<span class="provider-step-bar" key={`bar-${label}`} />);
    const done = index + 1 < step || step === 3;
    items.push(
      <span key={label} class={`provider-step${done ? ' is-done' : ''}${index + 1 === step ? ' is-on' : ''}`}>
        <i>{done ? '✓' : index + 1}</i>{label}
      </span>,
    );
  });
  return <div class="provider-setup-steps" aria-hidden="true">{items}</div>;
}

export function ProviderSetupDialog(props: {
  open: boolean;
  title?: string;
  initialProvider?: string;
  allowCustom?: boolean;
  scope?: ProviderSetupScope;
  onComplete: (payload: ProviderSetupPayload) => void;
  onClose: () => void;
  missingOnly?: boolean;
  reconnect?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [payload, setPayload] = useState<ProviderSetupPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [done, setDone] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const setupPayload = payload && (props.missingOnly ? missingProviderMethods(payload) : payload);
  const hasOptions = setupPayload && providerSetupOptions(setupPayload, props.allowCustom, props.scope, props.initialProvider).length > 0;

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
    setDone(null);
    setStep(1);
    setFormKey((current) => current + 1);
    void fetchProviderSetup().then(setPayload, (caught) => setError((caught as Error).message || 'Could not load providers.'));
  }, [props.open]);

  const installingPlugins = props.scope === 'plugins';

  return (
    <dialog class="provider-setup-dialog" ref={dialogRef} aria-labelledby="provider-setup-title" onClose={props.onClose} onClick={(event) => { if (event.target === dialogRef.current) props.onClose(); }}>
      <div class="dialog-head"><span id="provider-setup-title" class="title">{props.title ?? 'connect a provider'}</span><button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button></div>
      <div class="provider-setup-body">
        {!installingPlugins && <ProviderSetupSteps step={done ? 3 : step} />}
        <div class="provider-setup-intro"><strong>{installingPlugins ? 'Install a provider plugin' : 'Connect a model provider'}</strong><span>{installingPlugins ? 'Plugins add providers that AgentUse does not ship with. Reviewed ones are one click; anything else is read from a pinned GitHub source first.' : 'Credentials are stored on the AgentUse server host and shared by projects that use its credential store.'}</span></div>
        {!payload && !error && <p class="provider-setup-loading">Loading providers…</p>}
        {error && <p class="provider-setup-error" role="alert">{error}</p>}
        {done ? (
          <>
            <div class="provider-setup-done" role="status">
              <span class="provider-setup-check" aria-hidden="true">
                <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5l3.5 3.5 7.5-8" /></svg>
              </span>
              <span>
                <strong>{done} is connected</strong>
                <span>Every project on this server can use it.</span>
              </span>
            </div>
            <div class="provider-setup-actions">
              <button type="button" class="provider-setup-secondary" onClick={() => { setDone(null); setStep(1); setFormKey((current) => current + 1); }}>Add another</button>
              <button type="button" class="provider-setup-primary" onClick={props.onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            {setupPayload && !hasOptions && <p class="provider-method-hint">All supported connection methods are already configured.</p>}
            {setupPayload && hasOptions && <ProviderSetupForm
              key={`${props.scope ?? 'all'}:${props.initialProvider ?? 'default'}:${formKey}`}
              payload={setupPayload}
              {...(props.initialProvider ? { initialProvider: props.initialProvider } : {})}
              {...(props.allowCustom !== undefined ? { allowCustom: props.allowCustom } : {})}
              {...(props.scope ? { scope: props.scope } : {})}
              reconnect={props.reconnect === true}
              onUpdated={setPayload}
              onStep={setStep}
              onComplete={(next, name) => { props.onComplete(next); setDone(name); }}
            />}
          </>
        )}
      </div>
    </dialog>
  );
}

/**
 * Plugin rows have no dashboard login dialog. A failed readiness check (say a
 * bridged CLI that is not installed) explains itself here, with the fix
 * command, so the row never reads "Connected" for something that cannot run.
 */
export function providerHealthLabel(status: ProviderAuthStatus | undefined): string {
  if (status?.health?.state === 'reconnect_required') return 'Sign-in required';
  if (status?.checkPending && !status.health?.checkedAt) return 'Checking…';
  if (status?.health?.state === 'temporarily_unavailable') return 'Temporarily unavailable';
  if (status?.health?.state === 'verified') return 'Connected';
  if (status?.configured) return 'Not checked';
  return 'Not connected';
}

function ProviderHealthBadge({ status, popped }: { status: ProviderAuthStatus | undefined; popped?: boolean }) {
  const state = status?.health?.state;
  const tone = state === 'verified' ? ' is-ready'
    : state === 'reconnect_required' || state === 'temporarily_unavailable' ? ' is-warning'
      : status?.checkPending ? ' is-pending' : '';
  return <span class={`provider-status${tone}${popped ? ' is-pop' : ''}`} aria-live="polite"><i aria-hidden="true" />{providerHealthLabel(status)}</span>;
}

/** One sentence about the last check, for the expanded body. The message is
 *  dropped when a notice strip above the line already states it. */
function providerHealthMessage(status: ProviderAuthStatus | undefined, omitMessage = false): ComponentChildren {
  if (!status?.health) {
    return status?.checkPending
      ? 'Checking this connection…'
      : 'No test has run yet. Runs check it on first use.';
  }
  return <>{!omitMessage && status.health.message}
    {status.health.checkedAt && <> Checked {new Date(status.health.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</>}
    {status.checkPending && <> Checking again…</>}
  </>;
}

function pluginProviderHint(status: ProviderAuthStatus) {
  if (status.checkPending) return 'Checking the CLI…';
  if (status.readiness && !status.readiness.ok) {
    return <>{status.readiness.message}{status.readiness.fix && <> Fix: <code>{status.readiness.fix}</code></>}</>;
  }
  if (status.configured) {
    const source = status.sources.find((item) => item.active)?.name ?? 'Installed';
    return status.readiness?.detail ? `${source} · ${status.readiness.detail}` : source;
  }
  return <>Connect with <code>agentuse provider login {status.id}</code></>;
}

function Chevron() {
  return (
    <span class="provider-chevron" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4" /></svg>
    </span>
  );
}

/** A settings row whose whole header is the disclosure control. */
function ExpandRow(props: {
  rowId: string;
  open: boolean;
  onToggle: () => void;
  mono: string;
  name: ComponentChildren;
  sub: ComponentChildren;
  aside?: ComponentChildren;
  children: ComponentChildren;
}) {
  const panelId = `provider-row-${props.rowId.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  return (
    <div class={`provider-row${props.open ? ' is-open' : ''}`}>
      <button type="button" class="provider-row-head" aria-expanded={props.open} aria-controls={panelId} onClick={props.onToggle}>
        <span class="provider-mono" aria-hidden="true">{props.mono}</span>
        <span class="provider-row-copy">
          <span class="provider-row-name">{props.name}</span>
          <span class="provider-row-sub">{props.sub}</span>
        </span>
        {props.aside}
        <Chevron />
      </button>
      <div class="provider-details" id={panelId} role="region">
        <div class="provider-details-in">
          <div class="provider-details-body">{props.children}</div>
        </div>
      </div>
    </div>
  );
}

/** Destructive actions ask in place rather than opening a dialog. */
function ConfirmInline(props: {
  label: string;
  warning: string;
  busy: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  return (
    <span class="provider-confirm" role="group" aria-label={`Confirm ${props.label.toLowerCase()}`}>
      <span class="provider-confirm-text">{props.warning}</span>
      <button type="button" class="provider-quiet-btn" disabled={props.busy} onClick={props.onKeep}>Keep</button>
      <button type="button" class="provider-quiet-btn is-danger" disabled={props.busy} onClick={props.onConfirm}>{props.busy ? 'Working…' : props.label}</button>
    </span>
  );
}

export function ProviderSettingsGroup({ section = 'providers', initialExpanded }: {
  section?: 'providers' | 'plugins';
  initialExpanded?: string;
}) {
  const [payload, setPayload] = useState<ProviderSetupPayload | null>(null);
  const [dialog, setDialog] = useState<{
    scope: ProviderSetupScope;
    title: string;
    initialProvider?: string;
    allowCustom?: boolean;
    missingOnly?: boolean;
    reconnect?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(initialExpanded ?? null);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingPlugin, setConfirmingPlugin] = useState<string | null>(null);
  const [popped, setPopped] = useState<string | null>(null);
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (popTimer.current) clearTimeout(popTimer.current); }, []);

  // Render durable cached health first. Only stale checks touch providers.
  // Poll the local snapshot while visible so failures from running workers
  // reach an already-open Settings page without repeated authentication calls.
  useEffect(() => {
    if (busyKey || dialog) return;
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const initial = await fetchProviderSetup({ deferReadiness: true });
        if (cancelled) return;
        setPayload(initial);
        setError(null);
        if (initial.status.providers.some((provider) => provider.checkPending)) {
          const { providers } = await fetchProviderReadiness();
          if (!cancelled) setPayload((current) => current ? applyProviderReadiness(current, providers) : current);
        }
      } catch (caught) {
        if (!cancelled) setError((caught as Error).message || 'Could not check providers.');
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [busyKey, dialog]);
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

  const toggleProvider = (id: string) => {
    setConfirming(null);
    setExpandedProvider((current) => current === id ? null : id);
  };
  const togglePlugin = (id: string) => {
    setConfirmingPlugin(null);
    setExpandedPlugin((current) => current === id ? null : id);
  };

  /** Run one mutating provider action with a busy key and a fallback error message. */
  const run = async (
    key: string,
    action: () => Promise<ProviderSetupPayload>,
    fallback: string,
    after?: (next: ProviderSetupPayload) => void,
  ) => {
    if (busyKey) return;
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

  const remove = async (provider: string, source: ProviderAuthSourceStatus) => {
    const kind = source.kind === 'oauth' ? 'oauth' : 'api_key';
    await run(credentialKey(provider, source), () => removeProviderCredential(provider, kind, source.plugin), 'Could not remove credential.');
    setConfirming(null);
  };
  const removeCustom = async (name: string) => {
    await run(`custom:${name}`, () => removeCustomProvider(name), 'Could not remove provider.', () => setExpandedProvider(null));
    setConfirming(null);
  };
  const refreshCustom = (name: string) => run(`refresh:${name}`, () => refreshCustomProviderModels(name), 'Could not refresh models.');
  const recheck = (provider: string) => run(`recheck:${provider}`, async () => {
    const result = await fetchProviderReadiness({ provider, force: true });
    const current = payload ?? await fetchProviderSetup({ deferReadiness: true });
    return applyProviderReadiness(current, result.providers);
  }, 'Could not recheck provider.', (next) => {
    if (next.status.providers.find((item) => item.id === provider)?.health?.state !== 'verified') return;
    if (popTimer.current) clearTimeout(popTimer.current);
    setPopped(provider);
    popTimer.current = setTimeout(() => setPopped(null), 400);
  });
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
    await run(`remove-plugin:${name}`, () => removeProviderPlugin(name), 'Could not remove plugin.', () => setExpandedPlugin(null));
    setConfirmingPlugin(null);
  };

  /** What stops working when this stored credential goes away. */
  const removalWarning = (status: ProviderAuthStatus | undefined, source: ProviderAuthSourceStatus) => {
    if (!source.active) return 'Fallback goes away.';
    const others = (status?.sources ?? []).filter((item) => item !== source);
    return others.length === 0 ? 'Runs on this provider will stop.' : 'Runs fall back to the next method.';
  };

  const sourceSubText = (source: ProviderAuthSourceStatus) => source.kind === 'environment'
    ? 'Set on the server'
    : source.active ? 'Saved on this server' : 'Available as fallback';

  /** Stored connection methods, each with an inline remove confirmation. */
  const MethodList = ({ providerId, status }: { providerId: string; status: ProviderAuthStatus | undefined }) => {
    const sources = status?.sources ?? [];
    if (sources.length === 0) return null;
    return (
      <div class="provider-methods">
        {sources.map((source) => {
          const key = credentialKey(providerId, source);
          const label = source.kind === 'oauth' ? 'Disconnect' : 'Remove key';
          return (
            <div class="provider-method" key={key + source.name}>
              <span class="provider-method-copy">
                <span class="provider-method-name">{source.name}{source.active && <span class="provider-in-use"><i aria-hidden="true" />in use</span>}</span>
                <span class="provider-method-sub">{sourceSubText(source)}</span>
              </span>
              {source.stored && (confirming === key
                ? <ConfirmInline
                    label={label}
                    warning={removalWarning(status, source)}
                    busy={busyKey === key}
                    onKeep={() => setConfirming(null)}
                    onConfirm={() => void remove(providerId, source)}
                  />
                : <button type="button" class="provider-quiet-btn" disabled={busyKey !== null} onClick={() => setConfirming(key)}>{label}</button>)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {section === 'providers' && <section class="settings-group provider-settings-group">
        <div class="settings-group-heading">
          <h2 class="settings-group-title">AI connections</h2>
          <button type="button" class="settings-item" onClick={() => setDialog({ scope: 'all', title: 'add connection', allowCustom: true, missingOnly: true })}>Add connection</button>
        </div>
        <p class="settings-group-hint">Connections are available to every project on this server. Open a row to manage it.</p>
        {!payload && !error && <p class="settings-group-hint">Loading providers…</p>}
        {error && <p class="settings-check-error" role="alert">{error}</p>}
        {providers.map(({ entry, status }) => {
          const open = expandedProvider === entry.id;
          const hasMissingMethod = Boolean(payload && providerSetupOptions(missingProviderMethods(payload), false, 'provider', entry.id).length > 0);
          const servingPlugin = payload?.installedPlugins.find((plugin) =>
            plugin.providers.some((provided) => provided.id === entry.id),
          );
          const active = status?.sources.find((source) => source.active);
          const migrationPlugin = payload?.pluginRegistry.find((plugin) =>
            plugin.provider === entry.id && !servingPlugin && status?.actionRequired,
          );
          const migrationKey = migrationPlugin ? `plugin:${migrationPlugin.id}` : null;
          const reconnect = status?.health?.state === 'reconnect_required';
          const authPlugin = payload?.pluginRegistry.find((plugin) => plugin.packageName === active?.plugin?.name);
          const displayName = active?.plugin && servingPlugin ? servingPlugin.name : entry.name;
          return (
            <ExpandRow
              key={entry.id}
              rowId={entry.id}
              open={open}
              onToggle={() => toggleProvider(entry.id)}
              mono={monogram(displayName)}
              name={displayName}
              sub={status?.sources.length ? status.sources.map((source) => source.name).join(' · ') : `${entry.description} · ${authMethodLabel(entry.authMethods)}`}
              aside={<ProviderHealthBadge status={status} popped={popped === entry.id} />}
            >
              {(reconnect || migrationPlugin) && (
                <div class="provider-notice">
                  <span>{migrationPlugin
                    ? status?.actionRequired ?? 'This connection moved to a provider plugin. Continue the upgrade to keep using it.'
                    : status?.health?.message ?? 'The saved sign-in expired. Reconnect to keep runs on this provider going.'}</span>
                  <button
                    type="button"
                    class="settings-item"
                    disabled={migrationKey !== null && busyKey === migrationKey}
                    onClick={() => migrationPlugin
                      ? void continueUpgrade(migrationPlugin.id, migrationPlugin.provider)
                      : setDialog({
                          scope: 'provider',
                          title: `reconnect ${displayName}`,
                          reconnect: true,
                          initialProvider: authPlugin ? pluginSelection(authPlugin.id) : entry.id,
                        })}
                  >{migrationKey !== null && busyKey === migrationKey ? 'Upgrading…' : migrationPlugin ? 'Continue upgrade' : 'Reconnect'}</button>
                </div>
              )}
              <div class="provider-health-line">
                <span>{providerHealthMessage(status, Boolean(reconnect || migrationPlugin))}</span>
                {active && <button type="button" class="settings-item" disabled={busyKey === `recheck:${entry.id}`} onClick={() => void recheck(entry.id)}>{busyKey === `recheck:${entry.id}` ? 'Testing…' : 'Test connection'}</button>}
              </div>
              <MethodList providerId={entry.id} status={status} />
              <div class="provider-row-foot">
                <span>{servingPlugin ? <>Served by plugin <code>{servingPlugin.packageName}@{servingPlugin.version}</code></> : 'Built in'}</span>
                {hasMissingMethod && <button
                  type="button"
                  class="provider-quiet-btn"
                  onClick={() => setDialog({
                    scope: 'provider',
                    title: status?.sources.length ? `add a method for ${entry.name}` : `connect ${entry.name}`,
                    missingOnly: true,
                    initialProvider: entry.id,
                  })}
                >{status?.sources.length ? 'Add connection method' : 'Connect'}</button>}
              </div>
            </ExpandRow>
          );
        })}
        {pluginProviders.map(({ status, plugin }) => (
          <ExpandRow
            key={status.id}
            rowId={status.id}
            open={expandedProvider === status.id}
            onToggle={() => toggleProvider(status.id)}
            mono={monogram(status.name)}
            name={status.name}
            sub={expandedProvider === status.id ? pluginProviderHint(status) : 'Local installation'}
            aside={<ProviderHealthBadge status={status} popped={popped === status.id} />}
          >
            <div class="provider-health-line">
              <span>{providerHealthMessage(status)}</span>
              <button type="button" class="settings-item" disabled={busyKey === `recheck:${status.id}`} onClick={() => void recheck(status.id)}>{busyKey === `recheck:${status.id}` ? 'Testing…' : 'Test connection'}</button>
            </div>
            <MethodList providerId={status.id} status={status} />
            <div class="provider-row-foot">
              <span>{plugin ? <>Served by plugin <code>{plugin.packageName}@{plugin.version}</code></> : 'Served by an installed plugin'}</span>
            </div>
          </ExpandRow>
        ))}
        {payload?.status.customProviders.map((provider) => {
          const rowId = `custom:${provider.id}`;
          const removeKey = `custom:${provider.id}`;
          return (
            <ExpandRow
              key={provider.id}
              rowId={rowId}
              open={expandedProvider === rowId}
              onToggle={() => toggleProvider(rowId)}
              mono={monogram(provider.id)}
              name={provider.id}
              sub={`${provider.baseURL} · ${provider.models?.length ?? 0} ${provider.models?.length === 1 ? 'model' : 'models'}`}
              aside={<span class="provider-status"><i aria-hidden="true" />{providerHealthLabel({ id: provider.id, name: provider.id, configured: true, sources: [], ...(provider.health && { health: provider.health }) })}</span>}
            >
              <div class="provider-health-line">
                <span>{provider.health?.message ?? 'Custom endpoint saved on this server.'}</span>
                <button type="button" class="settings-item" disabled={busyKey === `refresh:${provider.id}`} onClick={() => void refreshCustom(provider.id)}>{busyKey === `refresh:${provider.id}` ? 'Refreshing…' : 'Refresh models'}</button>
              </div>
              <div class="provider-row-foot">
                <span><code>{provider.baseURL}</code></span>
                {confirming === removeKey
                  ? <ConfirmInline
                      label="Remove connection"
                      warning="Runs on this provider will stop."
                      busy={busyKey === removeKey}
                      onKeep={() => setConfirming(null)}
                      onConfirm={() => void removeCustom(provider.id)}
                    />
                  : <button type="button" class="provider-quiet-btn is-danger" disabled={busyKey !== null} onClick={() => setConfirming(removeKey)}>Remove connection</button>}
              </div>
            </ExpandRow>
          );
        })}
      </section>}
      {section === 'plugins' && (
        <section class="settings-group provider-plugin-settings-group">
          <div class="settings-group-heading">
            <h2 class="settings-group-title">Installed plugins</h2>
            <button type="button" class="settings-item" onClick={() => setDialog({ scope: 'plugins', title: 'install provider plugin' })}>Install plugin</button>
          </div>
          <p class="settings-group-hint">Plugins add providers. Their credentials live under Providers.</p>
          {!payload && !error && <p class="settings-group-hint">Loading plugins…</p>}
          {error && <p class="settings-check-error" role="alert">{error}</p>}
          {payload && (payload.installedPlugins.length === 0) && <p class="settings-group-hint">No provider plugins installed.</p>}
          {(payload?.installedPlugins ?? []).map((plugin) => {
            const registryEntry = payload?.pluginRegistry.find((item) => item.packageName === plugin.packageName);
            const displayName = registryEntry?.name
              ?? (plugin.providers.map((provided) => payload?.status.providers.find((p) => p.id === provided.id)?.name).filter(Boolean).join(', ') || plugin.name);
            const link = pluginSourceLink(plugin.source);
            const providedIds = plugin.providers.map((provided) => provided.id);
            const removeKey = `remove-plugin:${plugin.packageName}`;
            return (
              <ExpandRow
                key={plugin.packageName}
                rowId={plugin.packageName}
                open={expandedPlugin === plugin.packageName}
                onToggle={() => togglePlugin(plugin.packageName)}
                mono={monogram(displayName)}
                name={<span class="provider-installed-plugin-name">{displayName}<span class={`provider-plugin-badge${plugin.provenance === 'unreviewed' ? ' is-unreviewed' : ''}`}>{plugin.provenance === 'community' ? 'Community' : 'Unreviewed'}</span></span>}
                sub={/[A-Za-z0-9]/.test(plugin.publisher) && plugin.publisher !== 'unknown' ? `v${plugin.version} · ${plugin.publisher}` : `v${plugin.version}`}
              >
                <dl class="provider-kv">
                  <dt>Package</dt><dd><code>{plugin.packageName}@{plugin.version}</code></dd>
                  <dt>Source</dt><dd>{link
                    ? <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                    : <code>{plugin.source}</code>}</dd>
                  <dt>Publisher</dt><dd><code>{plugin.publisher}</code></dd>
                  <dt>Provides</dt><dd>{providedIds.length > 0
                    ? <>{providedIds.map((id) => <code key={id}>{id}</code>)} · <a href={`/settings?tab=providers&provider=${encodeURIComponent(providedIds[0]!)}`}>open in Providers</a></>
                    : 'Declared when the plugin is activated'}</dd>
                </dl>
                {confirmingPlugin === plugin.packageName ? (
                  <div class="provider-notice">
                    <span>{providedIds.length > 0
                      ? `Logins through ${providedIds.join(', ')} stop working until it is reinstalled. Saved credentials are kept.`
                      : 'Saved credentials are kept.'}</span>
                    <span class="provider-confirm" role="group" aria-label="Confirm uninstall">
                      <button type="button" class="provider-quiet-btn" disabled={busyKey === removeKey} onClick={() => setConfirmingPlugin(null)}>Keep</button>
                      <button type="button" class="provider-quiet-btn is-danger" disabled={busyKey === removeKey} onClick={() => void removePlugin(plugin.packageName)}>{busyKey === removeKey ? 'Uninstalling…' : 'Uninstall'}</button>
                    </span>
                  </div>
                ) : (
                  <div class="provider-row-actions">
                    <button type="button" class="provider-quiet-btn is-danger" disabled={busyKey !== null} onClick={() => setConfirmingPlugin(plugin.packageName)}>Uninstall</button>
                    <button type="button" class="settings-item" disabled={busyKey === `update-plugin:${plugin.packageName}`} onClick={() => void updatePlugin(plugin.packageName)}>{busyKey === `update-plugin:${plugin.packageName}` ? 'Updating…' : 'Update'}</button>
                  </div>
                )}
              </ExpandRow>
            );
          })}
        </section>
      )}
      <ProviderSetupDialog
        open={dialog !== null}
        {...(dialog?.initialProvider ? { initialProvider: dialog.initialProvider } : {})}
        {...(dialog?.allowCustom !== undefined ? { allowCustom: dialog.allowCustom } : {})}
        {...(dialog?.scope ? { scope: dialog.scope } : {})}
        missingOnly={dialog?.missingOnly ?? false}
        reconnect={dialog?.reconnect ?? false}
        title={dialog?.title ?? 'connect a provider'}
        onComplete={setPayload}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
