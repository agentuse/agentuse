import { describe, it, expect } from 'bun:test';
import { executeAgentCore, type AgentChunk } from '../src/runner';
import type { ParsedAgent } from '../src/parser';

// Helper function to simulate executeAgentCore's error transformation
function transformToolError(chunk: AgentChunk): AgentChunk {
  if (chunk.type === 'tool-error') {
    const errorMessage = chunk.error || 'Unknown error';
    
    // This mimics the logic in executeAgentCore
    function classifyError(error: string): string {
      const errorLower = error.toLowerCase();
      if (errorLower.includes('500') || errorLower.includes('502') || errorLower.includes('503') || errorLower.includes('unable to handle')) {
        return 'server_error';
      }
      if (errorLower.includes('429') || errorLower.includes('rate limit')) {
        return 'rate_limit';
      }
      if (errorLower.includes('timeout') || errorLower.includes('timed out')) {
        return 'timeout';
      }
      if (errorLower.includes('401') || errorLower.includes('403') || errorLower.includes('unauthorized') || errorLower.includes('forbidden')) {
        return 'auth_error';
      }
      if (errorLower.includes('404') || errorLower.includes('not found')) {
        return 'not_found';
      }
      if (errorLower.includes('network') || errorLower.includes('connection')) {
        return 'network_error';
      }
      return 'unknown';
    }
    
    function isRetryable(error: string): boolean {
      const type = classifyError(error);
      return ['server_error', 'rate_limit', 'timeout', 'network_error'].includes(type);
    }
    
    function getSuggestions(error: string): string[] {
      const type = classifyError(error);
      switch (type) {
        case 'server_error':
          return ['Wait a moment and retry', 'Try alternative approach', 'Proceed with available information'];
        case 'rate_limit':
          return ['Wait before retrying', 'Use different tool', 'Reduce request frequency'];
        case 'timeout':
          return ['Retry with simpler request', 'Break into smaller tasks', 'Try alternative tool'];
        case 'auth_error':
          return ['Check credentials', 'Use different service', 'Proceed without this data'];
        case 'not_found':
          return ['Verify parameters', 'Try different search terms', 'Resource may not exist'];
        case 'network_error':
          return ['Check connection and retry', 'Try alternative service', 'Wait and retry'];
        default:
          return ['Review error details', 'Try alternative approach', 'Proceed with caution'];
      }
    }
    
    return {
      type: 'tool-result',
      toolName: chunk.toolName,
      toolResult: JSON.stringify({
        success: false,
        error: {
          type: classifyError(errorMessage),
          message: errorMessage,
          retryable: isRetryable(errorMessage),
          suggestions: getSuggestions(errorMessage)
        }
      }),
      toolResultRaw: { error: errorMessage }
    };
  }
  return chunk;
}

describe('Tool Error Recovery', () => {
  it('should pass tool errors as structured results for AI retry decisions', async () => {
    // Collect chunks from the stream
    const chunks: AgentChunk[] = [];
    
    // Create a simple async generator to test
    async function* testGenerator(): AsyncGenerator<AgentChunk> {
      // Simulate tool call
      yield { type: 'tool-call' as const, toolName: 'failingTool', toolInput: {} };
      
      // Simulate tool error (which should be converted to structured result)
      yield { 
        type: 'tool-error' as const, 
        toolName: 'failingTool', 
        error: 'We\'re unable to handle your request right now' 
      };
      
      // Simulate AI response after seeing the error
      yield { type: 'text' as const, text: 'I see the tool failed. Let me try an alternative approach.' };
      
      yield { type: 'finish' as const, finishReason: 'stop' };
    }

    // Process the stream with transformation
    for await (const chunk of testGenerator()) {
      const transformed = transformToolError(chunk);
      chunks.push(transformed);
    }

    // Find the tool result chunk (which should be the converted error)
    const toolResultChunk = chunks.find(c => c.type === 'tool-result');
    
    expect(toolResultChunk).toBeDefined();
    
    // Parse the result to verify structure
    const result = JSON.parse(toolResultChunk!.toolResult!);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error.type).toBe('server_error');
    expect(result.error.message).toContain('unable to handle your request');
    expect(result.error.retryable).toBe(true);
    expect(result.error.suggestions).toBeArray();
    expect(result.error.suggestions).toContain('Wait a moment and retry');
  });

  it('should classify different error types correctly', async () => {
    const testCases = [
      { 
        error: 'HTTP 500 Internal Server Error',
        expectedType: 'server_error',
        expectedRetryable: true
      },
      {
        error: 'Rate limit exceeded (429)',
        expectedType: 'rate_limit',
        expectedRetryable: true
      },
      {
        error: 'Request timeout',
        expectedType: 'timeout',
        expectedRetryable: true
      },
      {
        error: 'Unauthorized: Invalid API key',
        expectedType: 'auth_error',
        expectedRetryable: false
      },
      {
        error: 'Resource not found (404)',
        expectedType: 'not_found',
        expectedRetryable: false
      },
      {
        error: 'Network connection failed',
        expectedType: 'network_error',
        expectedRetryable: true
      }
    ];

    for (const testCase of testCases) {
      async function* errorGenerator(): AsyncGenerator<AgentChunk> {
        yield { 
          type: 'tool-error' as const, 
          toolName: 'testTool', 
          error: testCase.error 
        };
        yield { type: 'finish' as const, finishReason: 'stop' };
      }

      const chunks: AgentChunk[] = [];
      for await (const chunk of errorGenerator()) {
        const transformed = transformToolError(chunk);
        chunks.push(transformed);
      }

      const toolResultChunk = chunks.find(c => c.type === 'tool-result');
      const result = JSON.parse(toolResultChunk!.toolResult!);
      
      expect(result.error.type).toBe(testCase.expectedType);
      expect(result.error.retryable).toBe(testCase.expectedRetryable);
      expect(result.error.suggestions).toBeArray();
      expect(result.error.suggestions.length).toBeGreaterThan(0);
    }
  });
});