import { useState } from 'preact/hooks';
import type { InfoPayload } from '../lib/api';

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
  const [copied, setCopied] = useState(false);
  if (isUpdateVersionDismissed(dismissedVersion, update.latestVersion)) return null;

  const dismiss = () => {
    if (persistDismissal) {
      try { localStorage.setItem(DISMISSED_VERSION_KEY, update.latestVersion); } catch { /* tab-only dismissal */ }
    }
    setDismissedVersion(update.latestVersion);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(update.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
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
        <button type="button" class="home-update-action" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy command'}</button>
        <button type="button" class="home-update-dismiss" aria-label={`Dismiss update ${update.latestVersion}`} title="Dismiss this release" onClick={dismiss}>×</button>
      </div>
    </aside>
  );
}
