import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { formatScheduleHuman, parseScheduleExpression } from '../scheduler/parser.js';
import { discoverSkills } from '../skill/discovery.js';
import { isPathInside } from '../utils/path-policy.js';
import { validateAgentName } from './create.js';

const ADAPTIVE_MAX_FILES = 400;
const ADAPTIVE_MAX_FILE_BYTES = 64_000;
const ADAPTIVE_MAX_TOTAL_BYTES = 2_000_000;
const ADAPTIVE_MAX_EXISTING_AGENTS = 100;
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
  existingAgents: ExistingProjectAgentSummary[];
  cleanup(): Promise<void>;
}

export interface ExistingProjectAgentSummary {
  path: string;
  name: string;
  description: string;
}

export interface ProjectSkillSummary {
  name: string;
  description: string;
  source: 'project' | 'global';
  allowedTools: string[];
  ambiguous: boolean;
}

/** Return the effective runtime skill catalog without copying skill bodies into
 * the sanitized project view. Discovery only needs selection metadata; the
 * creator later loads the real winning SKILL.md and its referenced files. */
export async function discoverProjectSkillCatalog(projectRoot: string): Promise<ProjectSkillSummary[]> {
  const resolvedProjectRoot = await realpath(projectRoot).catch(() => resolve(projectRoot));
  const projectSkillRoots = [
    join(resolvedProjectRoot, '.agentuse', 'skills'),
    join(resolvedProjectRoot, '.claude', 'skills'),
  ];
  const skills = await discoverSkills(resolvedProjectRoot);
  return [...skills.values()]
    .map((skill): ProjectSkillSummary => ({
      name: skill.name,
      description: skill.description,
      source: projectSkillRoots.some((root) => isPathInside(root, skill.location)) ? 'project' : 'global',
      allowedTools: [...(skill.allowedTools ?? [])],
      ambiguous: Boolean(skill.shadowedLocations?.length),
    }))
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === 'project' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

async function readBoundedDiscoveryFile(projectRoot: string, relativePath: string, maxBytes: number): Promise<Buffer | undefined> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) return undefined;
  const sourcePath = join(projectRoot, relativePath);
  try {
    const sourceStats = await lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) return undefined;
    const resolvedSource = await realpath(sourcePath);
    if (!isPathInside(projectRoot, resolvedSource, { allowEqual: false })) return undefined;
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

async function readExistingProjectAgentSummary(
  projectRoot: string,
  relativePath: string,
): Promise<ExistingProjectAgentSummary | undefined> {
  const buffer = await readBoundedDiscoveryFile(projectRoot, relativePath, 16_000);
  if (!buffer || buffer.includes(0)) return undefined;
  const text = redactProjectDiscoveryText(buffer.toString('utf8'));
  try {
    const parsed = matter(text, {});
    const data = parsed.data && typeof parsed.data === 'object'
      ? parsed.data as Record<string, unknown>
      : {};
    const fallbackName = basename(relativePath, '.agentuse');
    const name = typeof data.name === 'string' && data.name.trim()
      ? data.name.trim().slice(0, 120)
      : fallbackName;
    const description = typeof data.description === 'string'
      ? data.description.trim().slice(0, 240)
      : '';
    return { path: relativePath, name, description };
  } catch {
    return {
      path: relativePath,
      name: basename(relativePath, '.agentuse').slice(0, 120),
      description: '',
    };
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
  const existingAgents: ExistingProjectAgentSummary[] = [];
  let usedBytes = 0;
  try {
    // Collect covered responsibilities independently of the source-file cap so
    // large repositories cannot hide agents that sort after the first 400 files.
    const agentPaths = candidates
      .filter((relativePath) => relativePath.toLowerCase().endsWith('.agentuse'))
      .slice(0, ADAPTIVE_MAX_EXISTING_AGENTS);
    for (const relativePath of agentPaths) {
      const summary = await readExistingProjectAgentSummary(resolvedProjectRoot, relativePath);
      if (summary) existingAgents.push(summary);
    }

    for (const relativePath of candidates) {
      // Existing agent source is useful for avoiding duplicate responsibilities,
      // but it must not become ordinary project evidence: doing so anchors the
      // discovery model on agents it previously created. Keep only bounded
      // identity metadata in a separate, explicitly "already covered" catalog.
      if (relativePath.toLowerCase().endsWith('.agentuse')) continue;
      // Runtime state and installed-skill bodies under .agentuse are not
      // product source. Skills are represented by the separate bounded catalog.
      if (relativePath.replace(/\\/gu, '/').startsWith('.agentuse/')) continue;
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
      existingAgents,
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
