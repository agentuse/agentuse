import { describe, expect, it } from 'bun:test';
import { APICallError } from 'ai';
import { formatSubagentErrorMessage } from '../src/subagent';

describe('formatSubagentErrorMessage', () => {
  it('prefixes an OAuth 403 provider failure with the concrete model', () => {
    const error = new APICallError({
      message: 'OAuth authentication failed',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 403,
      responseHeaders: {},
      responseBody: '{"type":"error","error":{"type":"permission_error"}}',
    });

    expect(formatSubagentErrorMessage(error, 'anthropic:claude-opus-5')).toBe(
      '[model: anthropic:claude-opus-5] OAuth authentication failed',
    );
  });

  it('leaves non-model failures byte-for-byte unchanged', () => {
    const message = 'Tool setup failed:\n  executable not found';

    expect(formatSubagentErrorMessage(new Error(message), 'anthropic:claude-opus-5')).toBe(message);
  });

  it('recognizes model-auth errors without class identity when their shape matches', () => {
    expect(formatSubagentErrorMessage(
      {
        name: 'AuthenticationError',
        message: 'No authentication found for Anthropic',
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
      },
      'anthropic:claude-opus-5',
    )).toBe('[model: anthropic:claude-opus-5] No authentication found for Anthropic');
  });

  it('does not treat an arbitrary AuthenticationError-named object as a model failure', () => {
    expect(formatSubagentErrorMessage(
      { name: 'AuthenticationError', message: 'Application authentication failed' },
      'anthropic:claude-opus-5',
    )).toBe('Application authentication failed');
  });

  it('recognizes Anthropic refresh failures by name across class boundaries', () => {
    expect(formatSubagentErrorMessage(
      { name: 'AnthropicRefreshFailed', message: 'OAuth token refresh failed' },
      'anthropic:claude-opus-5',
    )).toBe('[model: anthropic:claude-opus-5] OAuth token refresh failed');
  });

  it('does not add a second model prefix', () => {
    const error = new APICallError({
      message: '[model: anthropic:claude-opus-5] OAuth authentication failed',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 403,
      responseHeaders: {},
      responseBody: '{}',
    });

    expect(formatSubagentErrorMessage(error, 'anthropic:claude-opus-5')).toBe(
      '[model: anthropic:claude-opus-5] OAuth authentication failed',
    );
  });
});
