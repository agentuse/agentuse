import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Topbar } from '../components/topbar';
import { ThemeToggle } from '../components/theme-toggle';
import { useTitle } from '../hooks/use-title';
import { pageTitle, brandName } from '../lib/brand';
import { useSessionListView } from '../hooks/use-session-list-view';
import { HOME_SECTIONS, useHomeSections } from '../hooks/use-home-sections';
import { usePushBell } from '../hooks/use-push';
import { debugSettingsEnabled, requestUpdatePreview } from '../lib/update-preview';

function Group(props: { title: string; children: ComponentChildren }) {
  return (
    <section class="settings-group">
      <h2 class="settings-group-title">{props.title}</h2>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; hint?: string; children?: ComponentChildren }) {
  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-label">{props.label}</div>
        {props.hint && <div class="settings-row-hint">{props.hint}</div>}
      </div>
      {props.children && <div class="settings-row-control">{props.children}</div>}
    </div>
  );
}

/** Two per-category checkboxes when push can work here; otherwise a single
 *  explanation of what stands in the way (mirrors the push-bell dialogs). */
function NotificationsGroup() {
  const approvals = usePushBell('approvals');
  const sessions = usePushBell('sessions');
  const rows = [
    { label: 'Pending approvals', hint: 'A run is waiting on your decision.', bell: approvals },
    { label: 'Session completions', hint: 'A run finished, with its outcome.', bell: sessions },
  ];

  // Support-level states (unsupported / needs-install / denied) are properties
  // of the browser, not the category, so either bell speaks for both.
  const blockedHint =
    approvals.state === 'unsupported'
      ? 'Push notifications are not available in this browser.'
      : approvals.state === 'needs-install'
        ? `iOS only delivers notifications to web apps installed on the home screen. In Safari, tap Share → Add to Home Screen, open ${brandName()} from the new icon, then come back here.`
        : approvals.state === 'denied'
          ? `This site's notifications were blocked, so the browser won't ask again. Re-enable them in your browser's site settings (on iOS: Settings → Notifications → ${brandName()}), then reload this page.`
          : null;

  return (
    <Group title="Notifications">
      {blockedHint
        ? <p class="settings-group-hint">{blockedHint}</p>
        : (
          <>
            <p class="settings-group-hint">Push alerts to this device. Each device keeps its own choices.</p>
            <div class="settings-checks">
              {rows.map((row) => (
                <label class="settings-check" key={row.label}>
                  <input
                    type="checkbox"
                    checked={row.bell.state === 'on'}
                    disabled={row.bell.state !== 'on' && row.bell.state !== 'off'}
                    onChange={row.bell.toggle}
                  />
                  <span class="settings-check-text">
                    <span>{row.label}</span>
                    <span class="settings-row-hint">{row.hint}</span>
                    {row.bell.error && <span class="settings-check-error" role="alert">{row.bell.error}</span>}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
    </Group>
  );
}

export default function Settings() {
  useTitle(pageTitle('Settings'));
  const showDebug = debugSettingsEnabled(location.search);
  const sessionList = useSessionListView();
  const homeSections = useHomeSections();
  const [clearing, setClearing] = useState(false);

  // Purge the service worker's Cache Storage, then reload. The reliable recovery
  // path for an installed iOS PWA that keeps serving a stale build even across a
  // normal reload. Push subscriptions live on the SW registration (not in Cache
  // Storage), so notifications survive.
  const clearCacheAndReload = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
    } catch {
      // best-effort — reload regardless
    }
    location.reload();
  };

  return (
    <div class="page-settings">
      <Topbar />
      <main>
        <header>
          <div class="eyebrow">preferences</div>
          <h1>Settings</h1>
          <p class="lede">Stored in this browser, per device.</p>
        </header>

        <Group title="Appearance">
          <Row label="Theme" hint="Light, dark, or follow the system.">
            <ThemeToggle />
          </Row>
        </Group>

        <Group title="Home page">
          <p class="settings-group-hint">Sections shown on the home page.</p>
          <div class="settings-checks">
            {HOME_SECTIONS.map((section) => (
              <label class="settings-check" key={section.id}>
                <input
                  type="checkbox"
                  checked={homeSections.isVisible(section.id)}
                  onChange={() => homeSections.toggle(section.id)}
                />
                {section.label}
              </label>
            ))}
          </div>
        </Group>

        <Group title="Sessions">
          <Row label="List style" hint="Summary groups runs by agent; Feed lists every run in order.">
            <span class="session-view-toggle" role="group" aria-label="Session list view">
              <button
                type="button"
                aria-pressed={sessionList.view === 'summary'}
                onClick={() => sessionList.setView('summary')}
              >Summary</button>
              <button
                type="button"
                aria-pressed={sessionList.view === 'feed'}
                onClick={() => sessionList.setView('feed')}
              >Feed</button>
            </span>
          </Row>
        </Group>

        <NotificationsGroup />

        <Group title="Maintenance">
          <Row label="Reload app" hint="Fetch and switch to the latest build.">
            <button type="button" class="settings-item" onClick={() => location.reload()}>
              Reload
            </button>
          </Row>
          <Row label="Clear cache & reload" hint="Recovery for a stale app: purge the cached copy, then reload. Notification settings survive.">
            <button
              type="button"
              class={`settings-item${clearing ? ' btn-busy' : ''}`}
              onClick={clearCacheAndReload}
              disabled={clearing}
              aria-busy={clearing}
            >
              {clearing ? <><span class="btn-spinner" aria-hidden="true" />Clearing…</> : 'Clear cache'}
            </button>
          </Row>
        </Group>

        {showDebug && (
          <Group title="Debug">
            <Row label="Update notification" hint="Preview the update banner on Home without contacting npm or changing the update cache.">
              <button
                type="button"
                class="settings-item"
                onClick={() => {
                  requestUpdatePreview();
                  location.assign('/');
                }}
              >
                Preview
              </button>
            </Row>
          </Group>
        )}
      </main>
    </div>
  );
}
