/**
 * Overlay filesystem tools for changeset authoring (agentuse-lab #226, #236).
 *
 * The creator/reviser model sees ONE tree: the real project scope. Reads fall
 * through to the project (redacted), writes land in the changeset edit folder.
 * The real project is never opened for writing by these tools — see the
 * `NEVER writes into scopeRoot` comments in the write and edit executors.
 *
 * The tool names match the plain filesystem tools, so the loader can swap this
 * whole record in without the model noticing a different surface. Tool
 * descriptions deliberately describe the project root only; the edit folder is
 * a host implementation detail the model does not need to know about.
 *
 * Deny checking here is a fast local gate. `changeset-validate.ts` re-validates
 * every staged path at submit and again at apply, so this is defence in depth,
 * not the only gate.
 */
import type { Tool } from 'ai';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { createReadTool, createWriteTool, createEditTool } from './filesystem.js';
import { resolveRealPath, type PathResolverContext } from './path-validator.js';
import { withFileMutationQueue } from './file-mutation-queue.js';
import { getToolOutputLimits, truncateEnd } from './tool-output-limits.js';
import { isMediaToolOutput, buildMediaContentValue, sniffMediaType, humanBytes, type MediaToolOutput } from './media.js';
import type { FilesystemPathConfig, ToolOutput, ToolErrorOutput } from './types.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { isPathInside } from '../utils/path-policy.js';
import { CHANGESET_DENIED_SEGMENTS, CHANGESET_LIMITS } from '../agents/changeset-types.js';
import { isProjectDiscoveryPathAllowed } from '../agents/discover.js';
import { toErrorMessage } from '../utils/error-message';

const OVERLAY_LIST_MAX_ENTRIES = 500;
const OVERLAY_SEARCH_MAX_MATCHES = 100;
const OVERLAY_SEARCH_MAX_FILE_BYTES = 256 * 1024;
const OVERLAY_SEARCH_MAX_CONTEXT_LINES = 5;

export interface OverlayFilesystemOptions {
  /** Real project scope the model reads and appears to write. */
  scopeRoot: string;
  /** `.agentuse/changeset/<id>/edit/` — where every write actually lands. */
  editRoot: string;
  /** `.agentuse/changeset/<id>/base.json` — `{ [relPath]: sha256 }` of first-write bases. */
  basePath: string;
  /** Secret redactor applied to every real-project text read. */
  redact: (text: string) => string;
  context: PathResolverContext;
}

type InnerExecute<TArgs> = (
  args: TArgs,
  options?: { abortSignal?: AbortSignal },
) => Promise<ToolOutput | MediaToolOutput>;

function innerExecute<TArgs>(tool: Tool): InnerExecute<TArgs> {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== 'function') throw new Error('Filesystem tool is not executable');
  return execute as InnerExecute<TArgs>;
}

function errorOutput(message: string): ToolOutput {
  return { output: JSON.stringify({ success: false, error: message } satisfies ToolErrorOutput) };
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Local deny gate over a project-relative path. Mirrors the changeset deny list
 * plus the discovery secret rules; `changeset-validate.ts` applies the
 * authoritative version again at submit.
 */
function denyReason(relPath: string): string | undefined {
  const segments = relPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return 'a file path is required';
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'relative segments like ".." are not allowed';
  }
  const denied = segments.find((segment) => CHANGESET_DENIED_SEGMENTS.includes(segment));
  if (denied) {
    return `"${denied}/" is on the never-touch list (version control, dependencies, build output, or agent state)`;
  }
  if (!isProjectDiscoveryPathAllowed(relPath)) {
    return `"${segments[segments.length - 1]}" looks like a secret, key, or credential file`;
  }
  return undefined;
}

async function isFile(target: string): Promise<boolean> {
  try {
    const stats = await fs.stat(target);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function readTextIfPresent(target: string): Promise<string | undefined> {
  try {
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) return undefined;
    return buffer.toString('utf8');
  } catch {
    return undefined;
  }
}

/** Line-numbered text output, matching `filesystem_read`'s text path. */
function formatWithLineNumbers(content: string, offset: number, maxLineLength: number): string {
  const lines = content.split('\n');
  const width = String(offset + lines.length - 1).length;
  return lines
    .map((line, index) => {
      const number = String(offset + index).padStart(width, ' ');
      const text = line.length > maxLineLength
        ? `${truncateEnd(line, maxLineLength)}... (truncated)`
        : line;
      return `${number}\t${text}`;
    })
    .join('\n');
}

interface ResolvedScopePath {
  /** Project-relative, forward slashes. */
  rel: string;
  /** Absolute path inside the real project. */
  realPath: string;
  /** Absolute path inside the edit folder. */
  editPath: string;
}

export function createOverlayFilesystemTools(options: OverlayFilesystemOptions): Record<string, Tool> {
  const scopeRoot = resolveRealPath(options.scopeRoot);
  const editRoot = resolveRealPath(options.editRoot);
  const { basePath, redact, context } = options;

  // Files the redactor changed on the way out of the project. Their staged diff
  // would be against the wrong base, so writes to them are refused.
  const redactedPaths = new Set<string>();

  const readConfigs: FilesystemPathConfig[] = [{ paths: [scopeRoot, editRoot], permissions: ['read'] }];
  const stageConfigs: FilesystemPathConfig[] = [{ path: editRoot, permissions: ['read', 'write', 'edit'] }];

  const innerRead = innerExecute<{ file_path: string; offset?: number | undefined; limit?: number | undefined }>(
    createReadTool(readConfigs, context),
  );
  const innerWrite = innerExecute<{ file_path: string; content: string }>(
    createWriteTool(stageConfigs, context),
  );
  const innerEdit = innerExecute<{
    file_path: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
  }>(createEditTool(stageConfigs, context));

  /**
   * Turn a model-supplied path into a project-relative path, refusing anything
   * that is not absolute, escapes the scope (including through a symlink), or
   * hits the deny list.
   */
  function resolveScopePath(inputPath: string): ResolvedScopePath | string {
    if (!inputPath || !path.isAbsolute(inputPath)) {
      return `Use an absolute path inside the project at ${scopeRoot}`;
    }
    const normalized = path.normalize(inputPath);
    // realpath (or the nearest existing ancestor for a new file) so a symlink
    // pointing out of the project cannot be used as a door.
    const real = resolveRealPath(normalized);
    if (!isPathInside(scopeRoot, real, { allowEqual: false })) {
      return `Path is outside the project at ${scopeRoot}: ${inputPath}`;
    }
    const rel = toPosix(path.relative(scopeRoot, real));
    const denied = denyReason(rel);
    if (denied) return `Cannot access ${rel}: ${denied}`;
    return { rel, realPath: path.join(scopeRoot, rel), editPath: path.join(editRoot, rel) };
  }

  /** Directory form of the same check; a directory may be the scope root itself. */
  function resolveScopeDir(inputPath: string): { rel: string; realPath: string; editPath: string } | string {
    if (!inputPath || !path.isAbsolute(inputPath)) {
      return `Use an absolute path inside the project at ${scopeRoot}`;
    }
    const real = resolveRealPath(path.normalize(inputPath));
    if (!isPathInside(scopeRoot, real)) {
      return `Path is outside the project at ${scopeRoot}: ${inputPath}`;
    }
    const rel = toPosix(path.relative(scopeRoot, real));
    if (rel.length > 0) {
      const denied = denyReason(rel);
      if (denied) return `Cannot access ${rel}: ${denied}`;
    }
    return {
      rel,
      realPath: rel ? path.join(scopeRoot, rel) : scopeRoot,
      editPath: rel ? path.join(editRoot, rel) : editRoot,
    };
  }

  /** Overlay view of one file: the staged copy when present, else the redacted real file. */
  async function overlayText(target: ResolvedScopePath): Promise<string | undefined> {
    const staged = await readTextIfPresent(target.editPath);
    if (staged !== undefined) return staged;
    const original = await readTextIfPresent(target.realPath);
    if (original === undefined) return undefined;
    const redacted = redact(original);
    if (redacted !== original) redactedPaths.add(target.rel);
    return redacted;
  }

  /**
   * Record `{ rel: sha256(realContent) }` the first time a path that exists in
   * the project is staged. Later writes keep the original base.
   */
  async function recordBaseHash(target: ResolvedScopePath): Promise<void> {
    const original = await fs.readFile(target.realPath, 'utf8').catch(() => undefined);
    if (original === undefined) return;
    await withFileMutationQueue(basePath, async () => {
      let existing: Record<string, string> = {};
      const raw = await fs.readFile(basePath, 'utf8').catch(() => undefined);
      if (raw !== undefined) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing = parsed as Record<string, string>;
          }
        } catch {
          existing = {};
        }
      }
      if (existing[target.rel] !== undefined) return;
      existing[target.rel] = sha256(original);
      await fs.mkdir(path.dirname(basePath), { recursive: true });
      await atomicWriteFile(basePath, `${JSON.stringify(existing, null, 2)}\n`);
    });
  }

  /** Refuse a mutation whose base cannot be trusted or whose path is off limits. */
  async function checkMutable(target: ResolvedScopePath): Promise<string | undefined> {
    if (redactedPaths.has(target.rel)) {
      return `Cannot modify ${target.rel}: it contains secrets, read-only`;
    }
    const staged = await isFile(target.editPath);
    if (staged) return undefined;
    const original = await readTextIfPresent(target.realPath);
    if (original === undefined) return undefined;
    if (redact(original) !== original) {
      redactedPaths.add(target.rel);
      return `Cannot modify ${target.rel}: it contains secrets, read-only`;
    }
    return undefined;
  }

  /** Union of the real tree and the staged tree below one directory. */
  async function overlayCandidates(
    dir: { rel: string; realPath: string; editPath: string },
    pattern: string | undefined,
  ): Promise<string[]> {
    const globPattern = pattern?.trim() || '**/*';
    const [real, staged] = await Promise.all([
      glob(globPattern, { cwd: dir.realPath, nodir: true, dot: true }).catch(() => [] as string[]),
      glob(globPattern, { cwd: dir.editPath, nodir: true, dot: true }).catch(() => [] as string[]),
    ]);
    const seen = new Set<string>();
    for (const entry of [...real, ...staged]) {
      const relative = toPosix(entry);
      const projectRelative = dir.rel ? `${dir.rel}/${relative}` : relative;
      if (denyReason(projectRelative)) continue;
      seen.add(relative);
    }
    return [...seen].sort();
  }

  const projectDescription = `The project root is ${scopeRoot}. Use absolute paths inside it; paths outside it are rejected.`;

  const readTool: Tool = {
    description: `Read file contents from the project.

Text files return their content with line numbers (cat -n style), honoring \`offset\`/\`limit\`. \`limit\` is a line count, not a character or byte count. Use bounded slices instead of returning several complete files together.

Image files (PNG, JPEG, GIF, WebP) and PDFs are returned as the actual image/document to the model. File type is detected by content, not extension. \`offset\`/\`limit\` are ignored for these.

${projectDescription}`,
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to read'),
      offset: z.number().optional().describe('Line number to start from (1-indexed). Ignored for image/PDF files.'),
      limit: z.number().optional().describe('Maximum number of lines to read, not characters or bytes. Ignored for image/PDF files.'),
    }),
    execute: async ({ file_path, offset, limit }: { file_path: string; offset?: number; limit?: number }): Promise<ToolOutput | MediaToolOutput> => {
      const resolved = resolveScopePath(file_path);
      if (typeof resolved === 'string') return errorOutput(resolved);

      // A staged copy wins outright and is served verbatim.
      if (await isFile(resolved.editPath)) {
        return innerRead({ file_path: resolved.editPath, offset, limit });
      }
      if (!(await isFile(resolved.realPath))) {
        return errorOutput(`File not found: ${path.join(scopeRoot, resolved.rel)}`);
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(resolved.realPath);
      } catch (error) {
        return errorOutput(toErrorMessage(error));
      }
      // Binary media carries no redactable text; hand it to the real read tool
      // so the modality/transport gates and size caps behave identically.
      if (sniffMediaType(buffer)) {
        return innerRead({ file_path: resolved.realPath, offset, limit });
      }

      const original = buffer.toString('utf8');
      const redacted = redact(original);
      if (redacted === original) {
        return innerRead({ file_path: resolved.realPath, offset, limit });
      }
      redactedPaths.add(resolved.rel);

      const { maxLines: defaultMaxLines, maxLineLength } = getToolOutputLimits();
      const lines = redacted.split('\n');
      const startLine = Math.max(1, offset || 1);
      const endLine = Math.min(startLine + (limit || defaultMaxLines) - 1, lines.length);
      const selected = lines.slice(startLine - 1, endLine);
      const header = endLine < lines.length
        ? `[Reading lines ${startLine}-${endLine} of ${lines.length} total]\n\n`
        : '';
      return { output: header + formatWithLineNumbers(selected.join('\n'), startLine, maxLineLength) };
    },
    toModelOutput: ({ output }) => {
      if (isMediaToolOutput(output)) {
        return { type: 'content', value: buildMediaContentValue(output._media, output.output) };
      }
      return { type: 'json', value: output };
    },
  };

  const listTool: Tool = {
    description: `List files recursively below a project directory.

Results are sorted and capped at ${OVERLAY_LIST_MAX_ENTRIES} entries.

${projectDescription}`,
    inputSchema: z.object({
      directory_path: z.string().describe('Absolute path to a directory in the project'),
      pattern: z.string().optional().describe('Optional glob relative to the directory, for example **/*.ts'),
      limit: z.number().int().positive().max(OVERLAY_LIST_MAX_ENTRIES).optional(),
    }),
    execute: async ({ directory_path, pattern, limit }: { directory_path: string; pattern?: string; limit?: number }): Promise<ToolOutput> => {
      const dir = resolveScopeDir(directory_path);
      if (typeof dir === 'string') return errorOutput(dir);
      const realExists = await fs.stat(dir.realPath).then((s) => s.isDirectory()).catch(() => false);
      const editExists = await fs.stat(dir.editPath).then((s) => s.isDirectory()).catch(() => false);
      if (!realExists && !editExists) return errorOutput(`Not a directory: ${path.join(scopeRoot, dir.rel)}`);
      const candidates = await overlayCandidates(dir, pattern);
      const cap = Math.min(limit ?? OVERLAY_LIST_MAX_ENTRIES, OVERLAY_LIST_MAX_ENTRIES);
      const files = candidates.slice(0, cap);
      return {
        output: JSON.stringify({
          success: true,
          directory: dir.rel ? path.join(scopeRoot, dir.rel) : scopeRoot,
          files,
          truncated: candidates.length > files.length,
        }),
      };
    },
  };

  const searchTool: Tool = {
    description: `Search text inside one exact file or across files below a project directory.

The query is a literal case-insensitive string. Provide exactly one of \`file_path\` or \`directory_path\`. Use \`context_lines\` to return a bounded, line-numbered excerpt around each match. Results are capped at ${OVERLAY_SEARCH_MAX_MATCHES} matches and the configured tool-output byte limit.

${projectDescription}`,
    inputSchema: z.object({
      directory_path: z.string().optional().describe('Absolute path to a project directory. Provide this or file_path, not both.'),
      file_path: z.string().optional().describe('Absolute path to one project text file. Provide this or directory_path, not both.'),
      query: z.string().min(1).max(500).describe('Literal text to find'),
      pattern: z.string().optional().describe('Optional file glob when using directory_path, for example **/*.{ts,tsx}'),
      limit: z.number().int().positive().max(OVERLAY_SEARCH_MAX_MATCHES).optional(),
      context_lines: z.number().int().min(0).max(OVERLAY_SEARCH_MAX_CONTEXT_LINES).optional()
        .describe(`Lines of context before and after each match, from 0 to ${OVERLAY_SEARCH_MAX_CONTEXT_LINES}`),
    }),
    execute: async ({ directory_path, file_path, query, pattern, limit, context_lines }: {
      directory_path?: string;
      file_path?: string;
      query: string;
      pattern?: string;
      limit?: number;
      context_lines?: number;
    }): Promise<ToolOutput> => {
      if ((directory_path === undefined) === (file_path === undefined)) {
        return errorOutput('Provide exactly one of directory_path or file_path');
      }

      let target: { directory?: string; file?: string };
      let candidates: Array<{ displayPath: string; target: ResolvedScopePath }>;
      if (file_path !== undefined) {
        const resolved = resolveScopePath(file_path);
        if (typeof resolved === 'string') return errorOutput(resolved);
        const source = (await fs.stat(resolved.editPath).catch(() => undefined))
          ?? (await fs.stat(resolved.realPath).catch(() => undefined));
        if (!source?.isFile()) return errorOutput(`Not a file: ${path.join(scopeRoot, resolved.rel)}`);
        target = { file: path.join(scopeRoot, resolved.rel) };
        candidates = [{ displayPath: path.basename(resolved.rel), target: resolved }];
      } else {
        const dir = resolveScopeDir(directory_path!);
        if (typeof dir === 'string') return errorOutput(dir);
        const relativePaths = await overlayCandidates(dir, pattern);
        target = { directory: dir.rel ? path.join(scopeRoot, dir.rel) : scopeRoot };
        candidates = relativePaths.map(relative => {
          const projectRelative = dir.rel ? `${dir.rel}/${relative}` : relative;
          return {
            displayPath: relative,
            target: {
              rel: projectRelative,
              realPath: path.join(scopeRoot, projectRelative),
              editPath: path.join(editRoot, projectRelative),
            },
          };
        });
      }

      const cap = Math.min(limit ?? OVERLAY_SEARCH_MAX_MATCHES, OVERLAY_SEARCH_MAX_MATCHES);
      const needle = query.toLocaleLowerCase();
      const contextLines = context_lines ?? 0;
      const matches: Array<{ path: string; line: number; text: string; excerpt?: string }> = [];
      const matchByteBudget = Math.max(0, getToolOutputLimits().maxBytes - 4_096);
      let matchBytes = 0;
      let truncated = false;
      search: for (const candidate of candidates) {
        const source = (await fs.stat(candidate.target.editPath).catch(() => undefined))
          ?? (await fs.stat(candidate.target.realPath).catch(() => undefined));
        if (!source || !source.isFile() || source.size > OVERLAY_SEARCH_MAX_FILE_BYTES) continue;
        const content = await overlayText(candidate.target);
        if (content === undefined) continue;
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          if (!line.toLocaleLowerCase().includes(needle)) continue;
          if (matches.length >= cap) {
            truncated = true;
            break search;
          }
          const start = Math.max(0, index - contextLines);
          const end = Math.min(lines.length, index + contextLines + 1);
          const match = {
            path: candidate.displayPath,
            line: index + 1,
            text: line.length > 300 ? `${truncateEnd(line, 300)}…` : line,
            ...(contextLines > 0 && {
              excerpt: formatWithLineNumbers(lines.slice(start, end).join('\n'), start + 1, 300),
            }),
          };
          const bytes = Buffer.byteLength(JSON.stringify(match), 'utf8') + 1;
          if (matchBytes + bytes > matchByteBudget) {
            truncated = true;
            break search;
          }
          matches.push(match);
          matchBytes += bytes;
        }
      }
      return {
        output: JSON.stringify({
          success: true,
          ...target,
          query,
          matches,
          truncated,
        }),
      };
    },
  };

  const writeTool: Tool = {
    description: `Write content to a file in the project. Creates the file if it does not exist, overwrites if it does.

Files up to ${Math.floor(CHANGESET_LIMITS.maxFileBytes / 1000)} KB of text only.

${projectDescription}`,
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to write'),
      content: z.string().describe('Content to write to the file'),
    }),
    execute: async ({ file_path, content }: { file_path: string; content: string }, callOptions?: { abortSignal?: AbortSignal }): Promise<ToolOutput> => {
      const resolved = resolveScopePath(file_path);
      if (typeof resolved === 'string') return errorOutput(resolved);
      if (content.includes('\u0000')) {
        return errorOutput(`Cannot write ${resolved.rel}: binary content is not supported, text files only`);
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > CHANGESET_LIMITS.maxFileBytes) {
        return errorOutput(`Cannot write ${resolved.rel}: ${humanBytes(bytes)} exceeds the ${humanBytes(CHANGESET_LIMITS.maxFileBytes)} per-file limit`);
      }
      // One transaction per staged path: the existence checks, base hash and
      // write must not interleave with a concurrent edit's seed or cleanup.
      // The 'overlay' namespace keeps this lock apart from the inner tool's
      // own per-file queue on the same path, which would otherwise deadlock.
      return withFileMutationQueue(resolved.editPath, async () => {
        const refusal = await checkMutable(resolved);
        if (refusal) return errorOutput(refusal);

        const existedInProject = await isFile(resolved.realPath);
        const existedStaged = await isFile(resolved.editPath);
        if (existedInProject) await recordBaseHash(resolved);

        await fs.mkdir(path.dirname(resolved.editPath), { recursive: true });
        // NEVER writes into scopeRoot: the destination is always under editRoot.
        const result = await innerWrite({ file_path: resolved.editPath, content }, callOptions);
        return rewritePathInResult(result, resolved, { created: !existedInProject && !existedStaged });
      }, 'overlay');
    },
  };

  const editTool: Tool = {
    description: `Edit a file by replacing exact strings with new strings. Uses fuzzy matching to tolerate minor whitespace/indentation/line-ending differences. Prefer this over rewriting a whole file with the write tool: it is faster and far cheaper on large files.

Make a single replacement with \`old_string\`/\`new_string\`, or several independent replacements in one call with the \`edits\` array. Batch edits are matched against one original snapshot and must not overlap. They are all-or-nothing: if any edit fails, the file is left unchanged.

${projectDescription}`,
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to edit'),
      old_string: z.string().optional().describe('Exact string to find and replace. Use this (with new_string) for a single edit; for multiple edits in one call use `edits` instead.'),
      new_string: z.string().optional().describe('String to replace `old_string` with.'),
      replace_all: z.boolean().optional().describe('Replace all occurrences of `old_string` (default: false, replaces first match only).'),
      edits: z.array(z.object({
        old_string: z.string().describe('Exact string to find and replace'),
        new_string: z.string().describe('String to replace with'),
        replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
      })).optional().describe('Batch of independent edits matched against the same original file snapshot. All-or-nothing: if any edit fails, is ambiguous, or overlaps another edit, the file is left unchanged.'),
    }),
    execute: async (args: {
      file_path: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
      edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
    }, callOptions?: { abortSignal?: AbortSignal }): Promise<ToolOutput> => {
      const resolved = resolveScopePath(args.file_path);
      if (typeof resolved === 'string') return errorOutput(resolved);
      // Same staged-path transaction as write: the staged-existence check,
      // seed, mutation and failure cleanup must see one consistent state.
      return withFileMutationQueue(resolved.editPath, async () => {
        const refusal = await checkMutable(resolved);
        if (refusal) return errorOutput(refusal);

        const alreadyStaged = await isFile(resolved.editPath);
        if (!alreadyStaged) {
          // Copy-on-write: seed the staged copy from the real file, then edit the
          // copy. NEVER writes into scopeRoot; the real file is only ever read.
          const original = await fs.readFile(resolved.realPath, 'utf8').catch(() => undefined);
          if (original === undefined) {
            return errorOutput(`File not found: ${path.join(scopeRoot, resolved.rel)}`);
          }
          await recordBaseHash(resolved);
          await fs.mkdir(path.dirname(resolved.editPath), { recursive: true });
          await atomicWriteFile(resolved.editPath, original);
        }

        const result = await innerEdit({ ...args, file_path: resolved.editPath }, callOptions);
        const parsed = parseJsonOutput(result);
        if (!alreadyStaged && parsed?.success === false) {
          // A failed edit must not leave a seeded copy behind: submit would then
          // report an unchanged file as a modification.
          await fs.rm(resolved.editPath, { force: true }).catch(() => undefined);
        }
        return rewritePathInResult(result, resolved, {});
      }, 'overlay');
    },
  };

  return {
    tools__filesystem_read: readTool,
    tools__filesystem_list: listTool,
    tools__filesystem_search: searchTool,
    tools__filesystem_write: writeTool,
    tools__filesystem_edit: editTool,
  };
}

function parseJsonOutput(result: ToolOutput | MediaToolOutput): Record<string, unknown> | undefined {
  if (typeof result.output !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(result.output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Replace the staged destination in a delegated result with the project path. */
function rewritePathInResult(
  result: ToolOutput | MediaToolOutput,
  resolved: ResolvedScopePath,
  overrides: Record<string, unknown>,
): ToolOutput {
  const parsed = parseJsonOutput(result);
  if (!parsed) return { output: String(result.output) };
  if ('path' in parsed) parsed.path = resolved.realPath;
  if (parsed.success === false) return { output: JSON.stringify(parsed) };
  return { output: JSON.stringify({ ...parsed, ...overrides }) };
}
