/**
 * Build prompts published on agentuse.io/ai-agents/workflows. A workflow page
 * links here as /agents?new=1&workflow=<slug>; the prompt is fetched by slug
 * because the briefs run to ~12KB URL-encoded, past what custom-scheme and
 * Windows shell handoffs reliably carry.
 */
export const SITE_WORKFLOWS_API = 'https://agentuse.io/api/ai-agents/workflows';

export interface SiteWorkflow {
  slug: string;
  title: string;
  description: string;
  url: string;
  prompt: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function fetchSiteWorkflow(slug: string): Promise<SiteWorkflow> {
  if (!SLUG.test(slug)) throw new Error('That workflow link is not valid.');
  const res = await fetch(`${SITE_WORKFLOWS_API}/${slug}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error('That workflow is no longer published on agentuse.io.');
  if (!res.ok) throw new Error(`agentuse.io answered ${res.status} while loading the workflow.`);
  const body = (await res.json()) as Partial<SiteWorkflow>;
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('The workflow has no build prompt.');
  return {
    slug: body.slug ?? slug,
    title: body.title ?? slug,
    description: body.description ?? '',
    url: body.url ?? `https://agentuse.io/ai-agents/workflows/${slug}`,
    prompt: body.prompt,
  };
}
