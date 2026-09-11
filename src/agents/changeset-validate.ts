/**
 * Changeset validation (agentuse-lab #226, #227, #236).
 *
 * `validateChangesetFiles` is the single gate between "the model wrote some
 * files into the overlay" and "the operator is shown a proposal". It runs in
 * `submit_changes` and again on Apply, so it never trusts anything it is
 * handed: paths, sizes, encodings, agent frontmatter, and cross-file references
 * are all re-derived here. Errors are written for the model, because the tool
 * relays them straight back into the authoring session.
 *
 * Rules are ordered cheapest-first: path policy, caps, encoding, extension
 * allowlist, content hard blocks, review flags, per-agent-file validation,
 * then the cross-file graph (#227).
 */
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { parseAgentContent } from '../parser.js';
import { grantsArbitraryCode, grantsUnnamedSubcommands } from '../tools/effectful-heuristic.js';
import { match as wildcardMatch } from '../tools/wildcard.js';
import { isPathInside } from '../utils/path-policy.js';
import { validateAuthoredAgentSource } from './author.js';
import { isProjectDiscoveryPathAllowed } from './discover.js';
import {
  CHANGESET_DENIED_SEGMENTS,
  CHANGESET_LIMITS,
  CHANGESET_SUPPORT_EXTENSIONS,
  type ChangesetFile,
  type ChangesetFileOp,
  type ChangesetMode,
} from './changeset-types.js';

/** Credential shapes that must never reach the project through a changeset.
 *  Kept here (rather than imported) because `discover.ts` does not export them;
 *  the redaction pass there is a read-time defence, this is a write-time one. */
export const CHANGESET_PRIVATE_KEY_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/u;
export const CHANGESET_KNOWN_SECRET_TOKEN = /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/u;

const SUDO = /(^|[\s;&|(])sudo\s/u;
const CHMOD = /(^|[\s;&|(])chmod\s/u;
const REMOVE_RECURSIVE = /(^|[\s;&|(])rm\s+((?:-[A-Za-z]+\s+)+)(\S+)/gu;
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/u;

const NETWORK_MARKERS = ['requests.', 'fetch(', 'urllib', 'curl', 'http'];
const EXECUTION_MARKERS = ['subprocess', 'exec(', 'eval(', 'child_process'];
const ENVIRONMENT_MARKERS = ['os.environ', 'process.env'];

const MANIFEST_BASENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'poetry.lock', 'uv.lock',
  'package.json', 'pyproject.toml', 'cargo.toml',
]);
const LOCK_BASENAME = /^bun\.lock/u;

const SENSITIVE_NAME_MARKERS = ['secret', 'credential'];
const SENSITIVE_DOTFILES = new Set(['.npmrc', '.pypirc', '.netrc']);

export const AGENT_EXTENSION = '.agentuse';

export interface ChangesetInputFile {
  path: string;
  op: ChangesetFileOp;
  baseHash: string | null;
  content: string;
  /** Real project content the overlay copied on first write. Required for `modify`. */
  baseContent?: string;
}

export interface ValidateChangesetFilesInput {
  mode: ChangesetMode;
  scopeRoot: string;
  projectRoot: string;
  /** Revise only: the agent the changeset is about. `path` is project-relative. */
  target?: { path: string };
  /** Project-relative path of the agent a test run should execute. */
  entry: string;
  files: ChangesetInputFile[];
  availableModels: readonly string[];
  availableSkills: readonly string[];
  loadedSkills?: readonly string[];
  /** Reads a project-relative file from the real project. `undefined` when absent. */
  readProjectFile: (relPath: string) => Promise<string | undefined>;
  /** Project-relative paths of every `.agentuse` file already in the project. */
  listProjectAgents: () => Promise<string[]>;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRelative(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function isAgentPath(path: string): boolean {
  return path.toLowerCase().endsWith(AGENT_EXTENSION);
}

function extensionOf(path: string): string {
  const base = posix.basename(path).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/** Path policy only, synchronous, so the filesystem overlay can refuse a write
 *  with the same answer the submit-time validator would give. */
export function isChangesetPathAllowed(relPath: string): { allowed: boolean; reason?: string } {
  const deny = (reason: string): { allowed: boolean; reason: string } => ({ allowed: false, reason });
  if (typeof relPath !== 'string' || !relPath.trim()) return deny('the path is empty');
  if (relPath.includes('\\')) return deny(`${relPath} must use forward slashes`);
  if (relPath.includes('\0')) return deny('the path contains a NUL byte');
  if (relPath.startsWith('/') || /^[A-Za-z]:/u.test(relPath)) return deny(`${relPath} must be project-relative, not absolute`);
  const segments = relPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.')) return deny(`${relPath} must not contain empty or "." path segments`);
  if (segments.includes('..')) return deny(`${relPath} must not contain ".." path segments`);
  const denied = segments.find((segment) => CHANGESET_DENIED_SEGMENTS.includes(segment.toLowerCase()));
  if (denied) return deny(`${relPath} is inside ${denied}/, which changesets never write`);
  const base = posix.basename(relPath).toLowerCase();
  if (SENSITIVE_DOTFILES.has(base)) return deny(`${relPath} holds registry credentials and cannot be part of a changeset`);
  if (SENSITIVE_NAME_MARKERS.some((marker) => base.includes(marker))) {
    return deny(`${relPath} looks like a credential file and cannot be part of a changeset`);
  }
  if (!isProjectDiscoveryPathAllowed(relPath)) return deny(`${relPath} is an environment, key, or credential file and cannot be part of a changeset`);
  return { allowed: true };
}

function assertPathInScope(relPath: string, projectRoot: string, scopeRoot: string): void {
  // Changeset paths are scope-relative; projectRoot only locates the record.
  void projectRoot;
  const absolute = resolve(scopeRoot, relPath);
  if (!isPathInside(resolve(scopeRoot), absolute, { allowEqual: false })) {
    throw new Error(`${relPath} is outside the served project scope`);
  }
}

function assertNoSecrets(relPath: string, content: string): void {
  if (CHANGESET_PRIVATE_KEY_BLOCK.test(content)) throw new Error(`${relPath} contains a private key block. Read credentials from the environment at run time instead.`);
  if (CHANGESET_KNOWN_SECRET_TOKEN.test(content)) throw new Error(`${relPath} contains what looks like a live API token. Read credentials from the environment at run time instead.`);
}

function assertSupportContentSafe(relPath: string, content: string): void {
  if (SUDO.test(content)) throw new Error(`${relPath} runs sudo. A changeset script cannot escalate privileges.`);
  if (CHMOD.test(content)) throw new Error(`${relPath} runs chmod. A changeset script cannot change file permissions.`);
  if (PIPE_TO_SHELL.test(content)) throw new Error(`${relPath} pipes a download into a shell. Install dependencies outside the agent instead.`);
  REMOVE_RECURSIVE.lastIndex = 0;
  for (const match of content.matchAll(REMOVE_RECURSIVE)) {
    const flags = match[2] ?? '';
    if (!/r/u.test(flags) || !/f/u.test(flags)) continue;
    const argument = (match[3] ?? '').replace(/^["']/u, '');
    if (argument.startsWith('${root}') || argument.startsWith('${tmpDir}')) continue;
    throw new Error(`${relPath} runs a recursive delete outside \${root} or \${tmpDir}: ${match[0].trim()}`);
  }
}

function reviewFlagsFor(relPath: string, content: string, isAgent: boolean): string[] {
  const flags: string[] = [];
  const base = posix.basename(relPath).toLowerCase();
  if (MANIFEST_BASENAMES.has(base) || LOCK_BASENAME.test(base)) flags.push('manifest');
  if (isAgent) return flags;
  if (extensionOf(relPath) === '.sh') flags.push('shell script');
  if (NETWORK_MARKERS.some((marker) => content.includes(marker))) flags.push('makes network calls');
  if (EXECUTION_MARKERS.some((marker) => content.includes(marker))) flags.push('runs subprocesses or evaluates code');
  if (ENVIRONMENT_MARKERS.some((marker) => content.includes(marker))) flags.push('reads environment variables');
  return flags;
}

type AgentConfig = ReturnType<typeof parseAgentContent>['config'];

function explicitSkillNames(config: AgentConfig): string[] {
  return Object.keys(config.skills?.explicit ?? {});
}

function hasTrustedSkills(config: AgentConfig): boolean {
  return config.skills?.trusted === true
    || Object.values(config.skills?.explicit ?? {}).some((skill) => skill.trusted === true);
}

function declaresSkillAccess(config: AgentConfig): boolean {
  return explicitSkillNames(config).length > 0 || hasTrustedSkills(config);
}

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

/** Capability deltas in the same vocabulary the revision review already uses.
 *  With no base (an `add`), every capability the file declares is listed as
 *  added, so a new agent's review reads like a grant list rather than a diff. */
function capabilityChangesFor(current: AgentConfig | undefined, proposed: AgentConfig): string[] {
  const changes: string[] = [];
  if (!current) {
    changes.push(`Runtime model added: ${proposed.model}`);
    if (proposed.schedule) changes.push('Schedule added');
    if (proposed.tools?.filesystem) changes.push('Filesystem access added');
    if (proposed.tools?.bash) changes.push('Bash commands or approval gates added');
    if (proposed.mcpServers) changes.push('MCP integrations added');
    if (declaresSkillAccess(proposed)) changes.push('Skill access added');
    if (proposed.subagents) changes.push('Sub-agent access added');
    if (proposed.channels) changes.push('Notification channels added');
    return changes;
  }
  if (current.model !== proposed.model) changes.push(`Runtime model: ${current.model} → ${proposed.model}`);
  if (current.schedule !== proposed.schedule) changes.push('Schedule changed');
  if (changed(current.tools?.filesystem, proposed.tools?.filesystem)) changes.push('Filesystem access changed');
  if (changed(current.tools?.bash, proposed.tools?.bash)) changes.push('Bash commands or approval gates changed');
  if (changed(current.mcpServers, proposed.mcpServers)) changes.push('MCP integrations changed');
  if (changed(current.skills, proposed.skills)) changes.push('Skill access changed');
  if (changed(current.subagents, proposed.subagents)) changes.push('Sub-agent access changed');
  if (changed(current.channels, proposed.channels)) changes.push('Notification channels changed');
  return changes;
}

/**
 * The `validateRevisionSource` rules from `revision.ts`, applied per file.
 * Copied rather than imported: `revision.ts` keeps that function private and is
 * owned by the legacy flow during the migration, so importing it would couple
 * the changeset validator to a module that is scheduled for deletion.
 */
function validateModifiedAgentSource(input: {
  path: string;
  currentSource: string;
  proposedSource: string;
  availableModels: readonly string[];
  availableSkills: readonly string[];
  loadedSkills?: readonly string[];
}): { config: AgentConfig; capabilityChanges: string[] } {
  const { path, proposedSource } = input;
  if (!proposedSource || !proposedSource.startsWith('---')) {
    throw new Error(`${path} must stay a complete AgentUse file with YAML frontmatter`);
  }
  let current: ReturnType<typeof parseAgentContent>;
  let proposed: ReturnType<typeof parseAgentContent>;
  try {
    current = parseAgentContent(input.currentSource, 'current-agent');
  } catch (error) {
    throw new Error(`${path} could not be parsed in the project as it stands: ${(error as Error).message}`);
  }
  try {
    proposed = parseAgentContent(proposedSource, 'proposed-agent');
  } catch (error) {
    throw new Error(`${path} is not valid AgentUse source: ${(error as Error).message}`);
  }
  if (proposed.config.name !== current.config.name) {
    throw new Error(current.config.name
      ? `${path} must preserve the agent name ${current.config.name}`
      : `${path} must not add an explicit agent name when the current source omits one`);
  }
  if (!proposed.instructions.trim()) throw new Error(`${path} must include instructions`);
  if (proposed.config.model !== current.config.model && !input.availableModels.includes(proposed.config.model)) {
    const provider = proposed.config.model.split(':')[0];
    const sameProvider = input.availableModels.filter((model) => model.startsWith(`${provider}:`));
    const hint = sameProvider.length > 0
      ? `Available ${provider} models: ${sameProvider.join(', ')}`
      : `Available models: ${input.availableModels.join(', ')}`;
    throw new Error(`${path} selected an unavailable runtime model: ${proposed.config.model}. ${hint}`);
  }

  const availableSkills = new Set(input.availableSkills);
  const currentSkills = new Set(explicitSkillNames(current.config));
  const loadedSkills = new Set(input.loadedSkills ?? []);
  for (const skill of explicitSkillNames(proposed.config)) {
    if (!availableSkills.has(skill)) throw new Error(`${path} references an unavailable or ambiguous skill: ${skill}`);
    if (!currentSkills.has(skill) && input.loadedSkills !== undefined && !loadedSkills.has(skill)) {
      throw new Error(`${path} added ${skill} without loading its complete SKILL.md first`);
    }
  }

  if (!hasTrustedSkills(current.config) && hasTrustedSkills(proposed.config)) {
    throw new Error(`${path} cannot introduce trusted skills without separate operator configuration`);
  }

  const currentCommands = new Set(current.config.tools?.bash?.commands ?? []);
  const currentGated = current.config.tools?.bash?.gated ?? [];
  const proposedGated = proposed.config.tools?.bash?.gated ?? [];
  const structurallyUnsafeCommand = (proposed.config.tools?.bash?.commands ?? []).find((command) => {
    const structurallyUnsafe = grantsArbitraryCode(command) || grantsUnnamedSubcommands(command);
    const remainsGated = proposedGated.some((pattern) => wildcardMatch(command, pattern));
    if (!structurallyUnsafe || remainsGated) return false;
    const wasAlreadyUngated = currentCommands.has(command)
      && !currentGated.some((pattern) => wildcardMatch(command, pattern));
    return !wasAlreadyUngated;
  });
  if (structurallyUnsafeCommand) {
    throw new Error(`${path} introduced or ungated a structurally unsafe command grant: ${structurallyUnsafeCommand}`);
  }

  return {
    config: proposed.config,
    capabilityChanges: capabilityChangesFor(current.config, proposed.config),
  };
}

/**
 * Resolve a path token to a scope-relative path. `base` is the directory a
 * bare relative token is joined onto: the agent's own directory for
 * `subagents` / `dependsOn` (that is how the parser resolves them), and the
 * scope root for bash commands, because the bash tool runs with cwd =
 * project root, so `python3 agents/x.py` means `<root>/agents/x.py`.
 */
function expandPathVariables(token: string, agentDir: string, base: string = agentDir): string | undefined {
  if (token.includes('${tmpDir}')) return undefined;
  const rootAnchored = token.startsWith('${root}');
  const agentAnchored = token.startsWith('${agentDir}');
  let value = token;
  if (rootAnchored) value = value.slice('${root}'.length).replace(/^\//u, '');
  if (agentAnchored) {
    const rest = value.slice('${agentDir}'.length).replace(/^\//u, '');
    value = agentDir ? posix.join(agentDir, rest) : rest;
  }
  if (value.includes('${')) return undefined;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return undefined;
  const resolved = rootAnchored || agentAnchored ? value : posix.join(base, value);
  const normalized = normalizeRelative(resolved);
  return normalized.startsWith('..') ? undefined : normalized;
}

/** Exact script paths named in a bash grant. A token with a wildcard grants a
 *  shape rather than a file, so it carries no cross-file reference. */
function scriptReferencesIn(commands: readonly string[], agentDir: string): string[] {
  const references: string[] = [];
  for (const command of commands) {
    for (const raw of command.split(/\s+/u)) {
      const token = raw.replace(/^["']+/u, '').replace(/["';]+$/u, '');
      if (!token || token.includes('*') || token.includes('?')) continue;
      if (!CHANGESET_SUPPORT_EXTENSIONS.some((extension) => token.toLowerCase().endsWith(extension))) continue;
      // Bash runs from the project root, so a bare script path is root-relative.
      const resolved = expandPathVariables(token, agentDir, '');
      if (resolved) references.push(resolved);
    }
  }
  return references;
}

interface AgentReferences {
  /** Referenced `.agentuse` files: subagents and advisory dependsOn ordering. */
  agents: string[];
  /** Referenced support files: exact script paths in bash grants. */
  supports: string[];
}

function referencesOf(config: AgentConfig, agentPath: string): AgentReferences {
  const agentDir = posix.dirname(agentPath) === '.' ? '' : posix.dirname(agentPath);
  const agents: string[] = [];
  for (const token of [
    ...(config.subagents ?? []).map((subagent) => subagent.path),
    ...(config.dependsOn ?? []),
  ]) {
    const resolved = expandPathVariables(token, agentDir);
    if (resolved) agents.push(resolved);
  }
  const supports = scriptReferencesIn([
    ...(config.tools?.bash?.commands ?? []),
    ...(config.tools?.bash?.gated ?? []),
  ], agentDir);
  return { agents, supports };
}

function detectCycle(edges: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const walk = (node: string): string[] | undefined => {
    if (state.get(node) === 'done') return undefined;
    if (state.get(node) === 'open') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'open');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of edges.keys()) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return undefined;
}

export async function validateChangesetFiles(input: ValidateChangesetFilesInput): Promise<ChangesetFile[]> {
  const { files } = input;
  if (files.length === 0) throw new Error('A proposal must contain at least one file');
  if (files.length > CHANGESET_LIMITS.maxFiles) {
    throw new Error(`A changeset may contain at most ${CHANGESET_LIMITS.maxFiles} files; this one has ${files.length}`);
  }

  // 1. Path policy.
  const seen = new Set<string>();
  for (const file of files) {
    const policy = isChangesetPathAllowed(file.path);
    if (!policy.allowed) throw new Error(policy.reason ?? `${file.path} is not a writable changeset path`);
    if (file.path !== normalizeRelative(file.path)) throw new Error(`${file.path} must be written in normalized form`);
    if (seen.has(file.path)) throw new Error(`${file.path} appears twice in the changeset`);
    seen.add(file.path);
    assertPathInScope(file.path, input.projectRoot, input.scopeRoot);
    if (file.op === 'add' && file.baseHash !== null) throw new Error(`${file.path} is marked as a new file but carries a base hash`);
    if (file.op === 'modify' && !file.baseHash) throw new Error(`${file.path} is marked as an edit but carries no base hash`);
  }

  // 2. Caps and encoding.
  let totalBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > CHANGESET_LIMITS.maxFileBytes) {
      throw new Error(`${file.path} is ${bytes} bytes; a changeset file may be at most ${CHANGESET_LIMITS.maxFileBytes}`);
    }
    totalBytes += bytes;
    if (file.content.includes('\0')) throw new Error(`${file.path} is not a text file; changesets carry text only`);
  }
  if (totalBytes > CHANGESET_LIMITS.maxTotalBytes) {
    throw new Error(`The changeset is ${totalBytes} bytes; the total may be at most ${CHANGESET_LIMITS.maxTotalBytes}`);
  }

  // 3. Extension allowlist, secrets, support-script hard blocks, review flags.
  const flagsByPath = new Map<string, string[]>();
  for (const file of files) {
    const agent = isAgentPath(file.path);
    if (!agent && !CHANGESET_SUPPORT_EXTENSIONS.includes(extensionOf(file.path))) {
      throw new Error(`${file.path} has an unsupported extension; changeset support files must be one of ${CHANGESET_SUPPORT_EXTENSIONS.join(' ')}`);
    }
    assertNoSecrets(file.path, file.content);
    if (!agent) assertSupportContentSafe(file.path, file.content);
    flagsByPath.set(file.path, reviewFlagsFor(file.path, file.content, agent));
  }

  // 4. Base content for every edit, so a diff and a name check have something
  //    to compare against even when the overlay did not carry it along.
  const baseByPath = new Map<string, string>();
  for (const file of files) {
    if (file.op !== 'modify') continue;
    const base = file.baseContent ?? await input.readProjectFile(file.path);
    if (base === undefined) {
      throw new Error(`${file.path} is marked as an edit but no version of it exists in the project`);
    }
    baseByPath.set(file.path, base);
  }

  // 5. Per-agent-file validation and capability deltas.
  const capabilityByPath = new Map<string, string[]>();
  const configByPath = new Map<string, AgentConfig>();
  for (const file of files) {
    if (!isAgentPath(file.path)) continue;
    if (file.op === 'add') {
      let authored: ReturnType<typeof validateAuthoredAgentSource>;
      try {
        authored = validateAuthoredAgentSource(
          file.content,
          input.availableModels,
          undefined,
          undefined,
          input.availableSkills,
          input.loadedSkills,
        );
      } catch (error) {
        throw new Error(`${file.path}: ${(error as Error).message}`);
      }
      const config = parseAgentContent(authored.source, file.path).config;
      configByPath.set(file.path, config);
      capabilityByPath.set(file.path, capabilityChangesFor(undefined, config));
      continue;
    }
    const currentSource = baseByPath.get(file.path) ?? '';
    const validated = validateModifiedAgentSource({
      path: file.path,
      currentSource,
      proposedSource: file.content,
      availableModels: input.availableModels,
      availableSkills: input.availableSkills,
      ...(input.loadedSkills !== undefined && { loadedSkills: input.loadedSkills }),
    });
    configByPath.set(file.path, validated.config);
    capabilityByPath.set(file.path, validated.capabilityChanges);
  }

  // 6. Cross-file graph (#227).
  const changesetPaths = new Set(files.map((file) => file.path));
  const referencedSupports = new Set<string>();
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const config = configByPath.get(file.path);
    if (!config) continue;
    const references = referencesOf(config, file.path);
    const agentEdges: string[] = [];
    for (const reference of references.agents) {
      if (reference === file.path) throw new Error(`${file.path} references itself as a sub-agent or dependency`);
      if (!changesetPaths.has(reference) && (await input.readProjectFile(reference)) === undefined) {
        throw new Error(`${file.path} references ${reference}, which is neither in this changeset nor in the project`);
      }
      if (changesetPaths.has(reference)) agentEdges.push(reference);
    }
    edges.set(file.path, agentEdges);
    for (const reference of references.supports) {
      if (!changesetPaths.has(reference) && (await input.readProjectFile(reference)) === undefined) {
        throw new Error(`${file.path} runs ${reference}, which is neither in this changeset nor in the project`);
      }
      referencedSupports.add(reference);
    }
  }
  const cycle = detectCycle(edges);
  if (cycle) throw new Error(`The changeset agents reference each other in a cycle: ${cycle.join(' → ')}`);

  const entry = normalizeRelative(input.entry);
  const entryIsAgentInSet = changesetPaths.has(entry) && isAgentPath(entry);
  const entryIsTarget = Boolean(input.target && normalizeRelative(input.target.path) === entry && isAgentPath(entry));
  if (!entryIsAgentInSet && !entryIsTarget) {
    throw new Error(`The entry ${input.entry} must be one of the .agentuse files in this changeset`);
  }

  // 7. Review flags that need the whole set: orphan support files, edits
  //    outside the agent folder, and files other project agents also use.
  const anchor = normalizeRelative(input.target?.path ?? entry);
  const anchorDir = posix.dirname(anchor) === '.' ? '' : posix.dirname(anchor);
  const projectAgents = (await input.listProjectAgents())
    .map(normalizeRelative)
    .filter((path) => !changesetPaths.has(path));
  const usersByPath = new Map<string, string[]>();
  if (files.some((file) => file.op === 'modify')) {
    for (const agentPath of projectAgents) {
      const source = await input.readProjectFile(agentPath);
      if (source === undefined) continue;
      let config: AgentConfig;
      try {
        config = parseAgentContent(source, agentPath).config;
      } catch {
        continue;
      }
      const references = referencesOf(config, agentPath);
      for (const reference of [...references.agents, ...references.supports]) {
        usersByPath.set(reference, [...(usersByPath.get(reference) ?? []), agentPath]);
      }
    }
  }

  for (const file of files) {
    const flags = flagsByPath.get(file.path) ?? [];
    if (!isAgentPath(file.path) && !referencedSupports.has(file.path) && !usersByPath.has(file.path)) {
      flags.push('not referenced by any agent in this changeset');
    }
    const fileDir = posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path);
    if (file.op === 'modify' && fileDir !== anchorDir) {
      flags.push('existing project file outside the agent folder');
    }
    if (file.op === 'modify') {
      for (const user of usersByPath.get(file.path) ?? []) flags.push(`also used by ${user}`);
    }
    flagsByPath.set(file.path, flags);
  }

  // 8. Materialize.
  return files.map((file): ChangesetFile => {
    const base = file.op === 'modify' ? (baseByPath.get(file.path) ?? '') : '';
    const flags = flagsByPath.get(file.path) ?? [];
    const capabilityChanges = capabilityByPath.get(file.path);
    return {
      path: file.path,
      kind: isAgentPath(file.path) ? 'agent' : 'support',
      op: file.op,
      baseHash: file.baseHash,
      content: file.content,
      hash: contentHash(file.content),
      patch: createTwoFilesPatch(
        file.op === 'add' ? '/dev/null' : `a/${file.path}`,
        `b/${file.path}`,
        base,
        file.content,
        '',
        '',
        { context: 3 },
      ),
      ...(capabilityChanges && capabilityChanges.length > 0 && { capabilityChanges }),
      ...(flags.length > 0 && { flags }),
    };
  });
}
