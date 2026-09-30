import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { apiKeyWorkerEnv, readApiKey } from '../src/utils/session-token';

describe('API key handling', () => {
  const original = process.env.AGENTUSE_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENTUSE_API_KEY;
    else process.env.AGENTUSE_API_KEY = original;
  });

  it('takes the key out of the environment so child processes never inherit it', () => {
    process.env.AGENTUSE_API_KEY = 'operator-secret';
    expect(readApiKey()).toBe('operator-secret');
    expect(process.env.AGENTUSE_API_KEY).toBeUndefined();
    // What an agent's `env` in the bash tool would see.
    expect(execFileSync('/usr/bin/env', { env: process.env }).toString()).not.toContain('operator-secret');
    // Still available to the process that read it, and to the serve worker only.
    expect(readApiKey()).toBe('operator-secret');
    expect(apiKeyWorkerEnv()).toEqual({ AGENTUSE_API_KEY: 'operator-secret' });
  });

  it('treats an empty value as no key', () => {
    process.env.AGENTUSE_API_KEY = '';
    expect(readApiKey()).toBeUndefined();
    expect(apiKeyWorkerEnv()).toEqual({});
  });
});
