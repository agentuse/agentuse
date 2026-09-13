import { Worker } from 'node:worker_threads';

const MAX_PATTERN_CHARS = 4_096;
const MAX_EXPRESSION_CHARS = 8_192;
const MAX_CONTEXT_LINES = 10;
const MAX_MATCHES = 500;
const MAX_EXCERPT_CHARS = 2_048;
const MAX_JQ_OUTPUT_BYTES = 1_000_000;
const MAX_QUERY_INPUT_BYTES = 16_000_000;
const MAX_JQ_ERROR_CHARS = 16_384;
const JQ_TIMEOUT_MS = 10_000;
const JQ_WORKER_MODULE_URL = import.meta.resolve('jq-wasm/inline');

const JQ_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { loadJq } = await import(workerData.moduleUrl);
  const jq = await loadJq();
  const values = [];
  let outputBytes = 0;
  let truncated = false;
  for (const value of jq.stream(workerData.input, workerData.expression)) {
    if (values.length >= workerData.limit) {
      truncated = true;
      break;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('jq returned a non-JSON value');
    outputBytes += Buffer.byteLength(serialized, 'utf8');
    if (outputBytes > workerData.maxOutputBytes) {
      throw new Error('RESULT_QUERY_TOO_LARGE: jq output exceeds ' + workerData.maxOutputBytes + ' bytes');
    }
    values.push(value);
  }
  parentPort.postMessage({ ok: true, value: JSON.stringify({ values, truncated }) });
})().catch((error) => {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  parentPort.postMessage({ ok: false, error: message.slice(0, workerData.maxErrorChars) });
});
`;

export interface CodeModeGrepOptions {
  pattern: string;
  caseSensitive?: boolean;
  limit?: number;
  contextLines?: number;
}

export interface CodeModeGrepMatch {
  line: number;
  column: number;
  excerpt: string;
  before: string[];
  after: string[];
}

export interface CodeModeGrepResult {
  matches: CodeModeGrepMatch[];
  truncated: boolean;
}

export interface CodeModeJqOptions {
  limit?: number;
}

export interface CodeModeJqResult {
  values: unknown[];
  truncated: boolean;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || (selected as number) < minimum || (selected as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected as number;
}

function excerpt(line: string, column: number): string {
  if (line.length <= MAX_EXCERPT_CHARS) return line;
  const half = Math.floor(MAX_EXCERPT_CHARS / 2);
  const start = Math.max(0, Math.min(column - half, line.length - MAX_EXCERPT_CHARS));
  const end = Math.min(line.length, start + MAX_EXCERPT_CHARS);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

function contextExcerpt(line: string): string {
  return line.length <= MAX_EXCERPT_CHARS ? line : `${line.slice(0, MAX_EXCERPT_CHARS)}…`;
}

function jqProgramWithoutStringsOrComments(expression: string): string {
  let cleaned = '';
  let quoted = false;
  let escaped = false;
  let comment = false;
  for (const character of expression) {
    if (comment) {
      if (character === '\n') {
        comment = false;
        cleaned += '\n';
      } else {
        cleaned += ' ';
      }
      continue;
    }
    if (quoted) {
      cleaned += ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '#') {
      comment = true;
      cleaned += ' ';
    } else if (character === '"') {
      quoted = true;
      cleaned += ' ';
    } else {
      cleaned += character;
    }
  }
  return cleaned;
}

function assertSandboxedJqProgram(expression: string): void {
  const code = jqProgramWithoutStringsOrComments(expression);
  if (/\$ENV\b|(^|[^\w.])(?:env|include|import|module)\b/.test(code)) {
    throw new Error('RESULT_JQ_UNSAFE: environment and module access are unavailable in results.jq()');
  }
}

/** Literal, line-oriented search over one stored text result. */
export function grepCodeModeText(text: string, options: CodeModeGrepOptions): CodeModeGrepResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_QUERY_INPUT_BYTES) {
    throw new Error(`RESULT_QUERY_TOO_LARGE: stored text exceeds ${MAX_QUERY_INPUT_BYTES} query input bytes`);
  }
  if (!options || typeof options !== 'object') throw new Error('RESULT_GREP_INPUT: options must be an object');
  if (typeof options.pattern !== 'string' || options.pattern.length === 0) {
    throw new Error('RESULT_GREP_INPUT: pattern must be a non-empty string');
  }
  if (options.pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`RESULT_GREP_INPUT: pattern exceeds ${MAX_PATTERN_CHARS} characters`);
  }
  if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') {
    throw new Error('RESULT_GREP_INPUT: caseSensitive must be a boolean');
  }
  const limit = boundedInteger(options.limit, 20, 1, MAX_MATCHES, 'RESULT_GREP_INPUT: limit');
  const contextLines = boundedInteger(
    options.contextLines,
    0,
    0,
    MAX_CONTEXT_LINES,
    'RESULT_GREP_INPUT: contextLines'
  );
  const lines = text.split('\n');
  const needle = options.caseSensitive === false ? options.pattern.toLowerCase() : options.pattern;
  const matches: CodeModeGrepMatch[] = [];
  let truncated = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const haystack = options.caseSensitive === false ? line.toLowerCase() : line;
    const column = haystack.indexOf(needle);
    if (column < 0) continue;
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    matches.push({
      line: index + 1,
      column: column + 1,
      excerpt: excerpt(line, column),
      before: lines.slice(Math.max(0, index - contextLines), index).map(contextExcerpt),
      after: lines.slice(index + 1, index + 1 + contextLines).map(contextExcerpt),
    });
  }

  return { matches, truncated };
}

/** Run a real jq filter without a shell and return its ordered output stream. */
export async function queryCodeModeJson(
  value: unknown,
  expression: string,
  options: CodeModeJqOptions = {},
  signal?: AbortSignal
): Promise<CodeModeJqResult> {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new Error('RESULT_JQ_INPUT: expression must be a non-empty string');
  }
  if (expression.length > MAX_EXPRESSION_CHARS) {
    throw new Error(`RESULT_JQ_INPUT: expression exceeds ${MAX_EXPRESSION_CHARS} characters`);
  }
  assertSandboxedJqProgram(expression);
  if (!options || typeof options !== 'object') throw new Error('RESULT_JQ_INPUT: options must be an object');
  const limit = boundedInteger(options.limit, 100, 1, MAX_MATCHES, 'RESULT_JQ_INPUT: limit');
  const input = JSON.stringify(value);
  if (input === undefined) throw new Error('RESULT_CORRUPT: stored result is not JSON-serializable');
  if (Buffer.byteLength(input, 'utf8') > MAX_QUERY_INPUT_BYTES) {
    throw new Error(`RESULT_QUERY_TOO_LARGE: stored JSON exceeds ${MAX_QUERY_INPUT_BYTES} query input bytes`);
  }
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Code Mode execution aborted');

  return await new Promise<CodeModeJqResult>((resolve, reject) => {
    const worker = new Worker(JQ_WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: JQ_WORKER_MODULE_URL,
        input,
        expression,
        limit,
        maxOutputBytes: MAX_JQ_OUTPUT_BYTES,
        maxErrorChars: MAX_JQ_ERROR_CHARS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 2,
      },
    });
    let settled = false;
    const finish = (result: CodeModeJqResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const stop = (): void => {
      void worker.terminate().catch(() => undefined);
    };
    const onAbort = (): void => {
      stop();
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Code Mode execution aborted'));
    };
    const timer = setTimeout(() => {
      stop();
      finish(new Error(`RESULT_JQ_TIMEOUT: jq exceeded ${JQ_TIMEOUT_MS}ms`));
    }, JQ_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (message: unknown) => {
      if (settled) return;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        stop();
        finish(new Error('RESULT_JQ_ERROR: jq worker returned an invalid response'));
        return;
      }
      const response = message as { ok?: unknown; value?: unknown; error?: unknown };
      if (response.ok !== true || typeof response.value !== 'string') {
        const detail = typeof response.error === 'string' ? response.error : 'jq query failed';
        finish(new Error(detail.startsWith('RESULT_') ? detail : `RESULT_JQ_ERROR: ${detail}`));
        return;
      }
      try {
        const parsed = JSON.parse(response.value) as CodeModeJqResult;
        finish(parsed);
      } catch {
        finish(new Error('RESULT_JQ_ERROR: jq worker returned invalid JSON output'));
      }
    });
    worker.on('error', error => {
      finish(new Error(`RESULT_JQ_ERROR: ${error.message}`));
    });
    worker.on('exit', code => {
      if (!settled) {
        finish(new Error(`RESULT_JQ_ERROR: jq worker exited with status ${code}`));
      }
    });
  });
}
