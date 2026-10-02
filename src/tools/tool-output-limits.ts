/**
 * Centralized, configurable tool-output truncation limits.
 *
 * Tool outputs are re-sent to the model on every subsequent turn, so a single
 * oversized result (a large diff, a verbose log) inflates input tokens for the
 * rest of the run. These limits cap how much of any one result reaches the
 * model. Direct results have a smaller inline budget than tool-local capture
 * limits so the full value can move to durable result storage without bloating
 * every later model step.
 *
 * Resolution order per limit: environment variable -> built-in default.
 * The reader is defensive: a missing or malformed value falls back to the
 * default, so tools never fail because of bad config.
 *
 * Env vars:
 *   AGENTUSE_TOOL_INLINE_RESULT_BYTES model-facing inline result cap     default 10240
 *   AGENTUSE_RESULT_QUERY_BYTES       results tool query result cap      default 20480
 *   AGENTUSE_BASH_CAPTURE_BYTES       bash canonical capture cap          default 4194304
 *   AGENTUSE_TOOL_MAX_OUTPUT_BYTES    legacy tool output cap              default 30720
 *   AGENTUSE_TOOL_MAX_LINES           read_file pagination/truncation cap default 2000
 *   AGENTUSE_TOOL_MAX_LINE_LENGTH     per-line cap before "... (truncated)" default 2000
 *   AGENTUSE_TOOL_OUTPUT_HEAD_RATIO   fraction of the byte cap kept as head default 0.4
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 30 * 1024;
// Canonical Bash capture is persisted once and queried by resultId when needed,
// so it can be larger than output repeatedly sent to the model. Keep this
// aligned with Code Mode's default result-read ceiling.
export const DEFAULT_BASH_CAPTURE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_INLINE_RESULT_BYTES = 10 * 1024;
export const DEFAULT_RESULT_QUERY_BYTES = 20 * 1024;
export const DEFAULT_MAX_LINES = 2000; // filesystem.ts DEFAULT_MAX_LINES
export const DEFAULT_MAX_LINE_LENGTH = 2000; // filesystem.ts DEFAULT_MAX_LINE_LENGTH
// Keep head (errors/context often surface early) and tail (most recent output)
// when truncating, dropping the middle. 0.4 head / 0.6 tail mirrors the split
// used by OpenCode / Hermes.
export const DEFAULT_HEAD_RATIO = 0.4;

export interface ToolOutputLimits {
  /** Largest serialized tool result returned inline to the model. */
  inlineResultBytes: number;
  /** Largest intentional lookup returned inline by the results tool. */
  resultQueryBytes: number;
  /** Largest complete Bash result retained before falling back to an artifact. */
  bashCaptureBytes: number;
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
  const legacyOutputBytes = process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
  const inlineResultBytes = positiveInt(
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES,
    positiveInt(legacyOutputBytes, DEFAULT_INLINE_RESULT_BYTES),
  );
  return {
    inlineResultBytes,
    resultQueryBytes: positiveInt(
      process.env.AGENTUSE_RESULT_QUERY_BYTES,
      Math.max(DEFAULT_RESULT_QUERY_BYTES, inlineResultBytes),
    ),
    bashCaptureBytes: positiveInt(
      process.env.AGENTUSE_BASH_CAPTURE_BYTES,
      legacyOutputBytes === undefined
        ? DEFAULT_BASH_CAPTURE_BYTES
        : positiveInt(legacyOutputBytes, DEFAULT_BASH_CAPTURE_BYTES),
    ),
    maxBytes: positiveInt(legacyOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxLines: positiveInt(process.env.AGENTUSE_TOOL_MAX_LINES, DEFAULT_MAX_LINES),
    maxLineLength: positiveInt(process.env.AGENTUSE_TOOL_MAX_LINE_LENGTH, DEFAULT_MAX_LINE_LENGTH),
    headRatio: ratio(process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO, DEFAULT_HEAD_RATIO),
  };
}

export const MESSAGE_TRUNCATION_SUFFIX = '\n...(truncated)';

/**
 * Cap a display string at `maxLength`, appending `suffix` when it had to cut.
 *
 * `reserve` is how much of the budget the suffix is charged for, defaulting to
 * its own length so the result never exceeds `maxLength` — which is what the
 * CLI's fixed-width columns rely on. Callers pass it explicitly only to keep a
 * historical budget (see truncateForMessage).
 *
 * Shared by the Slack/channel message builders and the sessions CLI; each
 * previously kept its own copy.
 */
export function truncate(
  value: string,
  maxLength: number,
  suffix = MESSAGE_TRUNCATION_SUFFIX,
  reserve = suffix.length,
): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - reserve)) + suffix;
}

/**
 * Truncation for Slack and channel messages. The marker is 15 characters but
 * only 12 of the budget are reserved for it, which is what these message
 * builders have always done; the widths around them are tuned to it.
 */
export function truncateForMessage(value: string, maxLength: number): string {
  return truncate(value, maxLength, MESSAGE_TRUNCATION_SUFFIX, 12);
}

function truncationMarker(omitted: number, total: number): string {
  return `\n\n... [${omitted} chars truncated of ${total} total] ...\n\n`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Drop a high surrogate stranded at the end of a head slice. JS strings are
 * UTF-16, so slicing at an arbitrary index can cut an astral char (emoji,
 * many CJK extensions) between its surrogate pair. A head ending on a high
 * surrogate is a lone surrogate once a marker/boundary follows it — invalid
 * UTF-8 that providers like OpenAI reject with a 400.
 */
export function trimTrailingHighSurrogate(text: string): string {
  return text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))
    ? text.slice(0, -1)
    : text;
}

/** Drop a low surrogate stranded at the start of a tail slice (lone surrogate). */
export function trimLeadingLowSurrogate(text: string): string {
  return text.length > 0 && isLowSurrogate(text.charCodeAt(0))
    ? text.slice(1)
    : text;
}

/**
 * Keep the first `maxChars` UTF-16 characters, never leaving a lone surrogate
 * at the cut. Use for head-only character caps (e.g. per-line limits); for a
 * byte budget use truncateHeadTail.
 */
export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return trimTrailingHighSurrogate(text.slice(0, maxChars));
}

/**
 * Truncate a string to `maxBytes` of UTF-8, keeping a head and tail slice with
 * a marker describing what was dropped. Returns the input unchanged when
 * within budget. The marker counts characters, as it always has.
 *
 * The head and tail cut points are snapped off any lone surrogate so the
 * result is always valid UTF-16/UTF-8 even when the cut lands inside an emoji.
 */
export function truncateHeadTail(
  text: string,
  maxBytes: number,
  headRatio: number = DEFAULT_HEAD_RATIO,
): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const headBytes = Math.floor(maxBytes * headRatio);
  const tailBytes = maxBytes - headBytes;
  const head = utf8Prefix(text, headBytes);
  const tail = utf8Suffix(text, tailBytes);
  return head + truncationMarker(text.length - head.length - tail.length, text.length) + tail;
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
      // Within budget: head + tail is the full output, no marker, no drop. A
      // surrogate pair split across the head/tail boundary is rejoined here by
      // the direct concatenation, so no fix-up is needed.
      if (total <= maxBytes) return head + tail;
      // Truncated: a marker separates head and tail, so snap each side off any
      // lone surrogate (the cut can land inside an emoji during streaming).
      return trimTrailingHighSurrogate(head) + truncationMarker(total - maxBytes, total) + trimLeadingLowSurrogate(tail);
    },
  };
}

export interface ClampedToolResult {
  value: unknown;
  truncated: boolean;
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

const REUSABLE_PREVIEW_MAX_KEYS = 40;
const REUSABLE_PREVIEW_MAX_DEPTH = 2;

export interface ReusableResultPreview {
  preview: unknown;
  omitted: Record<string, string>;
}

function reusablePreviewJsonBytes(value: unknown): number {
  const json = stableJson(value);
  return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, 'utf8');
}

/** Longest head of `value` within `maxBytes` of UTF-8, never ending on a lone surrogate. */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = trimTrailingHighSurrogate(value.slice(0, middle));
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return trimTrailingHighSurrogate(value.slice(0, low));
}

/** Longest tail of `value` within `maxBytes` of UTF-8, never starting on a lone surrogate. */
function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = trimLeadingLowSurrogate(value.slice(value.length - middle));
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return trimLeadingLowSurrogate(value.slice(value.length - low));
}

function objectPath(path: string, key: string): string {
  const segment = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
  return path === '.' ? segment : `${path}${segment}`;
}

function arrayPath(path: string, index: number): string {
  return path === '.' ? `.[${index}]` : `${path}[${index}]`;
}

function buildReusablePreview(
  value: unknown,
  path: string,
  omitted: Record<string, string>,
  options: { depth: number; maxKeys: number; stringHeadBytes: number },
): unknown {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= options.stringHeadBytes) return value;
    const markerBytes = Buffer.byteLength('…', 'utf8');
    const head = utf8Prefix(value, Math.max(0, options.stringHeadBytes - markerBytes));
    omitted[path] = `${bytes - Buffer.byteLength(head, 'utf8')} bytes`;
    return `${head}…`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (options.depth <= 0) {
      omitted[path] = `${value.length} items`;
      return [];
    }
    const preview = [buildReusablePreview(
      value[0],
      arrayPath(path, 0),
      omitted,
      { ...options, depth: options.depth - 1 },
    )];
    if (value.length > 1) omitted[path] = `${value.length - 1} items`;
    return preview;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const preview: Record<string, unknown> = {};
    for (const [key, child] of entries.slice(0, options.maxKeys)) {
      const childPath = objectPath(path, key);
      if (options.depth > 0 || typeof child === 'string') {
        preview[key] = buildReusablePreview(child, childPath, omitted, {
          ...options,
          depth: Math.max(0, options.depth - 1),
        });
      } else if (Array.isArray(child)) {
        if (child.length > 0) omitted[childPath] = `${child.length} items`;
        preview[key] = [];
      } else if (child && typeof child === 'object') {
        const keyCount = Object.keys(child).length;
        if (keyCount > 0) omitted[childPath] = `${keyCount} keys`;
        preview[key] = {};
      } else {
        preview[key] = child;
      }
    }
    if (entries.length > options.maxKeys) {
      omitted[path] = `${entries.length - options.maxKeys} keys`;
    }
    return preview;
  }
  return value;
}

function reusablePreviewCandidate(
  value: unknown,
  maxKeys: number,
  stringHeadBytes: number,
): ReusableResultPreview {
  const omitted: Record<string, string> = {};
  const preview = buildReusablePreview(value, '.', omitted, {
    depth: REUSABLE_PREVIEW_MAX_DEPTH,
    maxKeys,
    stringHeadBytes,
  });
  return { preview, omitted };
}

function reusablePreview(value: unknown, maxBytes: number): ReusableResultPreview {
  const keyLimits = [REUSABLE_PREVIEW_MAX_KEYS, 20, 10, 5, 1, 0];
  for (const maxKeys of keyLimits) {
    let low = 0;
    let high = maxBytes;
    let best: ReusableResultPreview | undefined;
    while (low <= high) {
      const stringHeadBytes = Math.floor((low + high) / 2);
      const candidate = reusablePreviewCandidate(value, maxKeys, stringHeadBytes);
      if (reusablePreviewJsonBytes(candidate) <= maxBytes) {
        best = candidate;
        low = stringHeadBytes + 1;
      } else {
        high = stringHeadBytes - 1;
      }
    }
    if (best !== undefined) return best;
  }
  return { preview: null, omitted: { '.': `${reusablePreviewJsonBytes(value)} bytes` } };
}

/**
 * Build the one model-facing preview attached to a stored reusable result.
 * Text and JSON share one format: preview preserves a partial original value,
 * while omitted maps jq-style paths to the bytes, items, or keys left out.
 * `maxBytes` applies to both fields together; the dispatcher reserves the rest
 * of the inline budget for the result reference envelope.
 */
export function previewReusableResult(value: unknown, maxBytes: number): ReusableResultPreview {
  return reusablePreview(value, maxBytes);
}

/**
 * Clamp an arbitrary tool result before it is handed back to the model. Builtin
 * tools already try to stay concise, but MCP/custom/store tools can return very
 * large objects. When an object cannot be safely preserved within the byte
 * budget, return a small structured envelope with a truncated preview instead
 * of resending the entire payload on every later turn.
 */
export function clampToolResultForModel(
  value: unknown,
  options: Partial<Pick<ToolOutputLimits, 'maxBytes' | 'headRatio'>> = {},
): ClampedToolResult {
  const limits = getToolOutputLimits();
  const maxBytes = options.maxBytes ?? limits.inlineResultBytes;
  const headRatio = options.headRatio ?? limits.headRatio;

  if (typeof value === 'string') {
    const text = truncateHeadTail(value, maxBytes, headRatio);
    return { value: text, truncated: text !== value };
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.output === 'string') {
      const output = truncateHeadTail(objectValue.output, maxBytes, headRatio);
      return {
        value: output === objectValue.output
          ? value
          : {
              ...objectValue,
              output,
              metadata: {
                ...(typeof objectValue.metadata === 'object' && objectValue.metadata !== null
                  ? objectValue.metadata as Record<string, unknown>
                  : {}),
                truncated: true,
                originalChars: objectValue.output.length,
              },
            },
        truncated: output !== objectValue.output,
      };
    }
  }

  const json = stableJson(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    truncated: true,
    value: summarizeOversizedResult(value, json, maxBytes),
  };
}

/** Bytes of the structured summary an oversized result is replaced with. */
export const DEFAULT_OVERSIZED_PREVIEW_BYTES = 2048;
const SAMPLE_BYTES = 768;
const MAX_SUMMARY_KEYS = 40;

export interface OversizedResultSummary {
  truncated: true;
  bytes: number;
  omittedBytes: number;
  limitBytes: number;
  message: string;
  shape: unknown;
}

function sampleJson(value: unknown, budget: number): string {
  const json = stableJson(value) ?? String(value);
  const sample = utf8Prefix(json, budget);
  return sample === json ? json : `${sample}...`;
}

function jsonBytes(value: unknown): number {
  const json = stableJson(value);
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}

/**
 * Describe the shape of a value without shipping its contents: array lengths,
 * key lists, and one bounded sample element. Depth-limited so the summary is
 * itself small.
 */
function describeShape(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      kind: 'array',
      length: value.length,
      ...(value.length > 0 && {
        itemKeys: first && typeof first === 'object' && !Array.isArray(first)
          ? Object.keys(first as object).slice(0, MAX_SUMMARY_KEYS)
          : undefined,
        sample: sampleJson(first, SAMPLE_BYTES),
      }),
    };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const keys: Record<string, unknown> = {};
    for (const [key, child] of entries.slice(0, MAX_SUMMARY_KEYS)) {
      if (Array.isArray(child)) {
        keys[key] = depth > 0
          ? describeShape(child, depth - 1)
          : { kind: 'array', length: child.length };
      } else if (child && typeof child === 'object') {
        keys[key] = { kind: 'object', keys: Object.keys(child).slice(0, MAX_SUMMARY_KEYS), bytes: jsonBytes(child) };
      } else if (typeof child === 'string' && child.length > 80) {
        keys[key] = { kind: 'string', length: child.length, head: sampleJson(child, 80) };
      } else {
        keys[key] = child;
      }
    }
    return {
      kind: 'object',
      ...(entries.length > MAX_SUMMARY_KEYS && { keyCount: entries.length }),
      keys,
    };
  }
  return sampleJson(value, SAMPLE_BYTES);
}

/**
 * Replace an oversized structured result with a bounded description of what
 * it was, instead of a mid-JSON cut of its first N kilobytes.
 *
 * The cut was the worst shape for the model: near the full cap in size,
 * unparseable, and resent on every later turn. The summary keeps what the
 * model actually needs to write the next narrower call: counts, keys, one
 * sample element, and how much was dropped. The full value is still persisted
 * as a session artifact by the dispatcher for audit.
 */
export function summarizeOversizedResult(
  value: unknown,
  json: string,
  limitBytes: number,
  previewBytes: number = DEFAULT_OVERSIZED_PREVIEW_BYTES,
): OversizedResultSummary {
  const budget = Math.min(previewBytes, limitBytes);
  const bytes = Buffer.byteLength(json, 'utf8');
  let shape = describeShape(value, 1);
  if (jsonBytes(shape) > budget) shape = describeShape(value, 0);
  if (jsonBytes(shape) > budget) shape = sampleJson(json, Math.max(64, budget - 256));
  return {
    truncated: true,
    bytes,
    omittedBytes: bytes,
    limitBytes,
    message:
      `Result was ${bytes.toLocaleString('en-US')} bytes, over the ${limitBytes.toLocaleString('en-US')} byte model-context limit, so only its shape is shown. ` +
      'Do not retry the same call. Narrow the query, fetch one item by ID, or in code_exec do the filtering and return only the ids, fields, counts, and decisions the next step needs.',
    shape,
  };
}
