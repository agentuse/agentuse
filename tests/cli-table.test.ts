import { describe, test, expect } from 'bun:test';
import chalk from 'chalk';
import {
  cliTableWidths,
  formatCliRow,
  renderCliTable,
  renderCliTableHeader,
} from '../src/utils/cli-table';

const plain = (text: string) => text;

describe('cliTableWidths', () => {
  test('takes the widest of the header and every cell', () => {
    expect(cliTableWidths(['AGENT', 'MODEL'], [['a', 'sonnet'], ['longer-agent', 'x']]))
      .toEqual(['longer-agent'.length, 'sonnet'.length]);
  });

  test('falls back to the header width when there are no rows', () => {
    expect(cliTableWidths(['PID', 'PORT'], [])).toEqual([3, 4]);
  });
});

describe('formatCliRow', () => {
  test('left-pads to the column width and joins with two spaces by default', () => {
    expect(formatCliRow(['a', 'b'], [3, 3])).toBe('a    b  ');
  });

  test('honours a custom gap and right alignment', () => {
    expect(formatCliRow(['a', 'b'], [3, 3], { gap: ' ', align: ['left', 'right'] }))
      .toBe('a     b');
  });

  test("'none' passes a pre-padded, pre-colored cell through untouched", () => {
    const cell = chalk.green('42 ');
    expect(formatCliRow(['a', cell], [3, 4], { gap: ' ', align: ['left', 'none'] }))
      .toBe(`a   ${cell}`);
  });

  test('treats a missing cell as empty', () => {
    expect(formatCliRow(['a'], [2, 2])).toBe('a ' + '  ' + '  ');
  });
});

describe('renderCliTableHeader', () => {
  test('rule spans the columns plus the gaps between them', () => {
    const [header, rule] = renderCliTableHeader(['A', 'B'], [4, 6], { dim: plain });
    expect(header).toBe('A     B     ');
    expect(rule).toBe('─'.repeat(4 + 6 + 2));
  });

  test('separatorLength overrides the computed rule width', () => {
    const [, rule] = renderCliTableHeader(['A', 'B'], [4, 6], { dim: plain, separatorLength: 3 });
    expect(rule).toBe('───');
  });
});

describe('renderCliTable', () => {
  test('derives widths from content when none are given', () => {
    const out = renderCliTable(
      ['AGENT', 'MODEL'],
      [['deploy', 'sonnet'], ['a', 'opus']],
      { dim: plain },
    );
    expect(out.split('\n')).toEqual([
      'AGENT   MODEL ',
      '─'.repeat(6 + 6 + 2),
      'deploy  sonnet',
      'a       opus  ',
    ]);
  });

  test('fixed widths win over the content', () => {
    const out = renderCliTable(['A'], [['longer-than-width']], { widths: [2], dim: plain });
    expect(out.split('\n')).toEqual(['A ', '──', 'longer-than-width']);
  });
});
