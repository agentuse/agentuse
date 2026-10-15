import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadBuiltinSkillSource } from '../skill/builtin.js';

/**
 * `/automate` and `/triage`: the slash commands Claude and ChatGPT show once
 * AgentUse is connected. Each carries the chat-side steps plus the authoring
 * guidance shipped with this exact AgentUse build, so a chat writes agents by
 * the same rules as the dashboard's own creator.
 */

const AUTOMATE_STEPS = `You are turning work from this conversation into an AgentUse agent that runs on the user's own computer.

Steps:
1. Work out the narrowest repeatable job from this conversation: where its input comes from, what done looks like, when it runs (manual, a schedule, or HTTP), where the result goes, and which actions need a person to approve them. Ask one short question only when a missing answer changes the agent or what it may do.
2. Call list_projects. One project: use it. Several: pick from the conversation or ask which one.
3. Call get_project for that project. Use only models in models.available, and only MCP servers and skills listed there. If the job needs an MCP server nobody has added, say so and put it in the agent anyway: the review will flag the missing login.
4. If the agent must match an existing template, data header or script, call read_project_file for just those files.
5. Write one focused .agentuse file under agents/, plus helper files only when the guide below says they are worth it. Put any command with side effects under tools.bash.gated so it waits for approval; wording in the prompt is not a safety boundary. Do not put a schedule in the file: a draft cannot carry one until a person has reviewed it. Name the schedule the user wants in your summary instead.
6. Call draft_agent. If it is rejected, fix the files and call it again with the same draft. Repeat until it is saved.
7. Call test_draft for a practice run, then get_session until it ends. Every tool is faked there, so judge whether the steps and approvals make sense, not the made-up data. Fix what went wrong with draft_agent (same draft_id) and test again, at most three rounds. If test_draft refuses the draft, say why and leave the test to the user.
8. Give the user the review_url and a three-line summary: what the agent does, when it should run, and what it will ask approval for, plus what the practice run showed. Tell them to open the link and press Apply. If it should run on a schedule, say that once they have applied it you will propose the schedule as a change (propose_fix adding a schedule: line), which they apply the same way. You cannot turn it on, and must not claim you did.`;

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
        text: [AUTOMATE_STEPS, goal ? `\nThe user's goal: ${goal}` : '', '', await guide()].join('\n'),
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
