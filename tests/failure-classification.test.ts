import { describe, expect, it } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { classifyFailure, RunAbortError, runDeadline, sessionStopReason, ProviderContentFilterError } from '../src/runner/failure';
import { ModelStreamStallError, ModelStreamTransportError } from '../src/runner/model-stall';
import { ConfigError } from '../src/parser';
import { failureLabel } from '../src/session/failure-label';
import { sessionErrorFields } from '../src/worker/helpers';
import { workerExecutionErrorResponse } from '../src/cli/serve/run-request';

function provider(statusCode: number, responseBody = '{}') {
  return new APICallError({ message: 'Provider rejected request', url: 'https://example.test/model', requestBodyValues: {}, statusCode, responseBody });
}

describe('failure classification', () => {
  it('classifies terminal content filters without inferring them from parser errors', () => {
    expect(classifyFailure(new ProviderContentFilterError())).toMatchObject({ code: 'CONTENT_FILTER', cause: 'provider_content_filter' });
    expect(classifyFailure(new Error('Invalid JSON')).cause).toBe('unknown');
  });

  it('uses trusted disconnect evidence while preserving free-form operator reasons', () => {
    const controller = new AbortController();
    controller.abort(sessionStopReason(undefined, 'client_disconnect'));
    expect(classifyFailure(new DOMException('aborted', 'AbortError'), controller.signal))
      .toEqual({ code: 'CLIENT_DISCONNECT', cause: 'client_disconnect', message: 'Attached client disconnected' });
    expect(classifyFailure(sessionStopReason('Change set cancelled by operator')))
      .toMatchObject({ cause: 'user_stopped', message: 'Change set cancelled by operator' });
    expect(classifyFailure(sessionStopReason('client-disconnect')).cause).toBe('user_stopped');
    expect(failureLabel('client_disconnect')).toBe('Attached client disconnected');
  });

  it.each([
    [401, 'authentication', 'AUTH_ERROR'],
    [403, 'provider_permission', 'EXECUTION_ERROR'],
    [408, 'provider_timeout', 'EXECUTION_ERROR'],
    [429, 'provider_rate_limit', 'EXECUTION_ERROR'],
    [500, 'provider_server', 'EXECUTION_ERROR'],
    [503, 'provider_server', 'EXECUTION_ERROR'],
    [504, 'provider_timeout', 'EXECUTION_ERROR'],
    [400, 'provider_request', 'EXECUTION_ERROR'],
  ])('classifies HTTP %s as %s', (status, cause, code) => {
    expect(classifyFailure(provider(status as number))).toMatchObject({ cause, code, statusCode: status });
  });

  it('uses structured overload evidence, not arbitrary message matching', () => {
    expect(classifyFailure(provider(529, '{"error":{"type":"overloaded_error"}}')).cause).toBe('provider_overloaded');
    expect(classifyFailure(new Error('Our servers are currently overloaded')).cause).toBe('unknown');
    expect(classifyFailure(provider(503, 'not JSON')).cause).toBe('provider_server');
  });

  it('unwraps provider retry errors', () => {
    const error = new RetryError({ message: 'Retries exhausted', reason: 'maxRetriesExceeded', errors: [provider(500), provider(429)] });
    expect(classifyFailure(error).cause).toBe('provider_rate_limit');
  });

  it.each(['first-progress', 'idle', 'hard-limit'] as const)('retains stall phase %s without claiming a run timeout', phase => {
    expect(classifyFailure(new ModelStreamStallError(1000, 3, phase))).toMatchObject({ code: 'EXECUTION_ERROR', cause: 'model_stall', phase, attempts: 3 });
  });

  it('retains wrapped transport errors and attempt counts', () => {
    expect(classifyFailure(new Error('wrapper', { cause: new ModelStreamTransportError('terminated', 2) }))).toMatchObject({ cause: 'model_transport', attempts: 2 });
  });

  it('never treats an unexplained abort as a deadline', () => {
    expect(classifyFailure(new DOMException('aborted', 'AbortError'))).toMatchObject({ code: 'EXECUTION_ERROR', cause: 'interrupted_unknown' });
    expect(classifyFailure(new Error('wrapper', { cause: new DOMException('aborted', 'AbortError') })).cause).toBe('interrupted_unknown');
    const controller = new AbortController();
    controller.abort();
    expect(classifyFailure(new Error('aborted'), controller.signal).cause).toBe('interrupted_unknown');
  });

  it.each([
    ['run_deadline', 'TIMEOUT'], ['user_stopped', 'USER_STOPPED'], ['user_interrupt', 'USER_INTERRUPT'],
  ] as const)('preserves explicit %s through an SDK abort', (cause, code) => {
    const controller = new AbortController();
    controller.abort(new RunAbortError(cause, 'Explicit reason'));
    expect(classifyFailure(new DOMException('aborted', 'AbortError'), controller.signal)).toEqual({ code, cause, message: 'Explicit reason' });
  });

  it('does not let a later deadline overwrite a prior stop signal', () => {
    const controller = new AbortController();
    controller.abort(new RunAbortError('user_stopped', 'Stopped'));
    controller.abort(runDeadline(300));
    expect(classifyFailure(new Error('cleanup'), controller.signal).cause).toBe('user_stopped');
  });

  it('classifies typed configuration errors and safely bounds cyclic causes', () => {
    expect(classifyFailure(new ConfigError('Bad model', 'model', 'invalid_type'))).toMatchObject({ code: 'CONFIG_ERROR', cause: 'configuration' });
    const error = new Error('Unknown');
    error.cause = error;
    expect(classifyFailure(error).cause).toBe('unknown');
  });

  it('preserves structured failure in API JSON and list projections', () => {
    const failure = classifyFailure(new ModelStreamTransportError('terminated', 2));
    const wire = JSON.parse(JSON.stringify(failure));
    expect(workerExecutionErrorResponse({ success: false, error: wire }).body.error).toEqual(failure);
    expect(sessionErrorFields({ status: 'error', error: wire })).toMatchObject({ errorCause: 'model_transport', errorCode: 'EXECUTION_ERROR' });
    expect(sessionErrorFields({ status: 'running', error: wire })).toEqual({});
    expect(failureLabel(wire.cause)).toBe('Model connection dropped');
  });

  it('keeps legacy sessions unclassified and future causes safe', () => {
    expect(sessionErrorFields({ status: 'error', error: { code: 'TIMEOUT', message: 'Stream aborted' } })).not.toHaveProperty('errorCause');
    expect(failureLabel('future_cause')).toBeUndefined();
    expect(failureLabel('constructor')).toBeUndefined();
    expect(failureLabel()).toBeUndefined();
  });
});
