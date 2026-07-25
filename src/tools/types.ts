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

/**
 * A tool configuration error the author must fix (invalid value in agent
 * frontmatter). Unlike transient load failures, these must FAIL the run:
 * tools-loader rethrows this type instead of downgrading it to a warning,
 * so an agent never silently runs without a tool it was configured to have.
 */
export class ToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolConfigError';
  }
}

export const BashConfigSchema = z.object({
  // Optional: commands can also arrive from trusted skills (agentuse-lab#168) or
  // be gated-only, so a bash block may legitimately omit its own allowlist.
  commands: z.array(z.string()).optional().default([]),
  // Gated command patterns (same wildcard shape as `commands`, human-authored -
  // never model-authored). A gated command IS allowed to run (effective allowlist
  // is commands ∪ gated), but only when covered by a lease derived from the latest
  // approved await_human changes[]; an uncovered match is auto-denied with a
  // redirect to re-gate. A command matching both lists is gated (gated wins).
  // Structural fix for the pre-approval ghost-post class (agentuse-lab#165/#169).
  gated: z.array(z.string().min(1)).optional(),
  // Command timeout as a suffixed duration string ("30s", "2m", "500ms").
  // Bare numbers are rejected at tool creation (this field was historically
  // milliseconds while every sibling timeout is seconds - the ambiguity is
  // not worth keeping). The number type stays in the schema only so the
  // rejection can carry a corrective message + telemetry instead of a
  // generic zod type error.
  timeout: z.union([z.number().positive(), z.string()]).optional(),
  allowedPaths: z.array(z.string()).optional(),
});

export const ArtifactsConfigSchema = z.union([
  z.boolean(),
  z.object({
    // Override the default artifact directory (project-relative). Defaults to
    // `.agentuse/artifacts`.
    dir: z.string().optional(),
  }).strict(),
]);

export const ToolsConfigSchema = z.object({
  filesystem: z.array(FilesystemPathConfigSchema).optional(),
  bash: BashConfigSchema.optional(),
  await_human: z.boolean().optional(),
  // Dedicated artifact tools (tools__artifact_save + tools__artifact_list). When
  // set, the agent can save viewable, session-linked deliverables under
  // `.agentuse/artifacts/` without a broad filesystem-write grant.
  artifacts: ArtifactsConfigSchema.optional(),
  // record_metric: idempotent business-metric records into the reserved shared
  // "metrics" store, independent of the agent's own `store` config.
  metrics: z.boolean().optional(),
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
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>;
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

/**
 * Live view of a long-running tool call's output, for human surfaces only.
 *
 * The tail is bounded and lossy by design: it never reaches the model, and the
 * durable record stays the tool's final output (plus its full-output artifact).
 * Publishing must never throw and must never block the tool.
 */
export interface LiveToolOutputSink {
  /** Latest bounded tail of `callID`'s output so far. */
  publish(callID: string, tail: string): void;
}

/**
 * Tool-state metadata key holding a running call's latest output tail. It lives
 * in metadata rather than output so it never reaches the model: rehydration
 * only replays completed/error states.
 */
export const LIVE_OUTPUT_METADATA_KEY = 'liveOutput';

/**
 * Minimum gap between two live-output writes for one call. Matches the session
 * stream's live poll cadence: writing faster only churns the part file.
 */
export const LIVE_OUTPUT_INTERVAL_MS = 500;

/**
 * How much of the tail to keep. A long build prints megabytes and the part file
 * is rewritten whole on every update, so this is the real cost knob. The
 * complete output still reaches the model (bounded by the tool's own limits)
 * and, when truncated, the full-output artifact.
 */
export const LIVE_OUTPUT_MAX_CHARS = 4_000;

/**
 * How long a call must run before it publishes anything. Most bash calls finish
 * in well under a second, and previewing those would flash a tail into the
 * session view only to replace it with the real output a moment later.
 */
export const LIVE_OUTPUT_MIN_RUNTIME_MS = 2_000;

/**
 * Synchronous append-only sink for effect-layer audit records (tool execute
 * entry/exit, bash spawn/exit). Implemented by the runner's EffectWAL; the
 * append must never throw and must not depend on the stream consumer, so
 * effects stay visible even when a suspension abandons the stream mid-step.
 */
export interface EffectAuditSink {
  append(record: Record<string, unknown>): void;
}

// Error output format
export interface ToolErrorOutput {
  success: false;
  error: string;
}
