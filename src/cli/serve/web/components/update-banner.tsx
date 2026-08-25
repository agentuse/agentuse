import { useState } from 'preact/hooks';
import type { InfoPayload } from '../lib/api';

type UpdateInfo = NonNullable<InfoPayload['update']>;
const DISMISSED_VERSION_KEY = 'agentuse:update-dismissed-version';

export function UpdateBanner(props: { update: UpdateInfo; persistDismissal?: boolean }) {
  const { update } = props;
  const persistDismissal = props.persistDismissal !== false;
  const [dismissed, setDismissed] = useState(() => {
    if (!persistDismissal) return false;
    try {
      return typeof localStorage !== 'undefined'
        && localStorage.getItem(DISMISSED_VERSION_KEY) === update.latestVersion;
    } catch {
      return false;
    }
  });
  const [copied, setCopied] = useState(false);
  if (dismissed) return null;

  const dismiss = () => {
    if (persistDismissal) {
      try { localStorage.setItem(DISMISSED_VERSION_KEY, update.latestVersion); } catch { /* tab-only dismissal */ }
    }
    setDismissed(true);
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
