import { describe, expect, it } from 'bun:test';
import {
  grepCodeModeText,
  queryCodeModeJson,
} from '../src/session/code-mode-result-query';

describe('Code Mode result queries', () => {
  it('greps literal text with bounded line context', () => {
    const text = [
      'request one started',
      'request one timed out',
      'request one recovered',
      'request two TIMED OUT',
      'request two recovered',
    ].join('\n');

    expect(grepCodeModeText(text, {
      pattern: 'timed out',
      caseSensitive: false,
      limit: 1,
      contextLines: 1,
    })).toEqual({
      matches: [{
        line: 2,
        column: 13,
        excerpt: 'request one timed out',
        before: ['request one started'],
        after: ['request one recovered'],
      }],
      truncated: true,
    });
  });

  it('treats grep metacharacters as literal text', () => {
    expect(grepCodeModeText('ready.*\nready item', { pattern: 'ready.*' })).toEqual({
      matches: [{
        line: 1,
        column: 1,
        excerpt: 'ready.*',
        before: [],
        after: [],
      }],
      truncated: false,
    });
  });

  it('defaults literal grep to case-insensitive matching', () => {
    expect(grepCodeModeText('TOTAL COST: $31.16', { pattern: 'Total' })).toEqual({
      matches: [{
        line: 1,
        column: 1,
        excerpt: 'TOTAL COST: $31.16',
        before: [],
        after: [],
      }],
      truncated: false,
    });
  });

  it('runs bundled jq filters and preserves jq output-stream order', async () => {
    await expect(queryCodeModeJson({
      items: [
        { id: 'one', status: 'ready' },
        { id: 'two', status: 'done' },
        { id: 'three', status: 'ready' },
      ],
    }, '.items[] | select(.status == "ready") | .id')).resolves.toEqual({
      values: ['one', 'three'],
      truncated: false,
    });
  });

  it('bounds jq output streams without loading the whole stream', async () => {
    await expect(queryCodeModeJson([1, 2, 3, 4], '.[]', { limit: 2 })).resolves.toEqual({
      values: [1, 2],
      truncated: true,
    });
  });

  it('rejects jq environment and module access before starting jq', async () => {
    await expect(queryCodeModeJson({}, 'env')).rejects.toThrow('RESULT_JQ_UNSAFE');
    await expect(queryCodeModeJson({}, '$ENV.PATH')).rejects.toThrow('RESULT_JQ_UNSAFE');
    await expect(queryCodeModeJson({}, 'include "private"; .')).rejects.toThrow('RESULT_JQ_UNSAFE');
    await expect(queryCodeModeJson({ env: 'ordinary field' }, '.env')).resolves.toEqual({
      values: ['ordinary field'],
      truncated: false,
    });
  });

  it('terminates a jq worker when the Code Mode invocation is aborted', async () => {
    const controller = new AbortController();
    const query = queryCodeModeJson(
      0,
      'reduce range(0; 1000000000) as $item (0; . + $item)',
      {},
      controller.signal
    );
    controller.abort(new Error('cancel jq query'));
    await expect(query).rejects.toThrow('cancel jq query');
  });
});
