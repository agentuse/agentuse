function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const RUNTIME_PATH_ENV = [
  "HOME",
  "AGENTUSE_DATA_DIR",
  "XDG_DATA_HOME",
  "AGENTUSE_CONFIG_DIR",
  // Deprecated compatibility overrides; remove no earlier than 2026-12-01.
  "AGENTUSE_CONFIG",
  "AGENTUSE_ENV",
] as const;

/**
 * A shell-ready command that runs the CLI packaged inside AgentUse.app.
 *
 * Carry only the non-secret paths that decide which AgentUse profile the CLI
 * reads. This keeps a coding-agent handoff attached to the same credential
 * store and config as Desktop without copying API keys into the prompt.
 */
export function bundledCliCommand(
  electronExecutable: string,
  cliEntry: string,
  runtimeEnv: NodeJS.ProcessEnv = {},
): string {
  const pathAssignments = RUNTIME_PATH_ENV.flatMap((name) => {
    const value = runtimeEnv[name];
    return value ? [`${name}=${shellQuote(value)}`] : [];
  });
  return [
    "env",
    ...pathAssignments,
    "ELECTRON_RUN_AS_NODE=1",
    shellQuote(electronExecutable),
    shellQuote(cliEntry),
  ].join(" ");
}
