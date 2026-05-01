import { describe, expect, it } from 'bun:test';
import { formatToolResultForDisplay } from '../src/utils/format-tool-result';

describe('formatToolResultForDisplay', () => {
  it('extracts nested object error messages', () => {
    expect(formatToolResultForDisplay({
      error: {
        message: 'Slack channel_not_found'
      }
    }, { preferError: true })).toBe('Slack channel_not_found');
  });

  it('extracts nested error strings', () => {
    expect(formatToolResultForDisplay({
      error: {
        error: 'missing_scope'
      }
    }, { preferError: true })).toBe('missing_scope');
  });

  it('parses JSON string errors when requested', () => {
    expect(formatToolResultForDisplay(JSON.stringify({
      success: false,
      error: {
        message: 'approval channel is required'
      }
    }), { preferError: true })).toBe('approval channel is required');
  });

  it('uses output and MCP text content for readable results', () => {
    expect(formatToolResultForDisplay({ output: 'posted to Slack' })).toBe('posted to Slack');
    expect(formatToolResultForDisplay({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' }
      ]
    })).toBe('first\n\nsecond');
  });

  it('falls back to JSON instead of object interpolation', () => {
    expect(formatToolResultForDisplay({ code: 'NOPE' })).toBe('{"code":"NOPE"}');
  });
});
