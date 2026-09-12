interface SourceMapV3 {
  version: number;
  sources: string[];
  mappings: string;
}

interface MappingPoint {
  generatedColumn: number;
  source: number;
  originalLine: number;
  originalColumn: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map([...BASE64].map((char, index) => [char, index]));

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) throw new Error('Invalid source map VLQ');
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    values.push((value >> 1) * (negative ? -1 : 1));
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error('Incomplete source map VLQ');
  return values;
}

/**
 * Map one generated position through an esbuild v3 source map. The Code Mode
 * transform has one source and no sections, so a small local decoder avoids a
 * runtime dependency solely for error display.
 */
export function mapCodeModePosition(
  sourceMapJson: string,
  generatedLine: number,
  generatedColumn: number,
): { line: number; column: number } | undefined {
  let map: SourceMapV3;
  try {
    map = JSON.parse(sourceMapJson) as SourceMapV3;
  } catch {
    return undefined;
  }
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string') return undefined;

  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  const lines = map.mappings.split(';');
  const line = lines[generatedLine - 1];
  if (line === undefined) return undefined;

  let generated = 0;
  let best: MappingPoint | undefined;
  for (const raw of line.split(',')) {
    if (!raw) continue;
    let fields: number[];
    try {
      fields = decodeVlq(raw);
    } catch {
      return undefined;
    }
    generated += fields[0] ?? 0;
    if (fields.length >= 4) {
      source += fields[1] ?? 0;
      originalLine += fields[2] ?? 0;
      originalColumn += fields[3] ?? 0;
      if (generated <= generatedColumn - 1) {
        best = { generatedColumn: generated, source, originalLine, originalColumn };
      }
    }
    if (generated > generatedColumn - 1) break;
  }
  if (!best || best.source < 0 || best.source >= map.sources.length) return undefined;
  // The compiled source wraps the submitted body in one async-function line.
  const userLine = best.originalLine;
  if (userLine < 1) return undefined;
  return {
    line: userLine,
    column: Math.max(1, best.originalColumn + (generatedColumn - 1 - best.generatedColumn) + 1),
  };
}

/** Replace generated QuickJS frames with submitted TypeScript locations. */
export function mapCodeModeStack(stack: string, sourceMapJson: string): string {
  return stack.replace(
    /agentuse-code-mode:generated\.js:(\d+):(\d+)/g,
    (frame, lineText: string, columnText: string) => {
      const mapped = mapCodeModePosition(sourceMapJson, Number(lineText), Number(columnText));
      return mapped
        ? `agentuse-code-mode:user.ts:${mapped.line}:${mapped.column}`
        : frame;
    },
  );
}
