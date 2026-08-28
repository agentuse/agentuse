function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** A shell-ready command that runs the CLI packaged inside AgentUse.app. */
export function bundledCliCommand(electronExecutable: string, cliEntry: string): string {
  return `env ELECTRON_RUN_AS_NODE=1 ${shellQuote(electronExecutable)} ${shellQuote(cliEntry)}`;
}
