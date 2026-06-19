import { describe, expect, it } from 'bun:test';
import { APICallError } from 'ai';
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
    expect(extractApiErrorDetail(err)).toEqual({ statusCode: 503, url: 'https://x/responses' });
  });
});
