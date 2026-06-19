import { describe, expect, it } from 'bun:test';
import { getModelInfo } from '../src/utils/models-api';

describe('getModelInfo', () => {
  it('uses provider input limit for active-context accounting when available', async () => {
    const info = await getModelInfo('openai:gpt-5.5');

    expect(info.contextLimit).toBe(922_000);
    expect(info.totalContextLimit).toBe(1_050_000);
    expect(info.outputLimit).toBe(128_000);
  });
});
