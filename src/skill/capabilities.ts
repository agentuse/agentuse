import type { ToolsConfig } from '../tools/types.js';

export function expandSkillAllows(
  baseConfig: ToolsConfig | undefined,
  allows: Iterable<string>
): ToolsConfig | undefined {
  const requested = new Set(allows);
  requested.delete('*');
  if (requested.size === 0) {
    return baseConfig;
  }

  const config: ToolsConfig = {
    ...(baseConfig ?? {}),
    ...(baseConfig?.filesystem && { filesystem: [...baseConfig.filesystem] }),
    ...(baseConfig?.bash && {
      bash: {
        ...baseConfig.bash,
        commands: [...baseConfig.bash.commands],
        ...(baseConfig.bash.allowedPaths && { allowedPaths: [...baseConfig.bash.allowedPaths] }),
      },
    }),
  };

  config.bash ??= { commands: [] };
  for (const allow of requested) {
    addCommand(config.bash.commands, `${allow} *`);
  }

  return config;
}

function addCommand(commands: string[], command: string): void {
  if (!commands.includes(command)) {
    commands.push(command);
  }
}
