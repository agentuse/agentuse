/**
 * The first-run sample is a real AgentUse session, but its agent definition is
 * intentionally kept in memory. That lets an empty project demonstrate the
 * run/session experience without leaving a tutorial file behind.
 */
export const ONBOARDING_AGENT_ID = 'getting-started';
export const ONBOARDING_AGENT_NAME = 'Project pulse demo';
export const ONBOARDING_MODEL = 'demo:onboarding';

export const ONBOARDING_AGENT_SOURCE = `---
name: ${ONBOARDING_AGENT_NAME}
model: ${ONBOARDING_MODEL}
description: A simulated first AgentUse run
---

Create a concise project pulse from the sample workspace activity.`;

export const FIRST_PROJECT_DEFAULT_NAME = 'my-agents';

/** Filesystem-safe, readable id for managed first projects. */
export function managedProjectSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function validateManagedProjectName(input: unknown): { name: string; slug: string } {
  if (typeof input !== 'string') throw new Error('Project name is required');
  const name = input.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Project name is required');
  if (name.length > 80) throw new Error('Project name must be 80 characters or fewer');
  const slug = managedProjectSlug(name);
  if (!slug) throw new Error('Project name must include at least one letter or number');
  return { name, slug };
}

export function managedProjectAbout(name: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: Your AgentUse agents\n---\n`;
}
