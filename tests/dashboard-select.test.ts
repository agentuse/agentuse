import { describe, expect, it } from 'bun:test';
import { findTypeaheadOption } from '../src/cli/serve/web/components/dashboard-select';

const options = [
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'terra', label: 'GPT Terra' },
  { value: 'flash', label: 'Gemini Flash' },
  { value: 'glm', label: 'GLM 5.1' },
];

describe('DashboardSelect typeahead', () => {
  it('finds prefix matches case-insensitively and wraps from the active option', () => {
    expect(findTypeaheadOption(options, 'g', 0)).toBe(1);
    expect(findTypeaheadOption(options, 'gem', 1)).toBe(2);
    expect(findTypeaheadOption(options, 'cl', 2)).toBe(0);
  });

  it('returns no match for blank or unknown prefixes', () => {
    expect(findTypeaheadOption(options, '', 0)).toBe(-1);
    expect(findTypeaheadOption(options, 'x', 0)).toBe(-1);
  });
});
