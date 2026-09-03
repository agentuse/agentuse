import { describe, expect, it } from 'bun:test';
import {
  findTypeaheadOption,
  getDashboardSelectMenuPosition,
} from '../src/cli/serve/web/components/dashboard-select';

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

describe('DashboardSelect menu placement', () => {
  it('opens below when there is enough room', () => {
    expect(getDashboardSelectMenuPosition(
      { left: 40, top: 100, bottom: 140, width: 300 },
      800,
      700,
    )).toEqual({ left: 40, top: 145, width: 300, maxHeight: 320 });
  });

  it('opens above and limits its height in a short viewport', () => {
    expect(getDashboardSelectMenuPosition(
      { left: 44, top: 202, bottom: 242, width: 520 },
      600,
      400,
    )).toEqual({ left: 44, bottom: 203, width: 520, maxHeight: 189 });
  });

  it('keeps the menu within narrow viewport edges', () => {
    expect(getDashboardSelectMenuPosition(
      { left: -20, top: 20, bottom: 60, width: 500 },
      360,
      640,
    )).toEqual({ left: 8, top: 65, width: 344, maxHeight: 320 });
  });
});
