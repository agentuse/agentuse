import { describe, expect, test } from 'bun:test';
import { rankPaletteItems } from '../src/cli/serve/web/components/agent-palette';

describe('command palette search grouping', () => {
  test('keeps agents first and matching items in source-group order', () => {
    const results = rankPaletteItems([
      { key: 'agent:scout', group: 'Agents', title: 'Reddit Scout' },
      { key: 'session:reply', group: 'Sessions', title: 'Reddit Engage Reply' },
      { key: 'approval:reply', group: 'Needs you', title: 'Reddit Engage Reply', boost: 200 },
      { key: 'page:agents', group: 'Pages', title: 'Agents', search: 'reddit agents' },
    ], 'reddit');

    expect(results.map(({ item }) => item.group)).toEqual([
      'Agents',
      'Needs you',
      'Sessions',
      'Pages',
    ]);
  });

  test('still ranks the strongest match first inside a group', () => {
    const results = rankPaletteItems([
      { key: 'agent:answer', group: 'Agents', title: 'Answer Agent', search: 'reddit helper' },
      { key: 'agent:scout', group: 'Agents', title: 'Reddit Scout' },
    ], 'reddit');

    expect(results.map(({ item }) => item.key)).toEqual(['agent:scout', 'agent:answer']);
  });
});
