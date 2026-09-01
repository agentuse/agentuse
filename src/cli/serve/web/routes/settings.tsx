import { useEffect, useState } from 'preact/hooks';
import { ThemeToggle } from '../components/theme-toggle';
import { useTitle } from '../hooks/use-title';
import { pageTitle, brandName } from '../lib/brand';
import { useSessionListView } from '../hooks/use-session-list-view';
import { HOME_SECTIONS, useHomeSections } from '../hooks/use-home-sections';
import { usePushBell } from '../hooks/use-push';
import { debugSettingsEnabled, requestUpdatePreview } from '../lib/update-preview';
import { ProviderSettingsGroup } from '../components/provider-setup';
import { ProjectsSettingsGroup, RestartOnboardingGroup } from '../components/project-settings';
import { SettingsGroup as Group, SettingsRow as Row } from '../components/settings-layout';

/** Two per-category checkboxes when push can work here; otherwise a single
 *  explanation of what stands in the way (mirrors the push-bell dialogs). */
function BrowserNotificationsGroup() {
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
    <Group title="Browser notifications">
      {blockedHint
        ? <p class="settings-group-hint">{blockedHint}</p>
        : (
          <>
            <p class="settings-group-hint">Alerts for this browser. Other browsers keep their own choices.</p>
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

type SettingsTab = 'general' | 'projects' | 'providers';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'projects', label: 'Projects' },
  { id: 'providers', label: 'Providers' },
];

function settingsTabFromSearch(search: string): SettingsTab {
  const candidate = new URLSearchParams(search).get('tab');
  return candidate === 'projects' || candidate === 'providers' ? candidate : 'general';
}

export default function Settings() {
  useTitle(pageTitle('Dashboard preferences'));
  const showDebug = debugSettingsEnabled(location.search);
  const isDesktop = typeof window !== 'undefined' && Boolean(window.agentuseDesktop);
  const sessionList = useSessionListView();
  const homeSections = useHomeSections();
  const [clearing, setClearing] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => settingsTabFromSearch(location.search));

  useEffect(() => {
    const syncTab = () => setActiveTab(settingsTabFromSearch(location.search));
    addEventListener('popstate', syncTab);
    return () => removeEventListener('popstate', syncTab);
  }, []);

  const selectTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    const url = new URL(location.href);
    if (tab === 'general') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const moveTabFocus = (event: KeyboardEvent, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % SETTINGS_TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = SETTINGS_TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = SETTINGS_TABS[nextIndex]!;
    selectTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

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
      <main>
        <header>
          <div class="eyebrow">dashboard</div>
          <h1>Settings</h1>
          <p class="lede">{isDesktop
            ? 'Manage appearance, projects, and models on this Mac.'
            : 'Manage appearance, projects, and models.'}</p>
        </header>

        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              aria-controls={`settings-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => moveTabFocus(event, index)}
            >{tab.label}</button>
          ))}
        </div>

        <div class="settings-tab-panel" id={`settings-panel-${activeTab}`} role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
          {activeTab === 'providers' && <ProviderSettingsGroup />}
          {activeTab === 'projects' && <ProjectsSettingsGroup />}
          {activeTab === 'general' && (
            <>
              {isDesktop && (
                <Group title="AgentUse for Mac">
                  <Row label="App settings" hint="Server, launch at login, shortcut, CLI, native notifications, and logs.">
                    <button type="button" class="settings-item" onClick={() => void window.agentuseDesktop?.openSettings()}>
                      Open Mac Settings…
                    </button>
                  </Row>
                </Group>
              )}

              <RestartOnboardingGroup />

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
                    <button type="button" aria-pressed={sessionList.view === 'summary'} onClick={() => sessionList.setView('summary')}>Summary</button>
                    <button type="button" aria-pressed={sessionList.view === 'feed'} onClick={() => sessionList.setView('feed')}>Feed</button>
                  </span>
                </Row>
              </Group>

              {!isDesktop && <BrowserNotificationsGroup />}

              <Group title="Troubleshooting">
                <Row label="Reload Dashboard" hint="Fetch and switch to the latest build.">
                  <button type="button" class="settings-item" onClick={() => location.reload()}>Reload</button>
                </Row>
                {!isDesktop && (
                  <Row label="Clear cached files & reload" hint="Use if the Dashboard keeps showing an older version.">
                    <button type="button" class={`settings-item${clearing ? ' btn-busy' : ''}`} onClick={clearCacheAndReload} disabled={clearing} aria-busy={clearing}>
                      {clearing ? <><span class="btn-spinner" aria-hidden="true" />Clearing…</> : 'Clear cached files'}
                    </button>
                  </Row>
                )}
              </Group>

              {showDebug && (
                <Group title="Debug">
                  <Row label="Update notification" hint="Preview the update banner on Home without contacting npm or changing the update cache.">
                    <button type="button" class="settings-item" onClick={() => { requestUpdatePreview(); location.assign('/'); }}>Preview</button>
                  </Row>
                </Group>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
