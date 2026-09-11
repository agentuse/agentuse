import { describe, expect, it } from 'bun:test';
import { agentDetailHref, agentDetailViewState, projectDiscoveryHref } from '../src/cli/serve/web/lib/links';

describe('agent detail links', () => {
  it('preserves the existing plain detail link by default', () => {
    expect(agentDetailHref('my project', 'agents/daily brief.agentuse'))
      .toBe('/agents/my%20project/agents/daily%20brief.agentuse');
  });

  it('links the first onboarding agent to Source with the Run agent spotlight', () => {
    const href = agentDetailHref('my-agents', 'agents/daily.agentuse', {
      tab: 'source',
      spotlightRun: true,
    });
    expect(href).toBe('/agents/my-agents/agents/daily.agentuse?tab=source&onboarding=first-agent');
    expect(agentDetailViewState('?tab=source&onboarding=first-agent')).toEqual({
      tab: 'source',
      tutorialStep: 'run',
      metric: undefined,
    });
    expect(agentDetailViewState('?tab=source&onboarding=first-agent-schedule')).toEqual({
      tab: 'source',
      tutorialStep: 'schedule',
      metric: undefined,
    });
  });

  it('opens later created agents on Source without an onboarding spotlight', () => {
    const href = agentDetailHref('my-agents', 'agents/daily.agentuse', { tab: 'source' });
    expect(href).toBe('/agents/my-agents/agents/daily.agentuse?tab=source');
    expect(agentDetailViewState('?tab=source')).toEqual({ tab: 'source', tutorialStep: null, metric: undefined });
  });

  it('opens the Results tab from a deep link', () => {
    expect(agentDetailViewState('?tab=results')).toEqual({ tab: 'results', tutorialStep: null, metric: undefined });
  });

  it('falls back to Recent jobs for an unknown tab', () => {
    expect(agentDetailViewState('?tab=unknown')).toEqual({ tab: 'jobs', tutorialStep: null, metric: undefined });
  });

  it('carries a Home results tile into the jobs tab as a metric filter', () => {
    const href = agentDetailHref('my-agents', 'agents/daily.agentuse', { tab: 'jobs', metric: 'linkedin_posts_scheduled' });
    expect(href).toBe('/agents/my-agents/agents/daily.agentuse?tab=jobs&metric=linkedin_posts_scheduled');
    expect(agentDetailViewState('?tab=jobs&metric=linkedin_posts_scheduled')).toEqual({
      tab: 'jobs',
      tutorialStep: null,
      metric: 'linkedin_posts_scheduled',
    });
    expect(agentDetailViewState('?metric=%20').metric).toBeUndefined();
  });
});

describe('project discovery links', () => {
  it('persists the selected project and optional provider step in the URL', () => {
    expect(projectDiscoveryHref('my project')).toBe('/onboarding?project=my+project');
    expect(projectDiscoveryHref('my project', { connectProvider: true }))
      .toBe('/onboarding?project=my+project&provider=connect');
  });
});
