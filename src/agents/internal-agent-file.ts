import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectDirSync } from '../storage/paths.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

/**
 * Internal AgentUse features (the creator, the reviser) build their agent in
 * memory, but a session can only be continued when it records a real agent file
 * path. Writing the generated source into the project's own state directory is
 * what makes "request a change" possible without exposing an internal agent in
 * the project's agent list.
 */
function internalSessionDir(projectRoot: string, kind: string): string {
  if (!/^[a-z-]+$/u.test(kind)) throw new Error('Invalid internal agent kind');
  return join(getProjectDirSync(projectRoot), kind);
}

export function internalAgentSourcePath(projectRoot: string, kind: string, sessionId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(sessionId)) throw new Error('Invalid internal session id');
  return join(internalSessionDir(projectRoot, kind), `${sessionId}.agentuse`);
}

export async function writeInternalAgentSource(
  projectRoot: string,
  kind: string,
  sessionId: string,
  source: string,
): Promise<string> {
  const target = internalAgentSourcePath(projectRoot, kind, sessionId);
  await mkdir(internalSessionDir(projectRoot, kind), { recursive: true });
  await atomicWriteFile(target, source, { mode: 0o600 });
  return target;
}
