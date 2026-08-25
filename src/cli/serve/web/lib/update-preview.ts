import type { InfoPayload } from './api';

const UPDATE_PREVIEW_SESSION_KEY = 'agentuse:preview-update';

type WritableSessionStorage = Pick<Storage, 'setItem'>;
type ConsumableSessionStorage = Pick<Storage, 'getItem' | 'removeItem'>;

/** Debug controls are opt-in so normal users never see internal QA tools. */
export function debugSettingsEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}

/** Carry a one-shot preview request from Settings to the Home page. */
export function requestUpdatePreview(storage: WritableSessionStorage = sessionStorage): void {
  try { storage.setItem(UPDATE_PREVIEW_SESSION_KEY, '1'); } catch { /* preview is best-effort */ }
}

/** Read and immediately clear the preview so a later Home visit is normal. */
export function consumeUpdatePreview(storage: ConsumableSessionStorage = sessionStorage): boolean {
  try {
    const requested = storage.getItem(UPDATE_PREVIEW_SESSION_KEY) === '1';
    storage.removeItem(UPDATE_PREVIEW_SESSION_KEY);
    return requested;
  } catch {
    return false;
  }
}

/** Representative data for visual QA; it never enters the update-check cache. */
export function previewUpdate(currentVersion: string): NonNullable<InfoPayload['update']> {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(currentVersion);
  const latestVersion = match ? `${match[1]}.${Number(match[2]) + 1}.0` : '1.0.0';
  return {
    currentVersion,
    latestVersion,
    packageManager: 'npm',
    command: 'npm install -g agentuse@latest',
  };
}
