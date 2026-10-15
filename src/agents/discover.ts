import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { glob } from 'glob';
import { parseFrontmatter } from '../utils/frontmatter';
import { formatScheduleHuman, parseScheduleExpression } from '../scheduler/parser.js';
import { discoverSkills } from '../skill/discovery.js';
import { SAFE_ENV_FILENAMES, isPathInside } from '../utils/path-policy.js';
import { validateAgentName } from './create.js';
import { agentBaseName } from '../utils/agent-id.js';
import { modelJsonText } from '../utils/model-json';

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

const SENSITIVE_BASENAMES = /^(?:id_[a-z0-9_-]+|credentials?|secrets?|auth|tokens?)(?:\.[a-z0-9_-]+)?$/iu;
const SENSITIVE_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;
/** Folder names that hold secrets wherever they sit. Narrower than
 *  SENSITIVE_BASENAMES on purpose: `src/auth/` and design `tokens/` are source. */
const SENSITIVE_DIRECTORIES = /^(?:credentials?|secrets?|\.ssh|\.aws|\.gnupg)(?:\.[a-z0-9_-]+)?$/iu;
const GENERATED_SEGMENTS = ['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv'];
const MAX_RELATIVE_PATH_LENGTH = 512;
const GIT_LIST_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);
/** The credential shapes AgentUse refuses to move between a project and a model.
 *  Declared without the `g` flag so `.test()` is stateless; `redactProjectDiscoveryText`
 *  builds global copies for replacement. Shared with `changeset-validate.ts`, which
 *  applies the same three patterns as a write-time block: what is redacted on the way
 *  out must also be rejected on the way back in. */
export const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\b(\s*[:=]\s*)(["']?)([^\s,"'}]+)\3/iu;
export const PRIVATE_KEY_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/u;
export const KNOWN_SECRET_TOKEN = /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/u;

const everyMatch = (pattern: RegExp): RegExp => new RegExp(pattern.source, `${pattern.flags}g`);
const SECRET_ASSIGNMENT_ALL = everyMatch(SECRET_ASSIGNMENT);
const PRIVATE_KEY_BLOCK_ALL = everyMatch(PRIVATE_KEY_BLOCK);
const KNOWN_SECRET_TOKEN_ALL = everyMatch(KNOWN_SECRET_TOKEN);

const isEnvName = (name: string): boolean => name === '.env' || name.startsWith('.env.');

export function isProjectDiscoveryPathAllowed(path: string): boolean {
  // NFKC also folds compatibility lookalikes (fullwidth letters) onto the names below.
  const segments = path.normalize('NFKC').toLowerCase().replace(/\\/g, '/').split('/');
  const name = segments[segments.length - 1] ?? '';
  const directories = segments.slice(0, -1);
  if (segments.some((segment) => GENERATED_SEGMENTS.includes(segment))) return false;
  if (directories.some((segment) => isEnvName(segment) || SENSITIVE_DIRECTORIES.test(segment) || SENSITIVE_EXTENSIONS.test(segment))) return false;
  if (SAFE_ENV_FILENAMES.has(name)) return true;
  if (isEnvName(name)) return false;
  return !SENSITIVE_BASENAMES.test(name) && !SENSITIVE_EXTENSIONS.test(name);
}

export function redactProjectDiscoveryText(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK_ALL, '[REDACTED PRIVATE KEY]')
    .replace(SECRET_ASSIGNMENT_ALL, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(KNOWN_SECRET_TOKEN_ALL, '[REDACTED CREDENTIAL]');
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

/** A project root that is `/`, the home folder, or above it would expose every
 *  credential the user owns, so discovery and the reader refuse it outright. */
async function isProjectRootTooBroad(resolvedRoot: string): Promise<boolean> {
  if (dirname(resolvedRoot) === resolvedRoot) return true;
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  return isPathInside(resolvedRoot, home);
}

function isSafeRelativePathText(relativePath: string): boolean {
  if (!relativePath || relativePath.length > MAX_RELATIVE_PATH_LENGTH) return false;
  if (isAbsolute(relativePath) || relativePath.includes('\\') || /[\u0000-\u001f\u007f]/u.test(relativePath)) return false;
  return relativePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Test seams for the two windows a swapped directory could strike: between the
 *  path walk and the open, and between the open and the identity check. */
export interface ProjectFileReadHooks {
  beforeOpen?: () => Promise<void>;
  afterOpen?: () => Promise<void>;
}

/** Read at most `maxBytes` of one regular file inside `projectRoot`. Every refusal
 *  is `undefined`, whatever the reason, so a caller learns nothing about paths
 *  outside the project. The checks hold against a project whose contents are
 *  hostile: symlinks or junctions at any depth, hard links to outside files, and
 *  a directory swapped for a link between the checks and the open. */
export async function readProjectDiscoveryFile(
  projectRoot: string,
  relativePath: string,
  maxBytes: number,
  hooks: ProjectFileReadHooks = {},
): Promise<Buffer | undefined> {
  if (!isSafeRelativePathText(relativePath)) return undefined;
  let root: string;
  let sourcePath: string;
  try {
    root = await realpath(projectRoot);
    if (await isProjectRootTooBroad(root)) return undefined;
    // Walk down from the root so no segment, not just the last one, is a link.
    const segments = relativePath.split('/');
    sourcePath = root;
    for (const [index, segment] of segments.entries()) {
      sourcePath = join(sourcePath, segment);
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) return undefined;
      if (index < segments.length - 1 ? !stats.isDirectory() : !stats.isFile()) return undefined;
    }
    await hooks.beforeOpen?.();
  } catch {
    return undefined;
  }

  let handle;
  try {
    // O_NONBLOCK keeps a FIFO swapped in after the walk from hanging the open.
    handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.nlink !== 1) return undefined;
    await hooks.afterOpen?.();
    // The walk and the open are separate steps; prove the opened file is the one
    // the path names now, and that the path still resolves inside the root.
    const resolvedSource = await realpath(sourcePath);
    if (!isPathInside(root, resolvedSource, { allowEqual: false })) return undefined;
    const resolvedStats = await lstat(resolvedSource);
    if (resolvedStats.dev !== openedStats.dev || resolvedStats.ino !== openedStats.ino) return undefined;
    const buffer = Buffer.alloc(Math.min(maxBytes, ADAPTIVE_MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Files git would not ignore, relative to `root`, or `undefined` when git is
 *  missing or the root is not in a repository. fsmonitor is forced off because
 *  a planted `.git/config` could otherwise run a command in the server. */
async function listGitVisibleFiles(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, timeout: GIT_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
    );
    return new Set(stdout.split('\0').filter(Boolean));
  } catch {
    return undefined;
  }
}

async function readExistingProjectAgentSummary(
  projectRoot: string,
  relativePath: string,
): Promise<ExistingProjectAgentSummary | undefined> {
  const buffer = await readProjectDiscoveryFile(projectRoot, relativePath, 16_000);
  if (!buffer || buffer.includes(0)) return undefined;
  const text = redactProjectDiscoveryText(buffer.toString('utf8'));
  try {
    const parsed = parseFrontmatter(text);
    const data = parsed.data && typeof parsed.data === 'object'
      ? parsed.data as Record<string, unknown>
      : {};
    const fallbackName = agentBaseName(relativePath);
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
      name: agentBaseName(relativePath).slice(0, 120),
      description: '',
    };
  }
}

/** Build a capability-safe temporary view for an adaptive onboarding agent.
 * The model can list, search, and read this view, never the real project. The
 * view excludes sensitive/generated paths and redacts common credential forms
 * inside otherwise useful text files. */
export async function prepareProjectDiscoveryView(projectRoot: string): Promise<ProjectDiscoveryView> {
  const resolvedProjectRoot = await realpath(projectRoot);
  if (await isProjectRootTooBroad(resolvedProjectRoot)) {
    throw new Error('Project discovery cannot scan your home folder or a folder that contains it');
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentuse-onboarding-project-')));
  const gitVisible = await listGitVisibleFiles(resolvedProjectRoot);
  const candidates = (await glob('**/*', {
    cwd: resolvedProjectRoot,
    nodir: true,
    dot: true,
    posix: true,
    maxDepth: 8,
    ignore: IGNORED,
  })).filter((relativePath) => !gitVisible || gitVisible.has(relativePath)).sort();
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
      const buffer = await readProjectDiscoveryFile(resolvedProjectRoot, relativePath, remaining);
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

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The project scan returned an invalid ${label}`);
  const text = value.trim();
  if (text.length > max) throw new Error(`The project scan returned a ${label} that is too long`);
  return text;
}

export function parseProjectDiscoveryResponse(response: string, projectName: string, inspectedFiles: number): ProjectDiscoveryResult {
  let raw: unknown;
  try {
    raw = JSON.parse(modelJsonText(response));
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
