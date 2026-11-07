import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadBuiltinSkillSource } from '../skill/builtin.js';
import {
  AUTHORING_RULES_URI, GET_WORKFLOW, PROMPTS, getWorkflowResult, promptResult,
} from './workflow-text.js';

/**
 * `/agentuse`, `/automate` and `/triage`: the slash commands an MCP app (Claude, ChatGPT,
 * Codex, Cursor) shows once AgentUse is connected, and get_workflow, the same
 * text as a tool. The wording lives in workflow-text.ts, which AgentUse Cloud
 * also serves to relayed chats; the authoring rules come from this exact
 * build, so a chat writes agents by the same rules as the dashboard's creator.
 */

/** The creator rules installed with this build. The core guide is a map of CLI commands and is left out. */
async function authoringRules(): Promise<string> {
  return (await loadBuiltinSkillSource('creator')).trim();
}

export function registerAgentUsePrompts(server: McpServer): void {
  for (const prompt of PROMPTS) {
    server.registerPrompt(prompt.name, {
      title: prompt.title,
      description: prompt.description,
      argsSchema: Object.fromEntries(prompt.arguments.map((arg) => [arg.name, z.string().optional().describe(arg.description)])),
    }, async (args: Record<string, string | undefined>) => promptResult(prompt.name, args, prompt.name === 'agentuse' ? '' : await authoringRules())!);
  }

  server.registerTool(GET_WORKFLOW.name, {
    title: GET_WORKFLOW.title,
    description: GET_WORKFLOW.description,
    inputSchema: {
      workflow: z.enum(GET_WORKFLOW.workflows).describe(GET_WORKFLOW.args.workflow),
      goal: z.string().optional().describe(GET_WORKFLOW.args.goal),
      agent: z.string().optional().describe(GET_WORKFLOW.args.agent),
    },
    annotations: GET_WORKFLOW.annotations,
  }, async (args) => getWorkflowResult(args, await authoringRules()));

  // AgentUse Cloud reads this to put the rules of the user's own version under
  // its wording; see AUTHORING_RULES_URI.
  server.registerResource('AgentUse authoring rules', AUTHORING_RULES_URI, {
    description: 'The rules for writing .agentuse files, from the AgentUse installed on this computer',
    mimeType: 'text/markdown',
  }, async () => ({
    contents: [{ uri: AUTHORING_RULES_URI, mimeType: 'text/markdown', text: await authoringRules() }],
  }));
}
