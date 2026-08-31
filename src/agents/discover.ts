import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { glob } from 'glob';
import { completeText, type CompleteTextOptions } from '../complete-text.js';
import { formatScheduleHuman, parseScheduleExpression } from '../scheduler/parser.js';
import { helperSystemPrompt } from '../utils/anthropic.js';
import { validateAgentName } from './create.js';

const MAX_CONTEXT_CHARS = 48_000;
const MAX_FILE_CHARS = 12_000;
const MAX_FILES = 160;
const CONTEXT_FILES = [
  'README.md', 'README.mdx', 'package.json', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'Gemfile', 'Makefile', 'AGENTS.md', 'CLAUDE.md',
] as const;
const IGNORED = [
  '.git/**', 'node_modules/**', 'vendor/**', 'dist/**', 'build/**', 'coverage/**',
  '.next/**', '.turbo/**', 'tmp/**', '.env', '.env.*', '**/*.pem', '**/*.key',
  '**/*secret*', '**/*credential*',
];

export interface ProjectAgentSuggestion {
  id: string;
  name: string;
  description: string;
  objective: string;
  schedule: string;
  scheduleHuman: string;
  evidence: string[];
}

export interface ProjectDiscoveryResult {
  projectName: string;
  summary: string;
  inspectedFiles: number;
  suggestions: ProjectAgentSuggestion[];
}

type CompleteDiscoveryText = (model: string, options: CompleteTextOptions) => Promise<string>;

function stripFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The project scan returned an invalid ${label}`);
  const text = value.trim();
  if (text.length > max) throw new Error(`The project scan returned a ${label} that is too long`);
  return text;
}

export function parseProjectDiscoveryResponse(response: string, projectName: string, inspectedFiles: number): ProjectDiscoveryResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(response));
  } catch {
    throw new Error('The model did not return valid project suggestions');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The model returned invalid project suggestions');
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.suggestions) || record.suggestions.length !== 3) {
    throw new Error('The model must return exactly three project suggestions');
  }
  const suggestions = record.suggestions.map((entry, index): ProjectAgentSuggestion => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('The model returned an invalid agent suggestion');
    const value = entry as Record<string, unknown>;
    const name = validateAgentName(cleanText(value.name, 'agent name', 120));
    const description = cleanText(value.description, 'description', 240);
    const objective = cleanText(value.objective, 'objective', 8_000);
    const schedule = cleanText(value.schedule, 'schedule', 100);
    parseScheduleExpression(schedule);
    if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 3) {
      throw new Error('Each project suggestion must include one to three evidence points');
    }
    const evidence = value.evidence.map((item) => cleanText(item, 'evidence', 180));
    return {
      id: `suggestion-${index + 1}`,
      name,
      description,
      objective,
      schedule,
      scheduleHuman: formatScheduleHuman(schedule),
      evidence,
    };
  });
  return {
    projectName,
    summary: cleanText(record.summary, 'project summary', 320),
    inspectedFiles,
    suggestions,
  };
}

export async function collectProjectDiscoveryContext(projectRoot: string): Promise<{ projectName: string; inspectedFiles: number; context: string }> {
  const files = (await glob('**/*', {
    cwd: projectRoot,
    nodir: true,
    dot: true,
    maxDepth: 4,
    ignore: IGNORED,
  })).sort().slice(0, MAX_FILES);
  const manifestPaths = [...new Set([
    ...CONTEXT_FILES.filter((file) => files.includes(file)),
    ...files.filter((file) => /(^|\/)(README|ABOUT)\.(md|mdx)$/i.test(file)).slice(0, 4),
    ...files.filter((file) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(file)).slice(0, 6),
  ])];
  const sections = [`Project: ${basename(projectRoot)}`, `File map (limited to ${MAX_FILES} files, secrets and generated directories excluded):\n${files.join('\n')}`];
  let used = sections.join('\n\n').length;
  for (const path of manifestPaths) {
    if (used >= MAX_CONTEXT_CHARS) break;
    try {
      const body = (await readFile(join(projectRoot, path), 'utf8')).slice(0, MAX_FILE_CHARS);
      const remaining = MAX_CONTEXT_CHARS - used;
      const section = `\n\n--- ${path} ---\n${body}`.slice(0, remaining);
      sections.push(section);
      used += section.length;
    } catch {
      // A file can change between the bounded glob and read. The file map is
      // still useful, so skip that one instead of failing the whole scan.
    }
  }
  return { projectName: basename(projectRoot), inspectedFiles: files.length, context: sections.join('\n\n') };
}

export async function discoverProjectAgents(
  projectRoot: string,
  model: string,
  complete: CompleteDiscoveryText = completeText,
): Promise<ProjectDiscoveryResult> {
  const snapshot = await collectProjectDiscoveryContext(projectRoot);
  const system = helperSystemPrompt(model, `You are a product-minded automation designer. Analyze a bounded, read-only project snapshot and propose three concrete AgentUse agents that would create recurring value for the people working on this project. Return strict JSON only.`);
  const requirements = `Requirements:
- Exactly three distinct suggestions, ordered by likely usefulness.
- Every suggestion MUST include an "evidence" array containing one to three non-empty strings. This field is mandatory.
- Every evidence string must cite a specific path or visible signal from the supplied snapshot.
- Never invent tools, providers, credentials, issue trackers, or external destinations.
- Agents must be safe on their first run: inspect and report, never modify files, commit, push, deploy, publish, or message people.
- Prefer durable workflows such as change summaries, dependency or test-health checks, documentation drift, release readiness, and project-specific reviews.
- Schedules should be daily or weekly, not more frequent, and should make sense for the work.
- The objective must name the inputs to inspect, the decision or analysis to perform, and a concise dashboard-visible deliverable.`;
  const prompt = `Analyze this project snapshot and return exactly this JSON shape:
{
  "summary": "one sentence describing the project and its current work",
  "suggestions": [
    {
      "name": "concise ASCII agent name",
      "description": "one concrete outcome",
      "objective": "complete production prompt for a read-only agent, grounded in this project",
      "schedule": "valid five-field cron expression",
      "evidence": ["specific path or signal from the snapshot"]
    }
  ]
}

${requirements}

<project_snapshot>
${snapshot.context}
</project_snapshot>`;
  const completionOptions = (nextPrompt: string): CompleteTextOptions => ({
    ...system,
    prompt: nextPrompt,
    maxOutputTokens: 3_500,
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(90_000),
  });
  const response = await complete(model, completionOptions(prompt));
  try {
    return parseProjectDiscoveryResponse(response, snapshot.projectName, snapshot.inspectedFiles);
  } catch (firstError) {
    const repairPrompt = `Your previous response failed validation: ${(firstError as Error).message}.

Return a corrected replacement as strict JSON only. Do not explain the correction or wrap it in Markdown.

${requirements}

<previous_response>
${response.slice(0, 16_000)}
</previous_response>

<project_snapshot>
${snapshot.context}
</project_snapshot>`;
    const repaired = await complete(model, completionOptions(repairPrompt));
    try {
      return parseProjectDiscoveryResponse(repaired, snapshot.projectName, snapshot.inspectedFiles);
    } catch {
      throw new Error('The selected model could not produce three valid, evidence-backed suggestions. Try scanning again or choose another analysis model.');
    }
  }
}
