import { useEffect, useState } from 'preact/hooks';
import { useDeveloperDebug } from '../hooks/use-developer-debug';
import type { SessionFixture } from '../fixtures/session-fixtures';
import { FIXTURE_SESSION_PREFIX } from '../lib/dev';
import { SettingsGroup as Group, SettingsRow as Row } from './settings-layout';

/**
 * Settings > Developer, present in dev builds only (see lib/dev.ts). Links
 * to one canned session page per state of the "now" card, so a change to the
 * session page can be checked against every variant in a minute instead of
 * waiting for a real run to reach each one.
 */
export function DeveloperSettings() {
  const { showDeveloperDebug, setShowDeveloperDebug } = useDeveloperDebug();
  const [fixtures, setFixtures] = useState<SessionFixture[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('../fixtures/session-fixtures').then((mod) => {
      if (!cancelled) setFixtures(mod.buildSessionFixtures());
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Group title="Debug messages">
        <div class="settings-checks">
          <label class="settings-check">
            <input
              type="checkbox"
              role="switch"
              checked={showDeveloperDebug}
              onChange={(event) => setShowDeveloperDebug(event.currentTarget.checked)}
            />
            <span class="settings-check-text">
              <span>Show developer debug messages</span>
              <span class="settings-row-hint">Show extra diagnostics in the web UI, including prefix and all request hashes in session details. Saved for this browser.</span>
            </span>
          </label>
        </div>
      </Group>
      <Group title="Session page fixtures">
        <p class="settings-group-hint">
          Each link opens the real session page on canned data, one per state of the card at the top.
          Nothing is fetched from the daemon for these, so the side panels that need a real session stay empty.
        </p>
        {fixtures?.map((fixture) => (
          <Row key={fixture.id} label={fixture.label} hint={fixture.hint}>
            <a class="settings-item" href={`/sessions/${FIXTURE_SESSION_PREFIX}${fixture.id}`}>Open</a>
          </Row>
        ))}
      </Group>
    </>
  );
}
