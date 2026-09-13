import { createHash } from 'crypto';

const RESULT_ID_PATTERN = /^result_([0-9A-HJKMNP-TV-Z]{26})_([0-9A-HJKMNP-TV-Z]{26})$/;
const INPUT_PREVIEW_CHARS = 256;

export interface CodeModeResultReference {
  resultId: string;
  tool: string;
  inputHash: string;
  inputPreview: string;
  bytes: number;
  kind: 'text' | 'json' | 'unknown';
  capabilities: {
    read: boolean;
    grep: boolean;
    jq: boolean;
  };
  completedAt: number;
}

export type CodeModeResultMetadata = Pick<
  CodeModeResultReference,
  'inputHash' | 'inputPreview' | 'bytes' | 'kind' | 'capabilities'
>;

export interface CodeModeResultIndexEntry extends CodeModeResultReference {
  messageId: string;
  partId: string;
}

export function codeModeResultId(messageId: string, partId: string): string {
  return `result_${messageId}_${partId}`;
}

export function parseCodeModeResultId(resultId: string): { messageId: string; partId: string } | undefined {
  const match = RESULT_ID_PATTERN.exec(resultId);
  if (!match) return undefined;
  return { messageId: match[1], partId: match[2] };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)])
    );
  }
  return value;
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(sortJson(value));
  return serialized ?? 'null';
}

export function describeCodeModeResult(input: {
  resultId: string;
  tool: string;
  toolInput: unknown;
  output: unknown;
  completedAt: number;
}): CodeModeResultReference {
  const serializedInput = serialize(input.toolInput);
  const serializedOutput = JSON.stringify(input.output) ?? 'null';
  return {
    resultId: input.resultId,
    tool: input.tool,
    ...describeCodeModeResultFromSerialized({
      serializedInput,
      serializedOutput,
      output: input.output,
      readable: true,
    }),
    completedAt: input.completedAt,
  };
}

export function describeCodeModeResultFromSerialized(input: {
  serializedInput: string;
  serializedOutput: string;
  output: unknown;
  readable: boolean;
}): CodeModeResultMetadata {
  let canonicalInput = input.serializedInput;
  try {
    canonicalInput = serialize(JSON.parse(input.serializedInput));
  } catch {
    // The Code Mode bridge accepts JSON only. Preserve the original text if a
    // low-level caller supplies malformed input so the diagnostic stays useful.
  }
  return {
    inputHash: createHash('sha256').update(canonicalInput).digest('hex').slice(0, 16),
    inputPreview: canonicalInput.length <= INPUT_PREVIEW_CHARS
      ? canonicalInput
      : `${canonicalInput.slice(0, INPUT_PREVIEW_CHARS)}…`,
    bytes: Buffer.byteLength(input.serializedOutput, 'utf8'),
    kind: typeof input.output === 'string' ? 'text' : 'json',
    capabilities: {
      read: input.readable,
      grep: typeof input.output === 'string',
      jq: typeof input.output !== 'string',
    },
  };
}
