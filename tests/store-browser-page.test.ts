import { describe, expect, it } from 'bun:test';
import { __testing } from '../src/cli/serve';

describe('store browser page', () => {
  it('renders sortable store headers with updated as the default sort', () => {
    const html = __testing.renderStoresIndexPage({
      stores: [
        {
          projectId: 'project-1',
          name: 'alpha',
          itemCount: 2,
          updatedAt: 1710000000000,
          types: ['task'],
          statuses: ['open']
        },
        {
          projectId: 'project-1',
          name: 'beta',
          itemCount: 1,
          types: [],
          statuses: []
        },
        {
          projectId: 'project-2',
          name: 'gamma',
          itemCount: 3,
          updatedAt: 1720000000000,
          types: ['note'],
          statuses: ['done']
        }
      ],
      errors: [],
      multiProject: false
    });

    expect(html).toContain('data-sortable="true" data-default-sort-key="updated" data-default-sort-direction="desc"');
    expect(html).toContain('data-sort-key="store"');
    expect(html).toContain('data-sort-key="items" data-sort-type="number"');
    expect(html).toContain('data-sort-key="updated" data-sort-type="number"');
    expect(html).toContain('<button class="sort-header" type="button">Updated');
    expect(html).toContain('data-sort-updated="1710000000000"');
    expect(html).toContain('data-sort-updated="0"');
    expect(html.indexOf('href="/stores/gamma"')).toBeLessThan(html.indexOf('href="/stores/alpha"'));
    expect(html.indexOf('href="/stores/alpha"')).toBeLessThan(html.indexOf('href="/stores/beta"'));
    expect(html).toContain("header.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending')");
    expect(html).toContain("if (defaultHeader) sortBy(defaultHeader, table.getAttribute('data-default-sort-direction') || 'desc')");
  });
});
