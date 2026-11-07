import { describe, expect, it } from 'bun:test';
import { validateAuthoredAgentSource } from '../src/agents/author';
import { customProviderProbes } from '../src/auth/provider-setup';
import { cloudDashboardLink } from '../src/cloud/relay';

const connection = { url: 'https://cloud.example.com', machineId: 'machine-1' };
const agent = (top: string) => `---\n${top}\n---\nSay hello.\n`;

describe('links for someone who came through Cloud', () => {
  it('moves a review link to Cloud and opens it on this computer', () => {
    expect(cloudDashboardLink('http://127.0.0.1:12233/projects/p/changesets/c', connection))
      .toBe('https://cloud.example.com/projects/p/changesets/c?m=machine-1');
  });
  it('leaves the session token behind', () => {
    const link = new URL(cloudDashboardLink('http://127.0.0.1:12233/sessions/s?token=secret', connection));
    expect(link.searchParams.get('token')).toBeNull();
    expect(link.searchParams.get('m')).toBe('machine-1');
  });
});

describe('agent file errors', () => {
  const check = (source: string, models: string[]) => () => validateAuthoredAgentSource(source, models);
  it('says what the file is missing, without blaming a model', () => {
    expect(check(agent('description: d\nmodel: a:b'), ['a:b'])).toThrow('This agent file has no name');
  });
  it('says plainly when no AI is set up', () => {
    expect(check(agent('name: n\ndescription: d\nmodel: a:b'), [])).toThrow('No AI is set up on this computer yet');
  });
  it('lists what is available when the model is not', () => {
    expect(check(agent('name: n\ndescription: d\nmodel: a:b'), ['a:c'])).toThrow('Available: a:c');
  });
});

describe('custom AI model check', () => {
  it('tries named models, then current ones, before a list of retired ones', () => {
    const listed = ['old-1', 'old-2', 'old-3', 'claude-haiku-5-5'];
    expect(customProviderProbes([], listed)[0]).toBe('claude-haiku-5-5');
    expect(customProviderProbes(['mine'], ['mine', ...listed]).slice(0, 2)).toEqual(['mine', 'claude-haiku-5-5']);
  });
});
