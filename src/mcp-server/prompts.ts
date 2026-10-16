import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadBuiltinSkillSource } from '../skill/builtin.js';

/**
 * `/automate` and `/triage`: the slash commands Claude and ChatGPT show once
 * AgentUse is connected. `/automate` is the built-in automate skill in its
 * chat mode, the same text a coding agent gets from `agentuse skills get
 * automate`, so there is one source for both. Each prompt also carries the
 * core and creator guidance shipped with this exact AgentUse build.
 */

const TRIAGE_STEPS = `You are fixing AgentUse agents that fail on the user's own computer.

Steps:
1. Call list_problems (for one agent if the user named one). No problems: say so and stop.
2. Take the newest or most frequent problem. Call get_session on its latest run, then get_agent for that agent.
3. Find the cause and say which layer owns it: the agent file, the project's code, setup (a login, key, or missing program), or AgentUse itself.
4. If the agent file or its helper files are the cause, write the corrected files and call propose_fix with the failed run as from_session. If propose_fix is rejected, fix the files and call it again with the same fix_id. Then call test_draft with the fix_id and get_session until it ends, and adjust if the practice run shows the fix does not hold.
5. If the cause is setup or project code, do not propose a fix. Tell the user exactly what to change and where.
6. Give the user the review_url when there is one, and tell them to press Apply on that page. You cannot apply fixes, approve steps or dismiss runs, and must not claim you did.
7. Move to the next problem only if the user asks.`;

const AUDIT_STEPS = `Audit only: report the problems, their causes and the fix you would propose. Do not call propose_fix.`;

async function guide(): Promise<string> {
  const [core, creator] = await Promise.all([loadBuiltinSkillSource('core'), loadBuiltinSkillSource('creator')]);
  return [
    '---',
    'AgentUse guide, from the version installed on the user\'s computer. Where it mentions CLI commands, use the tools above instead.',
    '',
    core.trim(),
    '',
    creator.trim(),
  ].join('\n');
}

export function registerAgentUsePrompts(server: McpServer): void {
  server.registerPrompt('automate', {
    title: 'Automate this',
    description: 'Turn this chat into an agent that runs on its own',
    argsSchema: { goal: z.string().optional().describe('What to automate, if the chat does not already say') },
  }, async ({ goal }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Use chat mode of the skill below: the AgentUse tools are connected and you cannot run commands on the user\'s computer.',
          goal ? `The user's goal: ${goal}` : '',
          '',
          (await loadBuiltinSkillSource('automate')).trim(),
          '',
          await guide(),
        ].join('\n'),
      },
    }],
  }));

  server.registerPrompt('triage', {
    title: 'Triage agents',
    description: 'Find and fix agents that are failing',
    argsSchema: {
      agent: z.string().optional().describe('Only this agent'),
      audit_only: z.string().optional().describe('"yes" to report without proposing fixes'),
    },
  }, async ({ agent, audit_only }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          TRIAGE_STEPS,
          agent ? `\nLook only at this agent: ${agent}` : '',
          audit_only && /^(yes|true|1)$/iu.test(audit_only) ? `\n${AUDIT_STEPS}` : '',
          '',
          await guide(),
        ].join('\n'),
      },
    }],
  }));
}
