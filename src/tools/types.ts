import { z } from 'zod';
import type { ToolOutputArtifactStream } from '../session/types.js';

// Zod schemas for validation
export const FilesystemPermissionSchema = z.enum(['read', 'write', 'edit']);

export const FilesystemPathConfigSchema = z.object({
  path: z.string().optional(),
  paths: z.array(z.string()).optional(),
  permissions: z.array(FilesystemPermissionSchema),
}).refine(
  (data) => data.path !== undefined || data.paths !== undefined,
  { message: 'Either "path" or "paths" must be specified' }
);

export const BashConfigSchema = z.object({
  commands: z.array(z.string()),
  timeout: z.number().positive().optional(),
  allowedPaths: z.array(z.string()).optional(),
});

export const ToolsConfigSchema = z.object({
  filesystem: z.array(FilesystemPathConfigSchema).optional(),
  bash: BashConfigSchema.optional(),
  await_human: z.boolean().optional(),
});

// Derive types from Zod schemas
export type FilesystemPermission = z.infer<typeof FilesystemPermissionSchema>;

/**
 * Whether a set of granted permissions satisfies a requested operation.
 *
 * Capability hierarchy is read < edit < write: `write` (create/overwrite any
 * file) is strictly stronger than `edit` (replace a substring in an existing
 * file), so granting `write` implies `edit`. This keeps the common
 * `[read, write]` grant working with both the write and edit tools, while
 * `edit` on its own remains a useful narrower grant (modify existing files,
 * cannot create or wholesale-overwrite).
 */
export function grantsPermission(
  granted: FilesystemPermission[],
  operation: FilesystemPermission
): boolean {
  if (granted.includes(operation)) return true;
  if (operation === 'edit' && granted.includes('write')) return true;
  return false;
}

export type FilesystemPathConfig = z.infer<typeof FilesystemPathConfigSchema>;
export type BashConfig = z.infer<typeof BashConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

// Path validation result
export interface PathValidationResult {
  allowed: boolean;
  resolvedPath: string;
  error?: string;
  matchedPattern?: string;
}

// Command validation result
export interface CommandValidationResult {
  allowed: boolean;
  error?: string;
  matchedPattern?: string;
}

// Tool output format (matches existing MCP tools pattern)
export interface ToolOutput {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ToolOutputArtifactSink {
  createStream(
    toolName: string,
    metadata?: Record<string, unknown>
  ): Promise<ToolOutputArtifactStream | undefined>;
}

// Error output format
export interface ToolErrorOutput {
  success: false;
  error: string;
}
