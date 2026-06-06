/**
 * Centralized, configurable tool-output truncation limits.
 *
 * Tool outputs are re-sent to the model on every subsequent turn, so a single
 * oversized result (a large diff, a verbose log) inflates input tokens for the
 * rest of the run. These limits cap how much of any one result reaches the
 * model. The defaults match the historical hardcoded values, so behaviour is
 * unchanged unless a power user opts to tune them.
 *
 * Resolution order per limit: environment variable -> built-in default.
 * The reader is defensive: a missing or malformed value falls back to the
 * default, so tools never fail because of bad config.
 *
 * Env vars:
 *   AGENTUSE_TOOL_MAX_OUTPUT_BYTES  bash stdout/stderr cap (bytes)      default 30720
 *   AGENTUSE_TOOL_MAX_LINES         read_file pagination/truncation cap default 2000
 *   AGENTUSE_TOOL_MAX_LINE_LENGTH   per-line cap before "... (truncated)" default 2000
 *   AGENTUSE_TOOL_OUTPUT_HEAD_RATIO fraction of the byte cap kept as head default 0.4
 */

// Built-in defaults — these match the pre-existing hardcoded constants, so the
// module is behaviour-preserving when no env vars are set.
export const DEFAULT_MAX_OUTPUT_BYTES = 30 * 1024; // bash.ts DEFAULT_MAX_OUTPUT
export const DEFAULT_MAX_LINES = 2000; // filesystem.ts DEFAULT_MAX_LINES
export const DEFAULT_MAX_LINE_LENGTH = 2000; // filesystem.ts DEFAULT_MAX_LINE_LENGTH
// Keep head (errors/context often surface early) and tail (most recent output)
// when truncating, dropping the middle. 0.4 head / 0.6 tail mirrors the split
// used by OpenCode / Hermes.
export const DEFAULT_HEAD_RATIO = 0.4;

export interface ToolOutputLimits {
  maxBytes: number;
  maxLines: number;
  maxLineLength: number;
  /** Fraction of maxBytes retained as head when truncating (0 < ratio < 1). */
  headRatio: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ratio(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

/**
 * Resolve tool-output limits from the environment, falling back to defaults.
 * Never throws.
 */
export function getToolOutputLimits(): ToolOutputLimits {
  return {
    maxBytes: positiveInt(process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    maxLines: positiveInt(process.env.AGENTUSE_TOOL_MAX_LINES, DEFAULT_MAX_LINES),
    maxLineLength: positiveInt(process.env.AGENTUSE_TOOL_MAX_LINE_LENGTH, DEFAULT_MAX_LINE_LENGTH),
    headRatio: ratio(process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO, DEFAULT_HEAD_RATIO),
  };
}

function truncationMarker(omitted: number, total: number): string {
  return `\n\n... [${omitted} chars truncated of ${total} total] ...\n\n`;
}

/**
 * Truncate a string to `maxBytes`, keeping a head and tail slice with a marker
 * describing what was dropped. Returns the input unchanged when within budget.
 */
export function truncateHeadTail(
  text: string,
  maxBytes: number,
  headRatio: number = DEFAULT_HEAD_RATIO,
): string {
  if (text.length <= maxBytes) return text;
  const headBytes = Math.floor(maxBytes * headRatio);
  const tailBytes = maxBytes - headBytes;
  const head = text.slice(0, headBytes);
  const tail = text.slice(text.length - tailBytes);
  return head + truncationMarker(text.length - maxBytes, text.length) + tail;
}

/**
 * Memory-bounded head+tail accumulator for streaming output (e.g. a child
 * process's stdout). Retains at most `maxBytes` of content — the first
 * `headBytes` and a rolling window of the last `tailBytes` — while counting
 * everything, so the middle of a runaway stream is dropped without buffering
 * it. `finalize()` reconstructs the output with a truncation marker when the
 * total exceeded the cap, or returns the full output verbatim when it didn't.
 */
export interface BoundedAccumulator {
  append(chunk: string): void;
  /** Total characters seen across all appends. */
  readonly total: number;
  /** True once total exceeded `maxBytes` and content was dropped. */
  readonly truncated: boolean;
  finalize(): string;
}

export function createBoundedAccumulator(
  maxBytes: number,
  headRatio: number = DEFAULT_HEAD_RATIO,
): BoundedAccumulator {
  const headBytes = Math.floor(maxBytes * headRatio);
  const tailBytes = maxBytes - headBytes;
  let head = '';
  let tail = '';
  let total = 0;

  function appendTail(s: string): void {
    tail += s;
    if (tail.length > tailBytes) {
      tail = tail.slice(tail.length - tailBytes);
    }
  }

  return {
    append(chunk: string): void {
      total += chunk.length;
      if (head.length < headBytes) {
        const room = headBytes - head.length;
        head += chunk.slice(0, room);
        const rest = chunk.slice(room);
        if (rest.length > 0) appendTail(rest);
      } else {
        appendTail(chunk);
      }
    },
    get total(): number {
      return total;
    },
    get truncated(): boolean {
      return total > maxBytes;
    },
    finalize(): string {
      // Within budget: head + tail is the full output, no marker, no drop.
      if (total <= maxBytes) return head + tail;
      return head + truncationMarker(total - maxBytes, total) + tail;
    },
  };
}
