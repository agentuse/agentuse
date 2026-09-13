import type { Tool } from 'ai';
import { z } from 'zod';
import type { SessionManager } from '../session';
import { getToolOutputLimits } from './tool-output-limits.js';

export const RESULTS_TOOL = 'results';

const resultId = z.string().min(1);

const ResultsInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({
    action: z.literal('read'),
    resultId,
  }).strict(),
  z.object({
    action: z.literal('grep'),
    resultId,
    pattern: z.string().min(1).max(4_096)
      .describe('Literal text. Do not use or escape regular-expression syntax.'),
    caseSensitive: z.boolean().optional().describe('Defaults to false.'),
    limit: z.number().int().min(1).max(500).optional(),
    contextLines: z.number().int().min(0).max(10).optional(),
  }).strict(),
  z.object({
    action: z.literal('jq'),
    resultId,
    expression: z.string().min(1).max(8_192),
    limit: z.number().int().min(1).max(500).optional(),
  }).strict(),
]);

type ResultsInput = z.infer<typeof ResultsInputSchema>;

function boundedLookup<T>(action: ResultsInput['action'], value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`RESULT_CORRUPT: ${action} returned a non-JSON value`);
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const limit = getToolOutputLimits().resultQueryBytes;
  if (bytes <= limit) return value;

  const recovery = action === 'list'
    ? 'Use a lower list limit.'
    : action === 'grep'
      ? 'Use a lower match limit or fewer context lines.'
      : action === 'jq'
        ? 'Narrow the jq expression; use grep when the reference advertises capabilities.grep.'
        : 'Use grep or jq to select a bounded slice.';
  throw new Error(
    `RESULT_QUERY_TOO_LARGE: ${action} returned ${bytes.toLocaleString('en-US')} bytes, `
    + `over the ${limit.toLocaleString('en-US')}-byte inline limit. ${recovery}`,
  );
}

export function createResultsTool(options: {
  manager: SessionManager;
  sessionId: string;
  agentId: string;
}): Tool {
  return {
    description: 'Query stored tool results by ID.',
    inputSchema: ResultsInputSchema,
    execute: async (input: ResultsInput, callOptions?: { abortSignal?: AbortSignal }) => {
      switch (input.action) {
        case 'list':
          return boundedLookup(
            input.action,
            await options.manager.listCodeModeResults(options.sessionId, options.agentId, input.limit),
          );
        case 'read':
          return boundedLookup(
            input.action,
            await options.manager.readCodeModeResult(options.sessionId, options.agentId, input.resultId),
          );
        case 'grep':
          return boundedLookup(
            input.action,
            await options.manager.grepCodeModeResult(options.sessionId, options.agentId, input.resultId, {
              pattern: input.pattern,
              ...(input.caseSensitive !== undefined && { caseSensitive: input.caseSensitive }),
              ...(input.limit !== undefined && { limit: input.limit }),
              ...(input.contextLines !== undefined && { contextLines: input.contextLines }),
            }),
          );
        case 'jq':
          return boundedLookup(
            input.action,
            await options.manager.jqCodeModeResult(
              options.sessionId,
              options.agentId,
              input.resultId,
              input.expression,
              input.limit === undefined ? undefined : { limit: input.limit },
              callOptions?.abortSignal,
            ),
          );
      }
    },
  };
}
