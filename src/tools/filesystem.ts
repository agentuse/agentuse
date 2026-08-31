import type { Tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { PathValidator, type PathResolverContext } from './path-validator.js';
import { fuzzyReplace } from './edit-replacers.js';
import { grantsPermission, type FilesystemPathConfig, type ToolOutput, type ToolErrorOutput } from './types.js';
import { getToolOutputLimits, truncateEnd } from './tool-output-limits.js';
import {
  sniffMediaType,
  mediaByteCap,
  humanBytes,
  buildMediaContentValue,
  isMediaToolOutput,
  mediaFilename,
  type InlineMedia,
  type MediaToolOutput,
} from './media.js';

// Absolute ceiling for a single filesystem_read. Well above the largest media
// cap (32MB PDF) and any realistic text read, so it only turns would-be OOM
// crashes into a clean error and never rejects a normal file.
const FILESYSTEM_READ_MAX_BYTES = 256 * 1024 * 1024;
const FILESYSTEM_LIST_MAX_ENTRIES = 500;
const FILESYSTEM_SEARCH_MAX_MATCHES = 100;
const FILESYSTEM_SEARCH_MAX_FILE_BYTES = 256 * 1024;

/**
 * Format file content with line numbers (cat -n style)
 */
function formatWithLineNumbers(content: string, offset: number = 1, maxLineLength: number): string {
  const lines = content.split('\n');
  const maxLineNumWidth = String(offset + lines.length - 1).length;

  return lines
    .map((line, i) => {
      const lineNum = String(offset + i).padStart(maxLineNumWidth, ' ');
      // Truncate long lines (surrogate-safe so an emoji at the cut never
      // becomes a lone surrogate / invalid UTF-8)
      const truncatedLine = line.length > maxLineLength
        ? truncateEnd(line, maxLineLength) + '... (truncated)'
        : line;
      return `${lineNum}\t${truncatedLine}`;
    })
    .join('\n');
}

/**
 * Resolve variable placeholders in a path pattern
 * Supported: ${root}, ${agentDir}, ${tmpDir}, ~
 */
function resolvePathVariables(pattern: string, context: PathResolverContext): string {
  let result = pattern
    .replace(/\$\{root\}/g, context.projectRoot)
    .replace(/\$\{tmpDir\}/g, context.tmpDir ?? os.tmpdir())
    .replace(/^~/, os.homedir());

  // Only replace ${agentDir} if it's defined
  if (context.agentDir) {
    result = result.replace(/\$\{agentDir\}/g, context.agentDir);
  }

  return result;
}

/**
 * Format path configurations for tool description
 */
function formatPathsForDescription(
  configs: FilesystemPathConfig[],
  permission: 'read' | 'write' | 'edit',
  context: PathResolverContext
): string {
  const relevantConfigs = configs.filter(c => grantsPermission(c.permissions, permission));
  if (relevantConfigs.length === 0) {
    return '  (none configured)';
  }

  const paths: string[] = [];
  for (const config of relevantConfigs) {
    if (config.path) {
      paths.push(`  - ${resolvePathVariables(config.path, context)}`);
    }
    if (config.paths) {
      for (const p of config.paths) {
        paths.push(`  - ${resolvePathVariables(p, context)}`);
      }
    }
  }
  return paths.join('\n');
}

/**
 * Create the filesystem read tool
 */
export function createReadTool(
  configs: FilesystemPathConfig[],
  context: PathResolverContext
): Tool {
  const validator = new PathValidator(configs, context);

  const allowedPaths = formatPathsForDescription(configs, 'read', context);
  const description = `Read file contents from the filesystem.

Text files return their content with line numbers (cat -n style), honoring \`offset\`/\`limit\`.

Image files (PNG, JPEG, GIF, WebP) and PDFs are returned as the actual image/document to the model, so you can read charts, screenshots, scanned pages and PDF documents directly. File type is detected by content, not extension. \`offset\`/\`limit\` are ignored for these. This only works on models that accept image/PDF input; on a text-only model an image/PDF read returns an error instead.

**You can only read files from these paths:**
${allowedPaths}

Use absolute paths within these directories. Other paths will be rejected.`;

  return {
    description,
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to read'),
      offset: z.number().optional().describe('Line number to start from (1-indexed). Ignored for image/PDF files.'),
      limit: z.number().optional().describe('Maximum number of lines to read. Ignored for image/PDF files.'),
    }),
    execute: async ({ file_path, offset, limit }: {
      file_path: string;
      offset?: number;
      limit?: number;
    }): Promise<ToolOutput | MediaToolOutput> => {
      // Validate path
      const validation = validator.validate(file_path, 'read');
      if (!validation.allowed) {
        const error: ToolErrorOutput = {
          success: false,
          error: validation.error || 'Path validation failed',
        };
        return { output: JSON.stringify(error) };
      }

      try {
        // Check if file exists
        const stats = await fs.stat(validation.resolvedPath);
        if (!stats.isFile()) {
          const error: ToolErrorOutput = {
            success: false,
            error: `Not a file: ${validation.resolvedPath}`,
          };
          return { output: JSON.stringify(error) };
        }

        // Guard on size BEFORE reading. fs.readFile buffers the whole file, so a
        // multi-hundred-MB file in an allowed directory would OOM the run (or
        // throw ERR_FS_FILE_TOO_LARGE > 2GB) before any media/line cap applies.
        if (stats.size > FILESYSTEM_READ_MAX_BYTES) {
          const error: ToolErrorOutput = {
            success: false,
            error: `File too large to read (${humanBytes(stats.size)}, max ${humanBytes(FILESYSTEM_READ_MAX_BYTES)}): ${validation.resolvedPath}`,
          };
          return { output: JSON.stringify(error) };
        }

        // Read the raw bytes once, then decide by magic number whether this is an
        // image/PDF (multimodal path) or plain text. Reading a Buffer and decoding
        // utf-8 is byte-for-byte equivalent to fs.readFile(path, 'utf-8'), so the
        // text path below is unchanged.
        const buf = await fs.readFile(validation.resolvedPath);
        const sniffed = sniffMediaType(buf);

        if (sniffed) {
          const mediaResult = buildMediaReadResult(buf, sniffed, validation.resolvedPath, {
            modelId: context.modelId,
            modelInputModalities: context.modelInputModalities,
            mediaToolResultSupport: context.mediaToolResultSupport,
            offset,
            limit,
          });
          return mediaResult;
        }

        // --- Text path (unchanged behavior) ---
        const content = buf.toString('utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Apply offset and limit
        const { maxLines: defaultMaxLines, maxLineLength } = getToolOutputLimits();
        const startLine = Math.max(1, offset || 1);
        const maxLines = limit || defaultMaxLines;
        const endLine = Math.min(startLine + maxLines - 1, totalLines);

        const selectedLines = lines.slice(startLine - 1, endLine);
        const formattedContent = formatWithLineNumbers(selectedLines.join('\n'), startLine, maxLineLength);

        // Add metadata header
        const header = endLine < totalLines
          ? `[Reading lines ${startLine}-${endLine} of ${totalLines} total]\n\n`
          : '';

        return { output: header + formattedContent };
      } catch (err) {
        const error: ToolErrorOutput = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return { output: JSON.stringify(error) };
      }
    },
    // Convert the tool result into what the model actually sees. Only the media
    // path is special; every other result reproduces the AI SDK's default for a
    // non-string output ({ type: 'json', value }) so text reads and JSON error
    // envelopes are byte-for-byte unchanged.
    toModelOutput: ({ output }) => {
      if (isMediaToolOutput(output)) {
        return {
          type: 'content',
          value: buildMediaContentValue(output._media, output.output),
        };
      }
      return { type: 'json', value: output };
    },
  };
}

/** List files below an already-authorized read root. This does not widen the
 * filesystem capability: every returned path is checked through the same
 * PathValidator used by filesystem_read. It gives tool-driven agents a bounded
 * way to choose what to inspect instead of requiring a precomputed file dump. */
export function createListTool(
  configs: FilesystemPathConfig[],
  context: PathResolverContext,
): Tool {
  const validator = new PathValidator(configs, context);
  return {
    description: `List files recursively below a read-authorized directory.

Results are sorted and capped at ${FILESYSTEM_LIST_MAX_ENTRIES} entries. Only paths already granted to filesystem_read can be listed.`,
    inputSchema: z.object({
      directory_path: z.string().describe('Absolute path to an authorized directory'),
      pattern: z.string().optional().describe('Optional glob relative to the directory, for example **/*.ts'),
      limit: z.number().int().positive().max(FILESYSTEM_LIST_MAX_ENTRIES).optional(),
    }),
    execute: async ({ directory_path, pattern, limit }: { directory_path: string; pattern?: string; limit?: number }): Promise<ToolOutput> => {
      const validation = validator.validate(directory_path, 'read');
      if (!validation.allowed) return { output: JSON.stringify({ success: false, error: validation.error || 'Path validation failed' }) };
      try {
        const stats = await fs.stat(validation.resolvedPath);
        if (!stats.isDirectory()) return { output: JSON.stringify({ success: false, error: `Not a directory: ${validation.resolvedPath}` }) };
        const cap = Math.min(limit ?? FILESYSTEM_LIST_MAX_ENTRIES, FILESYSTEM_LIST_MAX_ENTRIES);
        const candidates = (await glob(pattern?.trim() || '**/*', {
          cwd: validation.resolvedPath,
          nodir: true,
          dot: true,
        })).sort();
        const files: string[] = [];
        for (const relativePath of candidates) {
          const candidate = path.join(validation.resolvedPath, relativePath);
          const checked = validator.validate(candidate, 'read');
          if (!checked.allowed) continue;
          files.push(relativePath);
          if (files.length >= cap) break;
        }
        return { output: JSON.stringify({ success: true, directory: validation.resolvedPath, files, truncated: candidates.length > files.length }) };
      } catch (error) {
        return { output: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) };
      }
    },
  };
}

/** Search text files below an authorized read root. Reads are byte- and
 * result-bounded, and every candidate is revalidated so symlinks cannot escape
 * the configured capability. */
export function createSearchTool(
  configs: FilesystemPathConfig[],
  context: PathResolverContext,
): Tool {
  const validator = new PathValidator(configs, context);
  return {
    description: `Search text inside files below a read-authorized directory.

The query is a literal case-insensitive string. Results include path, line number, and a short matching line, capped at ${FILESYSTEM_SEARCH_MAX_MATCHES} matches.`,
    inputSchema: z.object({
      directory_path: z.string().describe('Absolute path to an authorized directory'),
      query: z.string().min(1).max(500).describe('Literal text to find'),
      pattern: z.string().optional().describe('Optional file glob, for example **/*.{ts,tsx}'),
      limit: z.number().int().positive().max(FILESYSTEM_SEARCH_MAX_MATCHES).optional(),
    }),
    execute: async ({ directory_path, query, pattern, limit }: { directory_path: string; query: string; pattern?: string; limit?: number }): Promise<ToolOutput> => {
      const validation = validator.validate(directory_path, 'read');
      if (!validation.allowed) return { output: JSON.stringify({ success: false, error: validation.error || 'Path validation failed' }) };
      try {
        const stats = await fs.stat(validation.resolvedPath);
        if (!stats.isDirectory()) return { output: JSON.stringify({ success: false, error: `Not a directory: ${validation.resolvedPath}` }) };
        const cap = Math.min(limit ?? FILESYSTEM_SEARCH_MAX_MATCHES, FILESYSTEM_SEARCH_MAX_MATCHES);
        const candidates = (await glob(pattern?.trim() || '**/*', {
          cwd: validation.resolvedPath,
          nodir: true,
          dot: true,
        })).sort();
        const needle = query.toLocaleLowerCase();
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const relativePath of candidates) {
          if (matches.length >= cap) break;
          const candidate = path.join(validation.resolvedPath, relativePath);
          const checked = validator.validate(candidate, 'read');
          if (!checked.allowed) continue;
          let stat;
          try { stat = await fs.stat(checked.resolvedPath); } catch { continue; }
          if (!stat.isFile() || stat.size > FILESYSTEM_SEARCH_MAX_FILE_BYTES) continue;
          let content: string;
          try {
            const buffer = await fs.readFile(checked.resolvedPath);
            if (buffer.includes(0)) continue;
            content = buffer.toString('utf8');
          } catch { continue; }
          const lines = content.split('\n');
          for (let index = 0; index < lines.length && matches.length < cap; index += 1) {
            const line = lines[index]!;
            if (!line.toLocaleLowerCase().includes(needle)) continue;
            matches.push({ path: relativePath, line: index + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
          }
        }
        return { output: JSON.stringify({ success: true, directory: validation.resolvedPath, query, matches, truncated: matches.length >= cap }) };
      } catch (error) {
        return { output: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) };
      }
    },
  };
}

/**
 * Build the tool result for an image/PDF read: enforce the capability gate and
 * size cap, then carry the base64 on the `_media` sibling. Returns a text error
 * envelope (as a plain ToolOutput) when the model can't accept the media or the
 * file is too large.
 */
function buildMediaReadResult(
  buf: Buffer,
  sniffed: { mediaType: string; kind: 'image' | 'pdf' },
  resolvedPath: string,
  opts: {
    modelId?: string | undefined;
    modelInputModalities?: string[] | undefined;
    mediaToolResultSupport?: { image: boolean; pdf: boolean } | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }
): ToolOutput | MediaToolOutput {
  const filename = mediaFilename(resolvedPath);
  const kindLabel = sniffed.kind === 'pdf' ? 'PDF' : 'image';
  const model = opts.modelId ? `model ${opts.modelId}` : 'the current model';

  // Modality gate: does the model accept this input at all? Only block when the
  // registry POSITIVELY says it lacks the modality. Unknown model -> attempt.
  const modalities = opts.modelInputModalities;
  if (modalities && !modalities.includes(sniffed.kind)) {
    const error: ToolErrorOutput = {
      success: false,
      error: `${filename} is ${kindLabel} (${sniffed.mediaType}), but ${model} does not accept ${sniffed.kind} input. Cannot read this file. Extract or convert it to text first, or run on a ${sniffed.kind}-capable model.`,
    };
    return { output: JSON.stringify(error) };
  }

  // Transport gate: even a vision-capable model can be on a wire that cannot
  // carry the media in a tool result (OpenAI Chat/OpenRouter would stringify it;
  // Bedrock throws on a PDF). Emitting a media part there would send base64 as
  // text or crash the run, so return a text error instead.
  const transport = opts.mediaToolResultSupport;
  if (transport && !transport[sniffed.kind]) {
    const error: ToolErrorOutput = {
      success: false,
      error: `${filename} is ${kindLabel} (${sniffed.mediaType}), and ${model} can reason over ${sniffed.kind}s, but its provider/transport cannot deliver ${sniffed.kind === 'pdf' ? 'a PDF' : 'an image'} inside a tool result. Read it as text, or run on Anthropic or native OpenAI where ${sniffed.kind} tool results are supported.`,
    };
    return { output: JSON.stringify(error) };
  }

  // Size guardrail (raw bytes, before base64 inflation).
  const cap = mediaByteCap(sniffed.kind);
  if (buf.length > cap) {
    const error: ToolErrorOutput = {
      success: false,
      error: `${filename} is ${humanBytes(buf.length)}, which exceeds the ${humanBytes(cap)} limit for ${sniffed.kind} input. Reduce or split the file before reading.`,
    };
    return { output: JSON.stringify(error) };
  }

  // offset/limit are line-based and meaningless for binary media.
  const ignoredPaging = opts.offset !== undefined || opts.limit !== undefined
    ? ' (offset/limit ignored for binary media)'
    : '';

  const media: InlineMedia = {
    kind: sniffed.kind,
    mediaType: sniffed.mediaType,
    data: buf.toString('base64'),
    bytes: buf.length,
    filename,
    path: resolvedPath,
  };

  const caption = `[Read ${kindLabel} ${filename} (${sniffed.mediaType}, ${humanBytes(buf.length)})${ignoredPaging}. Content provided to the model as ${sniffed.kind === 'pdf' ? 'a document' : 'an image'}.]`;

  return { output: caption, _media: media } satisfies MediaToolOutput;
}

/**
 * Create the filesystem write tool
 */
export function createWriteTool(
  configs: FilesystemPathConfig[],
  context: PathResolverContext
): Tool {
  const validator = new PathValidator(configs, context);

  const allowedPaths = formatPathsForDescription(configs, 'write', context);
  const description = `Write content to a file. Creates the file if it does not exist, overwrites if it does.

**You must write files to these paths:**
${allowedPaths}

Use absolute paths within these directories. Other paths will be rejected.`;

  return {
    description,
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to write'),
      content: z.string().describe('Content to write to the file'),
    }),
    execute: async ({ file_path, content }: {
      file_path: string;
      content: string;
    }): Promise<ToolOutput> => {
      // Validate path
      const validation = validator.validate(file_path, 'write');
      if (!validation.allowed) {
        const error: ToolErrorOutput = {
          success: false,
          error: validation.error || 'Path validation failed',
        };
        return { output: JSON.stringify(error) };
      }

      try {
        // Ensure parent directory exists
        const dir = path.dirname(validation.resolvedPath);
        await fs.mkdir(dir, { recursive: true });

        // Check if file exists (for metadata)
        let created = false;
        try {
          await fs.access(validation.resolvedPath);
        } catch {
          created = true;
        }

        // Write file
        await fs.writeFile(validation.resolvedPath, content, 'utf-8');

        return {
          output: JSON.stringify({
            success: true,
            path: validation.resolvedPath,
            bytesWritten: Buffer.byteLength(content, 'utf-8'),
            created,
          }),
        };
      } catch (err) {
        const error: ToolErrorOutput = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return { output: JSON.stringify(error) };
      }
    },
  };
}

/**
 * Create the filesystem edit tool
 */
export function createEditTool(
  configs: FilesystemPathConfig[],
  context: PathResolverContext
): Tool {
  const validator = new PathValidator(configs, context);

  const allowedPaths = formatPathsForDescription(configs, 'edit', context);
  const description = `Edit a file by replacing exact strings with new strings. Uses fuzzy matching to tolerate minor whitespace/indentation/line-ending differences. Prefer this over rewriting a whole file with the write tool: it is faster and far cheaper on large files.

Make a single replacement with \`old_string\`/\`new_string\`, or several in one call with the \`edits\` array (applied in order, each to the result of the previous; all-or-nothing — if any edit fails to match, the file is left unchanged).

**You can only edit files in these paths:**
${allowedPaths}

Use absolute paths within these directories. Other paths will be rejected.`;

  const singleEditError = (error: string): ToolOutput => ({
    output: JSON.stringify({ success: false, error } satisfies ToolErrorOutput),
  });

  return {
    description,
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to edit'),
      old_string: z.string().optional().describe('Exact string to find and replace. Use this (with new_string) for a single edit; for multiple edits in one call use `edits` instead.'),
      new_string: z.string().optional().describe('String to replace `old_string` with.'),
      replace_all: z.boolean().optional().describe('Replace all occurrences of `old_string` (default: false, replaces first match only).'),
      edits: z.array(z.object({
        old_string: z.string().describe('Exact string to find and replace'),
        new_string: z.string().describe('String to replace with'),
        replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
      })).optional().describe('Batch of edits applied sequentially, each to the result of the previous one. Use this instead of the top-level old_string/new_string to change several spans in one call. All-or-nothing: if any edit fails to match, the file is left unchanged.'),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all, edits }: {
      file_path: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
      edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
    }): Promise<ToolOutput> => {
      // Validate path
      const validation = validator.validate(file_path, 'edit');
      if (!validation.allowed) {
        return singleEditError(validation.error || 'Path validation failed');
      }

      // Normalize input into an ordered list of edits, accepting either the
      // single old_string/new_string form or the edits[] batch form.
      const usingBatch = Array.isArray(edits) && edits.length > 0;
      const usingSingle = old_string !== undefined;
      if (usingBatch && usingSingle) {
        return singleEditError('Provide either `edits` or `old_string`/`new_string`, not both.');
      }
      if (!usingBatch && !usingSingle) {
        return singleEditError('Provide `old_string`/`new_string` for a single edit, or a non-empty `edits` array.');
      }
      const editList = usingBatch
        ? edits!
        : [{ old_string: old_string!, new_string: new_string ?? '', replace_all }];

      try {
        // Read current content once, apply all edits in memory, write once.
        let content = await fs.readFile(validation.resolvedPath, 'utf-8');
        const applied: { replacements: number; matchStrategy: string }[] = [];

        for (let i = 0; i < editList.length; i++) {
          const e = editList[i];
          const result = fuzzyReplace(content, e.old_string, e.new_string, e.replace_all);

          if (!result.success) {
            // Atomic: nothing has been written yet, so the file is untouched.
            const where = usingBatch ? `Edit ${i + 1} of ${editList.length} failed: ` : '';
            return singleEditError(`${where}${result.error}${usingBatch ? ' (file left unchanged)' : ''}`);
          }

          // Count replacements against the pre-edit content for this step.
          const replacements = e.replace_all
            ? content.split(result.matchedString).length - 1
            : 1;
          content = result.newContent;
          applied.push({ replacements, matchStrategy: result.replacerUsed });
        }

        // Write back once, after every edit has matched.
        await fs.writeFile(validation.resolvedPath, content, 'utf-8');

        if (usingBatch) {
          return {
            output: JSON.stringify({
              success: true,
              path: validation.resolvedPath,
              editsApplied: applied.length,
              replacements: applied.reduce((n, a) => n + a.replacements, 0),
              strategies: applied.map(a => a.matchStrategy),
            }),
          };
        }

        // Single-edit form keeps its original output shape for compatibility.
        return {
          output: JSON.stringify({
            success: true,
            path: validation.resolvedPath,
            replacements: applied[0].replacements,
            matchStrategy: applied[0].matchStrategy,
          }),
        };
      } catch (err) {
        return singleEditError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
