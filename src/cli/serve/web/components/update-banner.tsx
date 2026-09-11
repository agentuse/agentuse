import { useState } from 'preact/hooks';
import type { InfoPayload } from '../lib/api';
import { CopyButton } from './copy-button';

type UpdateInfo = NonNullable<InfoPayload['update']>;
const DISMISSED_VERSION_KEY = 'agentuse:update-dismissed-version';

export function isUpdateVersionDismissed(dismissedVersion: string | null, latestVersion: string): boolean {
  return dismissedVersion === latestVersion;
}

export function UpdateBanner(props: { update: UpdateInfo; persistDismissal?: boolean }) {
  const { update } = props;
  const persistDismissal = props.persistDismissal !== false;
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    if (!persistDismissal) return null;
    try {
      return typeof localStorage !== 'undefined'
        ? localStorage.getItem(DISMISSED_VERSION_KEY)
        : null;
    } catch {
      return null;
    }
  });
  if (isUpdateVersionDismissed(dismissedVersion, update.latestVersion)) return null;

  const dismiss = () => {
    if (persistDismissal) {
      try { localStorage.setItem(DISMISSED_VERSION_KEY, update.latestVersion); } catch { /* tab-only dismissal */ }
    }
    setDismissedVersion(update.latestVersion);
  };

  return (
    <aside class="home-update-banner" role="status" aria-label="AgentUse update available">
      <div class="home-update-copy">
        <strong>AgentUse {update.latestVersion} is available</strong>
        <div class="home-update-details">
          <span>Installed {update.currentVersion}</span>
          <span class="home-update-separator" aria-hidden="true">·</span>
          <code>{update.command}</code>
        </div>
      </div>
      <div class="home-update-actions">
        <CopyButton text={update.command} label="the update command" variant="button" class="home-update-action">Copy command</CopyButton>
        <button type="button" class="home-update-dismiss" aria-label={`Dismiss update ${update.latestVersion}`} title="Dismiss this release" onClick={dismiss}>×</button>
      </div>
    </aside>
  );
}
