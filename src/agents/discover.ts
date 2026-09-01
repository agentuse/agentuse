import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { glob } from 'glob';
import { completeText, type CompleteTextOptions } from '../complete-text.js';
import { formatScheduleHuman, parseScheduleExpression } from '../scheduler/parser.js';
import { helperSystemPrompt } from '../utils/anthropic.js';
import { validateAgentName } from './create.js';

const MAX_CONTEXT_CHARS = 48_000;
const MAX_FILE_CHARS = 12_000;
const MAX_FILES = 160;
const ADAPTIVE_MAX_FILES = 400;
const ADAPTIVE_MAX_FILE_BYTES = 64_000;
const ADAPTIVE_MAX_TOTAL_BYTES = 2_000_000;
const CONTEXT_FILES = [
  'README.md', 'README.mdx', 'package.json', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'Gemfile', 'Makefile', 'AGENTS.md', 'CLAUDE.md',
] as const;
const IGNORED = [
  '.git/**', 'node_modules/**', 'vendor/**', 'dist/**', 'build/**', 'coverage/**',
  '.next/**', '.turbo/**', 'tmp/**', '.cache/**', '.venv/**', 'venv/**',
  '.env', '.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/*secret*', '**/*credential*', '**/.npmrc', '**/.pypirc', '**/.netrc',
];

const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults']);
const SENSITIVE_BASENAMES = /^(?:id_[a-z0-9_-]+|credentials?|secrets?|auth|tokens?)(?:\.[a-z0-9_-]+)?$/iu;
const SENSITIVE_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\b(\s*[:=]\s*)(["']?)([^\s,"'}]+)\3/giu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;
const KNOWN_SECRET_TOKEN = /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/gu;

export function isProjectDiscoveryPathAllowed(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const name = basename(normalized);
  if (SAFE_ENV_EXAMPLES.has(name.toLowerCase())) return true;
  if (name === '.env' || name.toLowerCase().startsWith('.env.')) return false;
  if (SENSITIVE_BASENAMES.test(name) || SENSITIVE_EXTENSIONS.test(name)) return false;
  const segments = normalized.toLowerCase().split('/');
  return !segments.some((segment) => ['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv'].includes(segment));
}

export function redactProjectDiscoveryText(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]')
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(KNOWN_SECRET_TOKEN, '[REDACTED CREDENTIAL]');
}

export interface ProjectDiscoveryView {
  root: string;
  projectName: string;
  inspectedFiles: number;
  availableFiles: string[];
  cleanup(): Promise<void>;
}

async function readBoundedDiscoveryFile(projectRoot: string, relativePath: string, maxBytes: number): Promise<Buffer | undefined> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) return undefined;
  const sourcePath = join(projectRoot, relativePath);
  try {
    const sourceStats = await lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) return undefined;
    const resolvedSource = await realpath(sourcePath);
    const fromRoot = relative(projectRoot, resolvedSource);
    if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) return undefined;
  } catch {
    return undefined;
  }

  let handle;
  try {
    handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(maxBytes, ADAPTIVE_MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Build a capability-safe temporary view for an adaptive onboarding agent.
 * The model can list, search, and read this view, never the real project. The
 * view excludes sensitive/generated paths and redacts common credential forms
 * inside otherwise useful text files. */
export async function prepareProjectDiscoveryView(projectRoot: string): Promise<ProjectDiscoveryView> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentuse-onboarding-project-')));
  const resolvedProjectRoot = await realpath(projectRoot);
  const candidates = (await glob('**/*', {
    cwd: resolvedProjectRoot,
    nodir: true,
    dot: true,
    maxDepth: 8,
    ignore: IGNORED,
  })).sort();
  const availableFiles: string[] = [];
  let usedBytes = 0;
  try {
    for (const relativePath of candidates) {
      if (availableFiles.length >= ADAPTIVE_MAX_FILES || usedBytes >= ADAPTIVE_MAX_TOTAL_BYTES) break;
      if (!isProjectDiscoveryPathAllowed(relativePath)) continue;
      const remaining = ADAPTIVE_MAX_TOTAL_BYTES - usedBytes;
      const buffer = await readBoundedDiscoveryFile(resolvedProjectRoot, relativePath, remaining);
      if (!buffer) continue;
      if (buffer.includes(0)) continue;
      const text = redactProjectDiscoveryText(buffer.toString('utf8'));
      if (!text.trim()) continue;
      const destination = join(root, relativePath);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, text, 'utf8');
      availableFiles.push(relativePath);
      usedBytes += Buffer.byteLength(text);
    }
    await writeFile(join(root, 'AGENTUSE_PROJECT_INDEX.txt'), [
      `Project: ${basename(resolvedProjectRoot)}`,
      `Sanitized read-only view: ${availableFiles.length} files`,
      '',
      ...availableFiles,
    ].join('\n'), 'utf8');
    return {
      root,
      projectName: basename(resolvedProjectRoot),
      inspectedFiles: availableFiles.length,
      availableFiles,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

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
  const resolvedProjectRoot = await realpath(projectRoot);
  const files = (await glob('**/*', {
    cwd: resolvedProjectRoot,
    nodir: true,
    dot: true,
    maxDepth: 4,
    ignore: IGNORED,
  }))
    .filter(isProjectDiscoveryPathAllowed)
    .sort()
    .slice(0, MAX_FILES);
  const manifestPaths = [...new Set([
    ...CONTEXT_FILES.filter((file) => files.includes(file)),
    ...files.filter((file) => /(^|\/)(README|ABOUT)\.(md|mdx)$/i.test(file)).slice(0, 4),
    ...files.filter((file) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(file)).slice(0, 6),
  ])];
  const sections = [`Project: ${basename(resolvedProjectRoot)}`, `File map (limited to ${MAX_FILES} files, secrets and generated directories excluded):\n${files.join('\n')}`];
  let used = sections.join('\n\n').length;
  for (const path of manifestPaths) {
    if (used >= MAX_CONTEXT_CHARS) break;
    const buffer = await readBoundedDiscoveryFile(resolvedProjectRoot, path, MAX_FILE_CHARS);
    if (!buffer || buffer.includes(0)) continue;
    const body = redactProjectDiscoveryText(buffer.toString('utf8'));
    const remaining = MAX_CONTEXT_CHARS - used;
    const section = `\n\n--- ${path} ---\n${body}`.slice(0, remaining);
    sections.push(section);
    used += section.length;
  }
  return { projectName: basename(resolvedProjectRoot), inspectedFiles: files.length, context: sections.join('\n\n') };
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
