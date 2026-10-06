/**
 * Whether this process was started by npx, which runs the CLI from its cache
 * (~/.npm/_npx/... or node_modules/.npx-cache/...) without installing a
 * global `agentuse` command.
 */
export function isNpxRun(scriptPath = process.argv[1] ?? ''): boolean {
  const normalized = scriptPath.replaceAll('\\', '/');
  return normalized.includes('/_npx/') || normalized.includes('/.npx-cache/');
}

/** How the user should invoke the CLI in printed next steps. */
export function cliCommand(scriptPath?: string): string {
  return isNpxRun(scriptPath) ? 'npx agentuse' : 'agentuse';
}
