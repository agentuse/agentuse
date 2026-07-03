import { useRef } from 'preact/hooks';
import { usePushBell, type PushCategory } from '../hooks/use-push';

const CATEGORY_LABEL: Record<PushCategory, string> = {
  approvals: 'pending approvals',
  sessions: 'session completions',
};

function bellTitle(state: string, category: PushCategory): string {
  switch (state) {
    case 'on': return `Notifying this device about ${CATEGORY_LABEL[category]} — tap to turn off`;
    case 'denied': return 'Notifications are blocked for this site';
    case 'needs-install': return 'Install to your home screen to enable notifications';
    case 'busy': return 'Working…';
    default: return `Notify this device about ${CATEGORY_LABEL[category]}`;
  }
}

/**
 * Per-category notification bell for list-page headers. Renders nothing when
 * the browser has no push at all; on iOS Safari tabs (push needs the
 * installed app) and after a permission denial it explains itself in a
 * dialog instead of toggling.
 */
export function PushBell({ category }: { category: PushCategory }) {
  const { state, toggle } = usePushBell(category);
  const dialogRef = useRef<HTMLDialogElement>(null);

  if (state === 'unsupported') return null;

  const title = bellTitle(state, category);
  const onClick = () => {
    if (state === 'needs-install' || state === 'denied') dialogRef.current?.showModal();
    else toggle();
  };

  return (
    <>
      <button
        type="button"
        class="push-bell"
        data-state={state}
        title={title}
        aria-label={title}
        aria-pressed={state === 'on'}
        disabled={state === 'busy'}
        onClick={onClick}
      >
        <svg viewBox="0 0 16 16" fill={state === 'on' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2a4 4 0 0 0-4 4v2.5L2.8 10.9a.6.6 0 0 0 .5.9h9.4a.6.6 0 0 0 .5-.9L12 8.5V6a4 4 0 0 0-4-4Z" />
          <path d="M6.6 13.5a1.5 1.5 0 0 0 2.8 0" fill="none" />
          {state === 'denied' && <path d="M2.5 2.5l11 11" fill="none" />}
        </svg>
      </button>
      <dialog
        ref={dialogRef}
        class="push-bell-dialog"
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        <div class="dialog-head">
          <strong>{state === 'denied' ? 'Notifications blocked' : 'Install to enable notifications'}</strong>
          <button type="button" class="dialog-close" aria-label="Close" onClick={() => dialogRef.current?.close()}>×</button>
        </div>
        {state === 'denied' ? (
          <p class="dialog-description">
            This site's notifications were blocked, so the browser won't ask again.
            Re-enable them in your browser's site settings (on iOS: Settings → Notifications → AgentUse), then reload this page.
          </p>
        ) : (
          <p class="dialog-description">
            iOS only delivers notifications to web apps installed on the home screen.
            In Safari, tap <strong>Share</strong> → <strong>Add to Home Screen</strong>, open AgentUse from the new icon, and tap this bell again.
          </p>
        )}
      </dialog>
    </>
  );
}
