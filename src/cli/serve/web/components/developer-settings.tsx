import { useEffect, useState } from 'preact/hooks';
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
  const [fixtures, setFixtures] = useState<SessionFixture[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('../fixtures/session-fixtures').then((mod) => {
      if (!cancelled) setFixtures(mod.buildSessionFixtures());
    });
    return () => { cancelled = true; };
  }, []);

  return (
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
  );
}
