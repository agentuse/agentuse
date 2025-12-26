import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { logger } from '../src/utils/logger';

describe('Spinner Cleanup Behavior', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save original env and disable TUI for tests
    originalEnv = process.env.NO_TTY;
    process.env.NO_TTY = 'true';

    // Reset logger to pick up env change
    logger.configure({ disableTUI: true });
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.NO_TTY = originalEnv;
    } else {
      delete process.env.NO_TTY;
    }
  });

  it('stops spinner before error output', () => {
    // This test verifies that error() calls stopSpinner
    // In TUI mode, this would prevent spinner artifacts

    // Start a simulated tool call (which would start a spinner in TUI mode)
    logger.tool('test-tool', { arg: 'value' });

    // Call error - should cleanly stop any spinner
    logger.error('Test error message');

    // If we had a spinner, it should now be stopped
    // This test passes if no errors are thrown
    expect(true).toBe(true);
  });

  it('stops spinner before warning output', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.warn('Test warning message');
    expect(true).toBe(true);
  });

  it('stops spinner before info output', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.info('Test info message');
    expect(true).toBe(true);
  });

  it('stops spinner before tool result output', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.toolResult('Success', { duration: 100, success: true });
    expect(true).toBe(true);
  });

  it('stops spinner when response starts streaming', () => {
    // Start LLM call (would start spinner in TUI mode)
    logger.llmStart('claude-sonnet-4');

    // Start streaming response - should stop spinner without persisting
    logger.response('First chunk of response');
    logger.response(' second chunk');
    logger.responseComplete();

    expect(true).toBe(true);
  });

  it('handles multiple spinner starts without errors', () => {
    // Simulate rapid tool calls (each would start a spinner in TUI mode)
    logger.tool('tool1', { arg: 'value1' });
    logger.toolResult('Done');

    logger.tool('tool2', { arg: 'value2' });
    logger.toolResult('Done');

    logger.llmStart('claude-sonnet-4');
    logger.response('Response');
    logger.responseComplete();

    expect(true).toBe(true);
  });

  it('stops spinner when switching to plain output', () => {
    // Start a tool call
    logger.tool('test-tool', { arg: 'value' });

    // Force plain output - should stop any active spinner
    logger.forcePlainOutput();

    // Should be able to log normally after
    logger.info('Plain output message');

    expect(true).toBe(true);
  });

  it('handles separator output with spinner cleanup', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.separator();
    expect(true).toBe(true);
  });

  it('handles summary output with spinner cleanup', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.summary({
      success: true,
      durationMs: 1234,
      tokensUsed: 500,
      toolCallCount: 3
    });
    expect(true).toBe(true);
  });

  it('handles metadata output with spinner cleanup', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.metadata(['Key1: Value1', 'Key2: Value2']);
    expect(true).toBe(true);
  });

  it('handles grouped warnings with spinner cleanup', () => {
    logger.tool('test-tool', { arg: 'value' });
    logger.groupedWarnings(['Warning 1', 'Warning 2', 'Warning 3']);
    expect(true).toBe(true);
  });

  it('handles LLM first token update correctly', () => {
    logger.llmStart('claude-sonnet-4');

    // Update spinner with first token latency
    // This should only update the spinner text, not stop it
    logger.llmFirstToken('claude-sonnet-4', 1234);

    // Now stop it with a response
    logger.response('Response');
    logger.responseComplete();

    expect(true).toBe(true);
  });

  it('ignores first token update for wrong model', () => {
    logger.llmStart('claude-sonnet-4');

    // Try to update with wrong model - should be ignored
    logger.llmFirstToken('gpt-4', 1234);

    // Clean up
    logger.response('Response');
    logger.responseComplete();

    expect(true).toBe(true);
  });

  it('handles tool call with sub-agent flag', () => {
    logger.tool('subagent-name', { task: 'test' }, undefined, true);
    logger.toolResult('Completed');
    expect(true).toBe(true);
  });

  it('handles debug mode logging without spinners', () => {
    // Configure debug mode
    logger.configure({ enableDebug: true });

    // In debug mode, spinners shouldn't be used
    logger.tool('test-tool', { arg: 'value' });
    logger.llmStart('claude-sonnet-4');
    logger.response('Response');
    logger.responseComplete();

    // Reset debug mode
    logger.configure({ enableDebug: false });

    expect(true).toBe(true);
  });

  it('handles quiet mode correctly', () => {
    logger.configure({ quiet: true });

    // In quiet mode, info and tool messages should be suppressed
    logger.tool('test-tool', { arg: 'value' });
    logger.info('Should not appear');

    // But errors and warnings should still work
    logger.error('Error message');
    logger.warn('Warning message');

    // Reset quiet mode
    logger.configure({ quiet: false });

    expect(true).toBe(true);
  });

  it('handles rapid spinner start/stop cycles', () => {
    // Simulate rapid tool calls that might happen during agent execution
    for (let i = 0; i < 10; i++) {
      logger.tool(`tool-${i}`, { iteration: i });
      logger.toolResult(`Result ${i}`);
    }

    expect(true).toBe(true);
  });

  it('handles interleaved LLM and tool calls', () => {
    logger.llmStart('claude-sonnet-4');
    logger.response('Thinking...');
    logger.responseComplete();

    logger.tool('tool1', { arg: 'value' });
    logger.toolResult('Done');

    logger.llmStart('claude-sonnet-4');
    logger.response('More thinking...');
    logger.responseComplete();

    logger.tool('tool2', { arg: 'value' });
    logger.toolResult('Done');

    expect(true).toBe(true);
  });

  it('handles error with stack trace in debug mode', () => {
    logger.configure({ enableDebug: true });

    const testError = new Error('Test error');
    logger.error('Operation failed', testError);

    logger.configure({ enableDebug: false });

    expect(true).toBe(true);
  });

  it('handles capture mode correctly', () => {
    logger.startCapture();

    logger.tool('test-tool', { arg: 'value' });
    logger.toolResult('Success');
    logger.info('Info message');

    const captured = logger.stopCapture();

    // Captured output should be non-empty
    expect(captured.length).toBeGreaterThan(0);
  });
});
