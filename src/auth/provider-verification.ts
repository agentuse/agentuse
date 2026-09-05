import { OPENCODE_GO_BASE_URL, resolveOpenCodeGoBaseURL } from '../providers/opencode-go';
import { AuthStorage } from './storage';
import { CodexAuth } from './codex';
import type { ProviderAuthSourceStatus, ProviderAuthStatus, ProviderStatusOptions } from './provider-status';
import { apiHealthSubject, oauthHealthSubject } from './provider-health-identity';
import {
  fetchWithProviderHealth, providerHealthNeedsCheck,
  readProviderHealth, verifyProviderHealth,
  type ProviderHealthState, type ProviderHealthSubject,
} from './provider-health';
import {
  checkProviderReadiness, describeReadinessFailure, getProviderPatch, providerAuthHealthSubject, providerReadinessHealthSubject, resolveProviderAuth,
} from '../plugin/provider-runtime';
import type { ProviderDefinition } from '../plugin/types';

interface ConnectionCheck {
  subject: ProviderHealthSubject;
  verify: () => Promise<ProviderHealthState>;
  /** OAuth refresh may have rotated the credential. */
  currentSubject?: () => Promise<ProviderHealthSubject | undefined>;
}

async function sourceCheck(id: string, source: ProviderAuthSourceStatus, definitions: ProviderDefinition[]): Promise<ConnectionCheck | undefined> {
  const methodId = source.plugin?.authMethodId ?? source.authMethodId;
  const definition = definitions.find((provider) => provider.auth?.methods.some((method) => method.id === methodId));
  if (definition && methodId) {
    const subject = await providerAuthHealthSubject(definition, methodId, source.kind !== 'environment');
    if (!subject) return undefined;
    return {
      subject,
      currentSubject: () => providerAuthHealthSubject(definition, methodId, source.kind !== 'environment'),
      verify: async () => {
        await resolveProviderAuth(definition, methodId, AbortSignal.timeout(10_000));
        if (definition.check) {
          const readiness = await checkProviderReadiness(definition);
          return readiness.ok ? 'verified' : 'temporarily_unavailable';
        }
        // Resolution alone is not verification. A successful refresh records
        // verified health; an unexpired stored token stays unverified until use.
        const current = await providerAuthHealthSubject(definition, methodId, source.kind !== 'environment');
        return current && current.key !== subject.key ? (await readProviderHealth(current)).state : 'configured';
      },
    };
  }
  if (source.kind === 'oauth' && id === 'openai') {
    const credential = await AuthStorage.getOAuth('openai');
    if (!credential) return undefined;
    return {
      subject: oauthHealthSubject(id, credential),
      currentSubject: async () => {
        const current = await AuthStorage.getOAuth(id);
        return current ? oauthHealthSubject(id, current) : undefined;
      },
      verify: async () => {
        const access = await CodexAuth.access();
        if (!access) throw new Error('OAuth unavailable');
        const current = await AuthStorage.getOAuth(id);
        const currentSubject = current ? oauthHealthSubject(id, current) : undefined;
        if (!currentSubject) throw new Error('OAuth unavailable');
        // A custom transport is verified by actual requests, not the first-party catalog.
        if ((await getProviderPatch(id))?.baseURL) return 'configured';
        // Matches the authenticated catalog request used by the Codex client.
        // client_version is a catalog compatibility version, not AgentUse's version.
        const response = await fetchWithProviderHealth(currentSubject,
          'https://chatgpt.com/backend-api/codex/models?client_version=0.99.0', {
            headers: {
              authorization: `Bearer ${access.token}`,
              ...(access.accountId && { 'ChatGPT-Account-Id': access.accountId }),
            },
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Provider check failed');
        return 'verified';
      },
    };
  }
  const key = source.kind === 'environment' ? process.env[source.name] : (await AuthStorage.getApiKey(id))?.key;
  if (!key) return undefined;
  const patch = await getProviderPatch(id);
  const baseURL = patch?.baseURL ?? (id === 'openai' || id === 'anthropic' ? process.env[`${id.toUpperCase()}_BASE_URL`] : id === 'opencode-go' ? resolveOpenCodeGoBaseURL({}) : undefined);
  const subject = apiHealthSubject(id, key, baseURL);
  return {
    subject,
    verify: async () => {
      // Only documented authenticated, non-generating endpoints are probed.
      // A custom proxy may publish /models without authentication; do not
      // claim a verified key from that public response.
      const isOpenCodeGo = id === 'opencode-go'
        && baseURL?.replace(/\/+$/, '') === OPENCODE_GO_BASE_URL;
      if (baseURL && !isOpenCodeGo) return 'configured';
      // Go's model catalog is public. Its usage endpoint validates the key
      // and subscription without generating tokens or consuming model quota.
      const endpoint = isOpenCodeGo ? `${OPENCODE_GO_BASE_URL}/usage`
        : id === 'openai' ? 'https://api.openai.com/v1/models'
        : id === 'anthropic' ? 'https://api.anthropic.com/v1/models?limit=1'
          : id === 'openrouter' ? 'https://openrouter.ai/api/v1/key' : undefined;
      if (!endpoint) return 'configured';
      const response = await fetchWithProviderHealth(subject, endpoint, {
        headers: id === 'anthropic'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      // Consume the body without returning account/model details to Settings.
      await response.body?.cancel();
      if (!response.ok) throw new Error('Provider check failed');
      return 'verified';
    },
  };
}

/** Enrich rows with cached health; optionally settle only stale/forced checks. */
export async function applyConnectionHealth(
  row: ProviderAuthStatus,
  definitions: ProviderDefinition[],
  options: ProviderStatusOptions,
): Promise<ProviderAuthStatus> {
  const active = row.sources.find((source) => source.active);
  if (!active) {
    const plugin = definitions.find((provider) => provider.check);
    if (!plugin) {
      const definition = definitions[0];
      if (!definition) return row;
      return { ...row, health: await readProviderHealth(providerReadinessHealthSubject(definition)) };
    }
    const subject = providerReadinessHealthSubject(plugin);
    const cached = await readProviderHealth(subject);
    const needsCheck = providerHealthNeedsCheck(cached);
    let readiness = cached.readiness;
    let health = cached;
    if (options.readiness !== 'defer' && (!options.provider || options.provider === row.id)) {
      health = await verifyProviderHealth(subject, async () => {
        readiness = await checkProviderReadiness(plugin);
        const state = readiness.ok ? 'verified' : 'temporarily_unavailable';
        return state;
      }, Boolean(options.force));
      readiness = health.readiness ?? readiness;
    }
    return { ...row, health,
      configured: health.state === 'verified' || (health.state === 'configured' && row.configured),
      ...(readiness && { readiness }),
      ...(readiness && !readiness.ok && { actionRequired: describeReadinessFailure(plugin, readiness) }),
      ...(options.readiness === 'defer' && needsCheck && { checkPending: true }),
    };
  }

  // Keep source-specific results, so an invalid OAuth token never marks an
  // independent API key invalid. The row represents the selected source.
  const sources = await Promise.all(row.sources.map(async (source) => {
    const check = await sourceCheck(row.id, source, definitions);
    if (!check) return source;
    let health = await readProviderHealth(check.subject);
    if (source.active && options.readiness !== 'defer' && (!options.provider || options.provider === row.id)) {
      health = await verifyProviderHealth(check.subject, check.verify, options.force);
      const current = await check.currentSubject?.();
      if (current && current.key !== check.subject.key) health = await readProviderHealth(current);
    }
    return { ...source, health };
  }));
  const health = sources.find((source) => source.active)?.health;
  const configured = row.configured && health?.state !== 'reconnect_required';
  return { ...row, sources, configured, ...(health && { health }),
    ...(options.readiness === 'defer' && health && providerHealthNeedsCheck(health) && { checkPending: true }),
    ...(health?.state === 'reconnect_required' && { actionRequired: health.message }),
  };
}
