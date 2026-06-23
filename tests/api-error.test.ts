import { describe, expect, it } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { extractApiErrorDetail } from '../src/runner/api-error';

describe('extractApiErrorDetail', () => {
  it('returns undefined for non-API errors', () => {
    expect(extractApiErrorDetail(new Error('Bad Request'))).toBeUndefined();
    expect(extractApiErrorDetail('Bad Request')).toBeUndefined();
    expect(extractApiErrorDetail(undefined)).toBeUndefined();
  });

  it('captures statusCode, url, and the provider response body', () => {
    const err = new APICallError({
      message: 'Bad Request',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: '{"detail":"Unsupported parameter: max_output_tokens"}',
    });
    expect(extractApiErrorDetail(err)).toEqual({
      statusCode: 400,
      url: 'https://chatgpt.com/backend-api/codex/responses',
      detail: '{"detail":"Unsupported parameter: max_output_tokens"}',
      message: 'Bad Request',
    });
  });

  it('truncates an oversized response body', () => {
    const err = new APICallError({
      message: 'Bad Request',
      url: 'https://x/responses',
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: 'z'.repeat(10000),
    });
    const detail = extractApiErrorDetail(err);
    expect(detail?.detail?.length).toBe(4000);
  });

  it('omits detail when the response body is empty', () => {
    const err = new APICallError({
      message: 'Service Unavailable',
      url: 'https://x/responses',
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: '',
    });
    expect(extractApiErrorDetail(err)).toEqual({
      statusCode: 503,
      url: 'https://x/responses',
      message: 'Service Unavailable',
    });
  });

  it('unwraps a RetryError to the underlying API error (rate limit)', () => {
    // The shape `--mock` produces: a per-tool completeText() call gets rate
    // limited, retries 3x, and the AI SDK wraps it in a RetryError whose own
    // message collapses to "Last error: Error". The real reason lives in the
    // wrapped attempts.
    const rateLimited = new APICallError({
      message: 'Error',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: '{"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}',
      isRetryable: true,
    });
    const wrapped = new RetryError({
      message: 'Failed after 3 attempts. Last error: Error',
      reason: 'maxRetriesExceeded',
      errors: [rateLimited, rateLimited, rateLimited],
    });
    expect(extractApiErrorDetail(wrapped)).toEqual({
      statusCode: 429,
      url: 'https://api.anthropic.com/v1/messages',
      detail: '{"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}',
      message: 'Error',
    });
  });

  it('unwraps an error cause chain to the underlying API error', () => {
    const apiError = new APICallError({
      message: 'Bad Request',
      url: 'https://x/responses',
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: '{"detail":"nope"}',
    });
    const wrapper = new Error('higher level failure', { cause: apiError });
    expect(extractApiErrorDetail(wrapper)).toEqual({
      statusCode: 400,
      url: 'https://x/responses',
      detail: '{"detail":"nope"}',
      message: 'Bad Request',
    });
  });
});
