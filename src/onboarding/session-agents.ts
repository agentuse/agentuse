import * as YAML from 'yaml';
import { parseProjectDiscoveryResponse, type ProjectDiscoveryResult } from '../agents/discover.js';

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAgentSource(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function buildProjectDiscoverySessionAgent(input: {
  model: string;
  projectName: string;
  inspectedFiles: number;
  safeViewRoot: string;
}): string {
  return renderAgentSource({
    name: 'onboarding-project-discovery',
    model: input.model,
    reasoning: 'minimal',
    description: 'Explore a sanitized project view and propose useful recurring agents',
    timeout: '2m',
    maxSteps: 20,
    tools: { filesystem: [{ path: input.safeViewRoot, permissions: ['read'] }] },
    skills: { auto: false },
    metadata: {
      internal: true,
      onboarding: 'project-discovery',
      projectName: input.projectName,
      inspectedFiles: input.inspectedFiles,
    },
  }, `## Goal

Explore the sanitized, read-only project view at ${input.safeViewRoot} and propose three recurring AgentUse agents that would create concrete value for ${input.projectName}. Use the filesystem list, search, and read tools to decide what matters; do not assume the file index alone contains enough evidence.

## Selection bar

- Return exactly three distinct suggestions ordered by likely usefulness.
- Ground every suggestion in one to three specific paths or signals you actually inspected.
- Prefer durable project-specific workflows: recurring decisions, health checks, drift detection, reporting, release readiness, or review work.
- Every first run must be read-only. Do not propose edits, commits, pushes, deployments, publishing, or messages to people.
- Do not invent integrations, providers, credentials, destinations, or capabilities not visible in the project.
- Choose a sensible daily or weekly five-field cron schedule.
- Each objective must state what to inspect, what judgment to make, and what concise result to return in the AgentUse session.

## Required delivery

- Submit the one-sentence project summary and exactly three final suggestions through submit_project_suggestions.
- Do not stream JSON or the suggestions as a normal assistant response and do not put them in report_complete.details.
- If submit_project_suggestions rejects the payload, correct the reported problem and call it again.
- Only after the submission is accepted, call report_complete with a short headline such as "Proposed three agents for ${xmlText(input.projectName)}" and omit details.`);
}

function stripRuntimeCompletionPrefix(value: string): string {
  return value.trim().replace(/^(?:✅\s*Complete:|⚠️\s*Incomplete:)\s*/u, '').trim();
}

export function parseProjectDiscoverySessionOutput(
  text: string,
  projectName: string,
  inspectedFiles: number,
): ProjectDiscoveryResult {
  const normalized = stripRuntimeCompletionPrefix(text);
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  const json = start >= 0 && end >= start ? normalized.slice(start, end + 1) : normalized;
  return parseProjectDiscoveryResponse(json, projectName, inspectedFiles);
}

export function buildAgentCreatorSessionAgent(input: {
  model: string;
  safeViewRoot: string;
  creatorSkill: string;
  requestedName: string;
  description: string;
  objective: string;
  schedule: string;
  availableModels: readonly string[];
}): string {
  const availableModels = [...new Set(input.availableModels)];
  return renderAgentSource({
    name: 'onboarding-agent-creator',
    model: input.model,
    reasoning: 'minimal',
    description: 'Turn a reviewed project suggestion into a production AgentUse agent',
    timeout: '5m',
    maxSteps: 12,
    tools: { filesystem: [{ path: input.safeViewRoot, permissions: ['read'] }] },
    skills: { auto: false },
    metadata: {
      internal: true,
      onboarding: 'agent-creator',
      requestedName: input.requestedName,
      requestedSchedule: input.schedule,
      availableModels,
    },
  }, `Apply the complete, version-matched AgentUse Creator skill below. Produce one parser-valid production .agentuse file for the reviewed suggestion. You may inspect the sanitized project view at ${input.safeViewRoot} when that improves the instructions.

<creator_skill>
${input.creatorSkill.trim()}
</creator_skill>

<reviewed_suggestion>
<name>${xmlText(input.requestedName)}</name>
<description>${xmlText(input.description)}</description>
<schedule>${xmlText(input.schedule)}</schedule>
<objective>${xmlText(input.objective)}</objective>
</reviewed_suggestion>

<available_runtime_models>
${availableModels.map((model) => `- ${xmlText(model)}`).join('\n')}
</available_runtime_models>

Final delivery contract:

- Submit the complete raw .agentuse file through submit_agent_source. Do not stream it as a normal assistant message and do not put it in report_complete.details.
- If submit_agent_source rejects the draft, use its validation error to correct the source and submit it again.
- Only after submit_agent_source accepts the file, call report_complete with a short one-line headline such as "Created ${xmlText(input.requestedName)}" and omit details.

Source constraints:

- Preserve the reviewed name and schedule exactly.
- Choose the runtime model independently from the model authoring this file, copying one value byte-for-byte from available_runtime_models.
- Keep the agent read-only on its first run. Declare only the project filesystem read capability it needs; do not add bash, channels, approval gates, external destinations, trusted skills, or speculative integrations.
- When filesystem access is needed, tools.filesystem must be an array with one item shaped { path: "\${root}", permissions: ["read"] }. Never put a read/write/edit mapping under tools.filesystem.
- Keep concrete, verified project paths that make the recurring work useful.
- The body must be a concise recurring prompt with the outcome, inputs to inspect, judgment to perform, deliverable, and material boundaries.`);
}
