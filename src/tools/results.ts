import type { Tool } from 'ai';
import { z } from 'zod';
import type { SessionManager } from '../session';
import type { CodeModeResultPage } from '../session/manager';
import type { CodeModeResultReference } from '../session/code-mode-results';
import { getToolOutputLimits } from './tool-output-limits.js';
import { resultPage } from './result-pages.js';

export const RESULTS_TOOL = 'results';

const resultId = z.string().min(1);

// Keep one provider-friendly object shape. Some models fill every optional
// property from a union's combined JSON Schema, which made otherwise valid
// results calls fail strict validation. Action-specific requirements are
// checked in execute(), while known fields for other actions are ignored.
const ResultsInputSchema = z.object({
  intent: z.string().optional()
    .describe('Short purpose of this call.'),
  recovers: z.string().optional()
    .describe('Earlier failed tool-call ID this call is correcting.'),
  action: z.enum(['list', 'read', 'grep', 'jq']),
  resultId: resultId.optional(),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
    .describe('One-based page for read or jq. Follow the returned next call unchanged.'),
  pageSizeBytes: z.number().int().min(4).max(1_000_000).optional()
    .describe('Maximum UTF-8 content bytes per page; response escaping may reduce each page.'),
  offset: z.number().int().min(0).optional()
    .describe('Byte offset. Use nextOffset from the previous page.'),
  maxBytes: z.number().int().min(1).optional()
    .describe('Maximum source bytes before the configured response limit is applied.'),
  pattern: z.string().min(1).max(4_096).optional()
    .describe('Literal text, not a regular expression.'),
  caseSensitive: z.boolean().optional().describe('Defaults to false.'),
  limit: z.number().int().min(1).max(500).optional(),
  contextLines: z.number().int().min(0).max(10).optional(),
  expression: z.string().min(1).max(8_192).optional(),
}).strict();

type ResultsInput = z.infer<typeof ResultsInputSchema>;

function requiredResultId(input: ResultsInput): string {
  if (!input.resultId) throw new Error(`RESULT_${input.action.toUpperCase()}_INPUT: resultId is required`);
  return input.resultId;
}

function requiredPattern(input: ResultsInput): string {
  if (!input.pattern) throw new Error('RESULT_GREP_INPUT: pattern is required');
  return input.pattern;
}

function requiredExpression(input: ResultsInput): string {
  if (!input.expression) throw new Error('RESULT_JQ_INPUT: expression is required');
  return input.expression;
}

function boundedLookup<T>(action: ResultsInput['action'], value: T, limit: number): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`RESULT_CORRUPT: ${action} returned a non-JSON value`);
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
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

function directResultReference(
  reference: CodeModeResultReference,
): CodeModeResultReference {
  if (reference.capabilities.read) return reference;
  return {
    ...reference,
    capabilities: { ...reference.capabilities, read: true },
  };
}

function fitReadPage(page: CodeModeResultPage, responseLimit: number): CodeModeResultPage {
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') <= responseLimit) return page;

  const characters = Array.from(page.content);
  let low = 0;
  let high = characters.length;
  let fitted: CodeModeResultPage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const content = characters.slice(0, middle).join('');
    const bytes = Buffer.byteLength(content, 'utf8');
    const nextOffset = page.offset + bytes;
    const candidate: CodeModeResultPage = {
      ...page,
      content,
      bytes,
      truncated: nextOffset < page.totalBytes,
      nextOffset: nextOffset < page.totalBytes ? nextOffset : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= responseLimit) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!fitted || (fitted.bytes === 0 && page.totalBytes > page.offset)) {
    throw new Error(`RESULT_QUERY_TOO_LARGE: read metadata exceeds the ${responseLimit.toLocaleString('en-US')}-byte inline limit`);
  }
  return fitted;
}

/** Shared byte-page reader for direct results and the Code Mode bridge. */
export async function readResultBytePage(
  manager: SessionManager,
  sessionId: string,
  agentId: string,
  resultId: string,
  options: { offset?: number; maxBytes?: number },
): Promise<CodeModeResultPage> {
  const input = ResultsInputSchema.pick({ offset: true, maxBytes: true }).parse(options);
  const limit = getToolOutputLimits().resultQueryBytes;
  return boundedLookup('read', fitReadPage(await manager.pageCodeModeResult(
    sessionId, agentId, resultId,
    { ...(input.offset !== undefined && { offset: input.offset }), maxBytes: Math.min(input.maxBytes ?? limit, limit) },
  ), limit), limit);
}

export function createResultsTool(options: {
  manager: SessionManager;
  sessionId: string;
  agentId: string;
}): Tool {
  const resultQueryBytes = getToolOutputLimits().resultQueryBytes;
  return {
    description: `Query stored results. read and oversized jq return text pages with totalPages and a next call using the same resultId. Concatenate content to reconstruct the output; JSON pages need not parse individually. Response limit: ${resultQueryBytes.toLocaleString('en-US')} bytes. Legacy read offset/maxBytes remains supported.`,
    inputSchema: ResultsInputSchema,
    execute: async (input: ResultsInput, callOptions?: { abortSignal?: AbortSignal }) => {
      switch (input.action) {
        case 'list':
          return boundedLookup(
            input.action,
            (await options.manager.listCodeModeResults(options.sessionId, options.agentId, input.limit))
              .map(directResultReference),
            resultQueryBytes,
          );
        case 'read':
          if (input.page !== undefined || input.pageSizeBytes !== undefined ||
              (input.offset === undefined && input.maxBytes === undefined)) {
            if (input.offset !== undefined || input.maxBytes !== undefined) {
              throw new Error('RESULT_PAGE_INPUT: do not mix page and byte-offset pagination');
            }
            return resultPage(await options.manager.resultPageText(options.sessionId,
              options.agentId, requiredResultId(input)), { ...input, action: 'read',
              resultId: requiredResultId(input), expression: undefined, limit: undefined }, resultQueryBytes);
          }
          return readResultBytePage(options.manager, options.sessionId, options.agentId,
            requiredResultId(input), {
              ...(input.offset !== undefined && { offset: input.offset }),
              ...(input.maxBytes !== undefined && { maxBytes: input.maxBytes }),
            });
        case 'grep':
          return boundedLookup(
            input.action,
            await options.manager.grepCodeModeResult(options.sessionId, options.agentId, requiredResultId(input), {
              pattern: requiredPattern(input),
              ...(input.caseSensitive !== undefined && { caseSensitive: input.caseSensitive }),
              ...(input.limit !== undefined && { limit: input.limit }),
              ...(input.contextLines !== undefined && { contextLines: input.contextLines }),
            }),
            resultQueryBytes,
          );
        case 'jq': {
          const value = await options.manager.jqCodeModeResult(
              options.sessionId,
              options.agentId,
              requiredResultId(input),
              requiredExpression(input),
              input.limit === undefined ? undefined : { limit: input.limit },
              callOptions?.abortSignal,
            );
          const serialized = JSON.stringify(value);
          if (input.page === undefined && input.pageSizeBytes === undefined &&
              Buffer.byteLength(serialized) <= resultQueryBytes) return value;
          return resultPage(serialized, { ...input, action: 'jq',
            resultId: requiredResultId(input), expression: requiredExpression(input) }, resultQueryBytes);
        }
      }
    },
  };
}
