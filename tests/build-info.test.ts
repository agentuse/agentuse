import { describe, expect, test } from 'bun:test';
import { formatDevVersion, formatVersionLine, parseDescribe } from '../src/utils/build-info';

describe('build-info', () => {
  test('parses git describe --long output', () => {
    expect(parseDescribe('v0.20.0-22-gcf0ce07\n')).toEqual({ commit: 'cf0ce07', commitsSinceTag: 22, dirty: false });
    expect(parseDescribe('v0.20.0-0-gabc1234-dirty')).toEqual({ commit: 'abc1234', commitsSinceTag: 0, dirty: true });
    expect(parseDescribe('abc1234')).toBeNull();
  });

  test('formats a semver-sortable dev version', () => {
    expect(formatDevVersion('0.20.0', parseDescribe('v0.20.0-22-gcf0ce07'))).toBe('0.20.0-dev.22+cf0ce07');
    expect(formatDevVersion('0.20.0', parseDescribe('v0.20.0-3-gabc1234-dirty'))).toBe('0.20.0-dev.3+abc1234.dirty');
    expect(formatDevVersion('0.20.0', null)).toBe('0.20.0-dev');
  });

  test('--version line explains the dev suffix', () => {
    expect(formatVersionLine({ version: '0.20.0', baseVersion: '0.20.0', dev: false })).toBe('0.20.0');
    expect(formatVersionLine({
      version: '0.20.0-dev.22+cf0ce07', baseVersion: '0.20.0', dev: true, commit: 'cf0ce07', commitsSinceTag: 22, dirty: true,
    })).toBe('0.20.0-dev.22+cf0ce07 (local, 22 commits after v0.20.0, uncommitted changes)');
  });
});
