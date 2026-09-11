import { describe, test, expect } from 'bun:test';
import { agentBaseName, computeAgentId, stripAgentExtension } from '../src/utils/agent-id';

describe('stripAgentExtension', () => {
  test('removes a trailing .agentuse and keeps the rest of the path', () => {
    expect(stripAgentExtension('social/quotes/create.agentuse')).toBe('social/quotes/create');
  });

  test('is case-insensitive, matching how discovery finds files on disk', () => {
    expect(stripAgentExtension('AGENT.AGENTUSE')).toBe('AGENT');
    expect(stripAgentExtension('agent.AgentUse')).toBe('agent');
  });

  test('only strips the suffix, never a mid-path occurrence', () => {
    expect(stripAgentExtension('a.agentuse/b.md')).toBe('a.agentuse/b.md');
    expect(stripAgentExtension('deploy')).toBe('deploy');
  });
});

describe('agentBaseName', () => {
  test('returns the final segment without the extension', () => {
    expect(agentBaseName('social/quotes/create.agentuse')).toBe('create');
  });

  test('accepts backslash separators', () => {
    expect(agentBaseName('social\\quotes\\create.agentuse')).toBe('create');
  });

  test('is case-insensitive about the extension', () => {
    expect(agentBaseName('dir/AGENT.AGENTUSE')).toBe('AGENT');
  });

  test('leaves a bare name alone', () => {
    expect(agentBaseName('deploy')).toBe('deploy');
  });
});

describe('computeAgentId', () => {
  test('is the project-relative path without the extension', () => {
    expect(computeAgentId('/root/social/quotes/create.agentuse', '/root', 'fallback'))
      .toBe('social/quotes/create');
  });

  test('strips an uppercase extension too', () => {
    expect(computeAgentId('/root/CREATE.AGENTUSE', '/root', 'fallback')).toBe('CREATE');
  });

  test('falls back when either path is missing', () => {
    expect(computeAgentId(undefined, '/root', 'fallback')).toBe('fallback');
    expect(computeAgentId('/root/a.agentuse', undefined, 'fallback')).toBe('fallback');
  });
});
