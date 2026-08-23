import type {
  AgentSource,
  ExecutionClassification,
  ExecutionTrigger,
} from './types.js';

/** Exact, privacy-safe recognition for the canonical zero-config example only. */
export function isCanonicalRemoteExample(reference: string): boolean {
  try {
    const url = new URL(reference);
    return url.protocol === 'https:'
      && (url.hostname === 'agentuse.io' || url.hostname === 'www.agentuse.io')
      && url.pathname === '/hello.agentuse'
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

export function classifyExecution(input: {
  agentSource: AgentSource;
  trigger: ExecutionTrigger;
  isMock: boolean;
  isExampleAgent?: boolean;
  isHealthCheck?: boolean;
}): ExecutionClassification {
  const executionClass = input.isMock
    ? 'test'
    : input.isHealthCheck
      ? 'health_check'
      : input.isExampleAgent
        ? 'example'
        : 'user_agent';

  return {
    executionClass,
    agentSource: input.agentSource,
    isMock: input.isMock,
    trigger: input.trigger,
  };
}
