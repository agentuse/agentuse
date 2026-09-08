import type { Tool } from 'ai';
import { z } from 'zod';
import { BUILTIN_SKILL_NAMES, loadBuiltinSkillSource } from '../skill/builtin';

/** Official authoring references, separate from project/user skill discovery. */
export function createBuiltinSkillTool(): Tool {
  return {
    description: 'Read official AgentUse guidance shipped with this server version. This replaces `agentuse skills get <name> --full` in the creator session. The creator guide is already embedded in your instructions; read core or tester when another skill refers to them. Reading guidance does not run a command or grant tools to the finished agent. Use tools__skill_load only for names in the installed skill catalog.',
    inputSchema: z.object({ name: z.enum(BUILTIN_SKILL_NAMES) }).strict(),
    execute: async ({ name }: { name: string }) => ({
      name,
      source: 'builtin',
      content: await loadBuiltinSkillSource(name),
    }),
  };
}
