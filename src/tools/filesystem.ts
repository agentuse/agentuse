import type { Tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathValidator } from './path-validator.js';
import type { FilesystemPathConfig, ToolOutput, ToolErrorOutput } from './types.js';

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_LINE_LENGTH = 2000;

/**
 * Format file content with line numbers (cat -n style)
 */
function formatWithLineNumbers(content: string, offset: number = 1): string {
  const lines = content.split('\n');
  const maxLineNumWidth = String(offset + lines.length - 1).length;

  return lines
    .map((line, i) => {
      const lineNum = String(offset + i).padStart(maxLineNumWidth, ' ');
      // Truncate long lines
      const truncatedLine = line.length > DEFAULT_MAX_LINE_LENGTH
        ? line.slice(0, DEFAULT_MAX_LINE_LENGTH) + '... (truncated)'
        : line;
      return `${lineNum}\t${truncatedLine}`;
    })
    .join('\n');
}

/**
 * Create the filesystem read tool
 */
export function createReadTool(
  configs: FilesystemPathConfig[],
  projectRoot: string
): Tool {
  const validator = new PathValidator(configs, projectRoot);

  return {
    description: 'Read file contents from the filesystem. Returns content with line numbers.',
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to read'),
      offset: z.number().optional().describe('Line number to start from (1-indexed)'),
      limit: z.number().optional().describe('Maximum number of lines to read'),
    }),
    execute: async ({ file_path, offset, limit }: {
      file_path: string;
      offset?: number;
      limit?: number;
    }): Promise<ToolOutput> => {
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

        // Read file content
        const content = await fs.readFile(validation.resolvedPath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Apply offset and limit
        const startLine = Math.max(1, offset || 1);
        const maxLines = limit || DEFAULT_MAX_LINES;
        const endLine = Math.min(startLine + maxLines - 1, totalLines);

        const selectedLines = lines.slice(startLine - 1, endLine);
        const formattedContent = formatWithLineNumbers(selectedLines.join('\n'), startLine);

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
  };
}

/**
 * Create the filesystem write tool
 */
export function createWriteTool(
  configs: FilesystemPathConfig[],
  projectRoot: string
): Tool {
  const validator = new PathValidator(configs, projectRoot);

  return {
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
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
  projectRoot: string
): Tool {
  const validator = new PathValidator(configs, projectRoot);

  return {
    description: 'Edit a file by replacing an exact string with a new string. The old_string must match exactly.',
    inputSchema: z.object({
      file_path: z.string().describe('Absolute path to the file to edit'),
      old_string: z.string().describe('Exact string to find and replace'),
      new_string: z.string().describe('String to replace with'),
      replace_all: z.boolean().optional().describe('Replace all occurrences (default: false, replaces first only)'),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all }: {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }): Promise<ToolOutput> => {
      // Validate path
      const validation = validator.validate(file_path, 'edit');
      if (!validation.allowed) {
        const error: ToolErrorOutput = {
          success: false,
          error: validation.error || 'Path validation failed',
        };
        return { output: JSON.stringify(error) };
      }

      try {
        // Read current content
        const content = await fs.readFile(validation.resolvedPath, 'utf-8');

        // Check if old_string exists
        if (!content.includes(old_string)) {
          const error: ToolErrorOutput = {
            success: false,
            error: `String not found in file: "${old_string.slice(0, 50)}${old_string.length > 50 ? '...' : ''}"`,
          };
          return { output: JSON.stringify(error) };
        }

        // Count occurrences
        const occurrences = content.split(old_string).length - 1;

        // Check for ambiguous match when not replace_all
        if (!replace_all && occurrences > 1) {
          const error: ToolErrorOutput = {
            success: false,
            error: `Ambiguous match: found ${occurrences} occurrences. Use replace_all=true or provide more context in old_string.`,
          };
          return { output: JSON.stringify(error) };
        }

        // Perform replacement
        let newContent: string;
        let replacements: number;

        if (replace_all) {
          newContent = content.split(old_string).join(new_string);
          replacements = occurrences;
        } else {
          newContent = content.replace(old_string, new_string);
          replacements = 1;
        }

        // Write back
        await fs.writeFile(validation.resolvedPath, newContent, 'utf-8');

        return {
          output: JSON.stringify({
            success: true,
            path: validation.resolvedPath,
            replacements,
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
