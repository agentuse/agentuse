import { describe, expect, it } from 'bun:test';
import { normalizeMetricValues } from '../src/shared/metric-values';

describe('normalizeMetricValues', () => {
  it('keeps a genuine amount alongside its item count', () => {
    expect(normalizeMetricValues({ count: 4, value: 11200, unit: 'usd' })).toEqual({
      count: 4,
      value: 11200,
      unit: 'usd',
    });
  });

  it('removes a value that merely repeats the item count', () => {
    expect(normalizeMetricValues({ count: 1, value: 1, unit: 'reply' })).toEqual({
      count: 1,
      value: null,
      unit: null,
    });
  });

  it('recognizes count-only sentinel variants in legacy records', () => {
    for (const unit of ['count', 'counts', 'count_only', 'count-only', 'COUNT ONLY']) {
      expect(normalizeMetricValues({ count: 3, value: 0, unit })).toEqual({
        count: 3,
        value: null,
        unit: null,
      });
    }
  });

  it('removes an unlabelled zero placeholder when a positive count exists', () => {
    expect(normalizeMetricValues({ count: 4, value: 0, unit: '' })).toEqual({
      count: 4,
      value: null,
      unit: null,
    });
  });

  it('discards an orphan unit when no finite value exists', () => {
    expect(normalizeMetricValues({ count: 2, value: null, unit: 'usd' })).toEqual({
      count: 2,
      value: null,
      unit: null,
    });
  });
});
