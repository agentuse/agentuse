/** Browser-safe presentation shared with CLI. Unknown/new causes remain readable. */
const labels = {
  run_deadline: 'Execution time limit reached',
  user_stopped: 'Stopped by user',
  user_interrupt: 'Interrupted by user',
  client_disconnect: 'Attached client disconnected',
  interrupted_unknown: 'Interrupted, cause unknown',
  model_stall: 'Model stalled',
  model_transport: 'Model connection dropped',
  provider_rate_limit: 'Provider rate limited',
  provider_overloaded: 'Provider overloaded',
  provider_timeout: 'Provider request timed out',
  provider_server: 'Provider server error',
  provider_content_filter: 'Provider content filter truncated response',
  provider_request: 'Provider request failed',
  provider_permission: 'Provider access denied',
  configuration: 'Configuration error',
  worker_interrupted: 'Worker interrupted',
  worker_protocol: 'Worker protocol error',
  request_deadline: 'Request time limit reached',
  authentication: 'Authentication failed',
  unknown: 'Execution error',
} as const;

export type FailureCause = keyof typeof labels;

export function failureLabel(cause?: string): string | undefined {
  return cause && Object.hasOwn(labels, cause) ? labels[cause as FailureCause] : undefined;
}
