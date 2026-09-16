import { dirname } from 'path';
import { resolveBashPatterns } from '../tools/command-patterns.js';
import type { ParsedAgent } from '../parser';
import { findProjectRoot } from '../utils/project';
import { resolveSafeVariables } from '../tools/index.js';
import { appendApprovalInstructions } from './approval';
import { buildLearningPrompt, previewLearningPrompt } from './system-messages';
import { expandTrustedSkills, getExplicitSkillNames, loadSkillPromptOutputs } from '../skill/index.js';
import { discoverSkills } from '../skill/discovery.js';

/** Shared fresh-run instruction assembly. Replay uses the same current agent,
 * explicit skills and learnings, without crediting a test as learning usage. */
export async function buildFreshInstructions(options: {
  agent: ParsedAgent;
  agentFilePath?: string | undefined;
  projectContext?: { projectRoot: string; stateRoot: string } | undefined;
  recordLearningUsage?: boolean;
}) {
  const { agent, agentFilePath, projectContext } = options;
  const approvalConfig = agent.config.tools?.bash ? {
    ...agent.config,
    tools: { ...agent.config.tools, bash: resolveBashPatterns(agent.config.tools.bash, {
      projectRoot: projectContext?.projectRoot ?? process.cwd(),
      agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
    }) },
  } : agent.config;
  let instructions = appendApprovalInstructions(resolveSafeVariables(agent.instructions, {
    projectRoot: projectContext?.projectRoot ?? process.cwd(),
    agentDir: agentFilePath ? dirname(agentFilePath) : undefined,
  }), approvalConfig);
  if (projectContext) {
    const names = getExplicitSkillNames(agent.config.skills);
    if (names.length) {
      const discovered = await discoverSkills(projectContext.projectRoot);
      const config = expandTrustedSkills(agent.config.tools, discovered, agent.config.skills);
      const skills = await loadSkillPromptOutputs(projectContext.projectRoot, config, names);
      if (skills.length) instructions = [instructions,
        '## Skills (shared defaults; agent instructions and relevant contextual learnings may refine them)',
        skills.map(s => s.output).join('\n\n')].join('\n\n');
    }
  }
  const learning = agent.config.learning?.apply && agentFilePath
    ? await (options.recordLearningUsage === false ? previewLearningPrompt : buildLearningPrompt)(
        agent, agentFilePath, projectContext?.stateRoot ?? findProjectRoot(agentFilePath))
    : undefined;
  if (learning?.prompt) instructions += `\n\n${learning.prompt}`;
  return {
    instructions,
    learningsApplied: learning?.count ?? 0,
    learningsStored: learning?.total ?? 0,
    learningsCap: learning?.cap ?? 0,
    learningsInjectedIds: learning?.injectedIds ?? [],
  };
}
