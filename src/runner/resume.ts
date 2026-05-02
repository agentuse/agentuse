import type { SessionManager } from '../session';

export async function applyResumeToolResult(options: {
  sessionManager: SessionManager;
  sessionId: string;
  toolResult: unknown;
  resumeToken?: string;
  skipTokenValidation?: boolean;
}): Promise<{ agentId: string; agentFilePath?: string }> {
  const { sessionManager, sessionId, toolResult, resumeToken, skipTokenValidation } = options;
  const found = await sessionManager.findSession(sessionId);
  if (!found) {
    throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
  }
  if (found.session.status !== 'suspended') {
    throw new Error(`SESSION_NOT_SUSPENDED: ${found.session.status}`);
  }

  const pending = await sessionManager.findPendingTool(sessionId, found.agentId);
  if (!pending) {
    throw new Error(`PENDING_TOOL_NOT_FOUND: ${sessionId}`);
  }

  const expectedToken = pending.part.state.status === 'pending'
    ? pending.part.state.resumePayload?.resumeToken
    : undefined;
  if (!skipTokenValidation && expectedToken && expectedToken !== resumeToken) {
    throw new Error('RESUME_TOKEN_INVALID');
  }

  if (pending.part.state.status === 'completed') {
    return {
      agentId: found.agentId,
      ...(found.session.agent.filePath && { agentFilePath: found.session.agent.filePath })
    };
  }

  const input = 'input' in pending.part.state ? pending.part.state.input : undefined;
  const resumePayload = pending.part.state.status === 'pending'
    ? pending.part.state.resumePayload
    : undefined;
  const now = Date.now();
  const start = pending.part.state.status === 'running'
    ? pending.part.state.time.start
    : pending.part.state.status === 'pending'
      ? (pending.part.state.suspendedAt ?? now)
      : now;
  await sessionManager.updatePart(sessionId, found.agentId, pending.message.id, pending.part.id, {
    state: {
      status: 'completed',
      input: input ?? {},
      output: toolResult,
      ...(resumePayload && { metadata: { resumePayload } }),
      time: {
        start,
        end: now
      }
    }
  } as any);
  await sessionManager.setSessionRunning(sessionId, found.agentId);

  return {
    agentId: found.agentId,
    ...(found.session.agent.filePath && { agentFilePath: found.session.agent.filePath })
  };
}
