import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path, { resolve } from 'path';
import { parseAgent } from '../parser.js';
import { discoverSkills } from '../skill/discovery.js';
import { getExplicitSkillNames, isSkillTrusted, trustsAllSkills } from '../skill/config.js';
import { extractCommandFromAllowedTool } from '../skill/command-extract.js';
import { estimateSkillCatalogTokens, loadSkillPromptOutputs } from '../skill/tool.js';
import { expandTrustedSkills } from '../skill/capabilities.js';
import { resolveProjectContext } from '../utils/project.js';
import { computeAgentId } from '../utils/agent-id.js';
import { getSessionStorageDir } from '../storage/paths.js';
import { parseBashCommand } from '../tools/bash-parser.js';
import { looksEffectful, grantsUnnamedSubcommands, grantsArbitraryCode, commandHead } from '../tools/effectful-heuristic.js';
import { isEffectful } from '../runner/approval-lease.js';
import { previewLearningPrompt } from '../runner/system-messages.js';
import { LearningStore, resolveLearningFilePath, strandedLearningsNotice } from '../learning/store.js';
import type { Message, Part, SessionInfo, ToolPart } from '../session/types.js';

interface DoctorOptions {
  lastRun?: boolean | undefined;
}

interface RuntimeSessionDetails {
  session: SessionInfo;
  dirPath: string;
  messages: Array<{ message: Message; parts: Part[] }>;
}

interface RuntimeProblem {
  tool: string;
  command?: string | undefined;
  error: string;
  suggestedAllows: string[];
}

const LARGE_AGENT_BODY_WORDS = 1500;
const VERY_LARGE_AGENT_BODY_WORDS = 2500;
const DENSE_INSTRUCTION_LINE_CHARS = 800;
// The skill surface is a recurring per-request cost, not a one-time load: the
// catalog ships one name + description per visible skill, and every preloaded
// skill ships its whole body inside the instructions.
const LARGE_SKILL_CATALOG_TOKENS = 1500;
const VERY_LARGE_SKILL_CATALOG_TOKENS = 3000;
const LARGE_PRELOADED_SKILL_TOKENS = 2000;
const VERY_LARGE_PRELOADED_SKILL_TOKENS = 4000;

function skillLooksReferenced(agent: Awaited<ReturnType<typeof parseAgent>>, skillName: string): boolean {
  const haystack = [
    agent.name,
    agent.description ?? '',
    agent.instructions,
  ].join('\n').toLowerCase();
  return haystack.includes(skillName.toLowerCase());
}

function formatEstimatedTokens(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function longestLineLength(text: string): number {
  return text.split(/\r?\n/).reduce((longest, line) => Math.max(longest, line.length), 0);
}

function globallyAllowsCommand(agent: Awaited<ReturnType<typeof parseAgent>>, command: string): boolean {
  for (const pattern of agent.config.tools?.bash?.commands ?? []) {
    const parts = pattern.trim().split(/\s+/);
    if (parts[0] === command && (parts.length === 1 || parts[1] === '*')) {
      return true;
    }
  }
  return false;
}

function parseSessionDirName(dirName: string): { id: string; agentName: string } | null {
  const ulidLength = 26;
  if (dirName.length < ulidLength + 2) return null;
  const id = dirName.slice(0, ulidLength);
  if (!/^[0-9A-Z]{26}$/i.test(id)) return null;
  return { id, agentName: dirName.slice(ulidLength + 1) };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function findLatestSessionForAgent(
  projectRoot: string,
  agentId: string,
  agentFilePath: string
): Promise<{ session: SessionInfo; dirPath: string } | null> {
  const sessionDir = await getSessionStorageDir(projectRoot);
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ session: SessionInfo; dirPath: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !parseSessionDirName(entry.name)) continue;
    const dirPath = path.join(sessionDir, entry.name);
    const session = await readJsonFile<SessionInfo>(path.join(dirPath, 'session.json'));
    if (!session) continue;

    const sessionAgentId = session.agent.id ?? session.agent.name;
    const sameAgent = sessionAgentId === agentId || (
      session.agent.filePath !== undefined && path.resolve(session.agent.filePath) === agentFilePath
    );
    if (sameAgent && !session.agent.isSubAgent) {
      matches.push({ session, dirPath });
    }
  }

  matches.sort((a, b) => b.session.time.created - a.session.time.created);
  return matches[0] ?? null;
}

async function readRuntimeSessionDetails(session: { session: SessionInfo; dirPath: string }): Promise<RuntimeSessionDetails> {
  const messages: RuntimeSessionDetails['messages'] = [];
  const entries = await fs.readdir(session.dirPath, { withFileTypes: true }).catch(() => []);
  const messageDirs = entries
    .filter((entry) => entry.isDirectory() && /^[0-9A-Z]{26}$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const messageDir of messageDirs) {
    const messagePath = path.join(session.dirPath, messageDir.name);
    const message = await readJsonFile<Message>(path.join(messagePath, 'message.json'));
    if (!message) continue;

    const parts: Part[] = [];
    const partEntries = await fs.readdir(path.join(messagePath, 'part'), { withFileTypes: true }).catch(() => []);
    for (const partEntry of partEntries) {
      if (!partEntry.isFile() || !partEntry.name.endsWith('.json')) continue;
      const part = await readJsonFile<Part>(path.join(messagePath, 'part', partEntry.name));
      if (part) parts.push(part);
    }

    messages.push({ message, parts });
  }

  return {
    session: session.session,
    dirPath: session.dirPath,
    messages,
  };
}

function getToolInputCommand(part: ToolPart): string | undefined {
  const input = part.state.input;
  if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string') {
    return (input as Record<string, string>).command;
  }
  return undefined;
}

async function extractCommandHeads(command: string): Promise<string[]> {
  try {
    const parsed = await parseBashCommand(command);
    return [...new Set(parsed.map((item) => item.head).filter(Boolean))];
  } catch {
    const first = command.trim().split(/\s+/, 1)[0];
    return first ? [first] : [];
  }
}

function isBlockedCommandError(error: string): boolean {
  return error.includes('Command blocked by agent configuration')
    || error.includes('Command validation failed')
    || error.includes('Command not allowed')
    || error.includes('does not match any allowed pattern');
}

async function collectRuntimeProblems(details: RuntimeSessionDetails): Promise<RuntimeProblem[]> {
  const problems: RuntimeProblem[] = [];

  for (const entry of details.messages) {
    for (const part of entry.parts) {
      if (part.type !== 'tool' || part.state.status !== 'error') continue;
      if (part.tool !== 'tools__bash') continue;
      if (!isBlockedCommandError(part.state.error)) continue;

      const command = getToolInputCommand(part);
      const suggestedAllows = command ? await extractCommandHeads(command) : [];
      problems.push({
        tool: part.tool,
        ...(command && { command }),
        error: part.state.error,
        suggestedAllows,
      });
    }
  }

  return problems;
}

function printRuntimeSuggestion(problem: RuntimeProblem): void {
  const allows = problem.suggestedAllows.filter((allow) => allow !== 'cd');
  if (allows.length === 0) return;

  console.log(chalk.gray('  Suggested global allow:'));
  console.log('  tools:');
  console.log('    bash:');
  console.log('      commands:');
  for (const allow of allows) {
    console.log(`        - ${allow} *`);
  }
}

async function printLastRunAnalysis(
  agentFilePath: string,
  projectRoot: string,
  agent: Awaited<ReturnType<typeof parseAgent>>
): Promise<void> {
  const agentId = computeAgentId(agentFilePath, projectRoot, agent.name);
  const lastSession = await findLatestSessionForAgent(projectRoot, agentId, agentFilePath);

  console.log(chalk.bold('\nRuntime Analysis From Last Run'));
  if (!lastSession) {
    console.log(chalk.gray('No prior sessions found for this agent in the current project.'));
    return;
  }

  const details = await readRuntimeSessionDetails(lastSession);
  const problems = await collectRuntimeProblems(details);
  console.log(chalk.gray(`Session: ${details.session.id} (${details.session.status})`));

  if (problems.length === 0) {
    console.log(chalk.green('No blocked bash commands found in the last run.'));
    return;
  }

  for (const problem of problems) {
    console.log(chalk.red('\nBlocked bash command'));
    if (problem.command) {
      console.log(`  command: ${problem.command}`);
    }
    console.log(`  reason: ${problem.error.split('\n')[0]}`);
    printRuntimeSuggestion(problem);
  }
}

export async function runDoctor(file: string, options: DoctorOptions = {}): Promise<void> {
  const agentFilePath = resolve(file);
  const projectContext = resolveProjectContext(path.dirname(agentFilePath));
  const agent = await parseAgent(agentFilePath);

  console.log(chalk.bold(`Agent: ${agent.name}`));
  console.log(chalk.gray(`File: ${agentFilePath}`));

  if (options.lastRun) {
    await printLastRunAnalysis(agentFilePath, projectContext.projectRoot, agent);
    return;
  }

  const skills = await discoverSkills(projectContext.projectRoot);
  const explicitSkillNames = getExplicitSkillNames(agent.config.skills);
  const visibleSkills = agent.config.skills!.auto
    ? [...skills.values()]
    : explicitSkillNames.flatMap((name) => {
        const skill = skills.get(name);
        return skill ? [skill] : [];
      });
  const estimatedCatalogTokens = estimateSkillCatalogTokens(visibleSkills);
  const skillNames = explicitSkillNames.length > 0
      ? explicitSkillNames
      : agent.config.skills!.auto
        ? [...skills.keys()].filter((skillName) => skillLooksReferenced(agent, skillName))
        : [];

  const unknownExplicit = explicitSkillNames.filter((name) => !skills.has(name));
  const inspectedSkills = skillNames.filter((name) => skills.has(name)).sort();
  const instructionWords = countWords(agent.instructions);
  const estimatedInstructionTokens = estimateTextTokens(agent.instructions);
  const longestInstructionLine = longestLineLength(agent.instructions);

  // Preloaded skills are appended to the instructions in full at run time (see
  // buildRunnerContext in ../runner/preparation.ts), so the agent-body count
  // alone hides them. Build the same text here, with the same trust expansion,
  // so the reported cost matches what the model actually receives.
  const preloadedOutputs = await loadSkillPromptOutputs(
    projectContext.projectRoot,
    expandTrustedSkills(agent.config.tools, skills, agent.config.skills),
    explicitSkillNames.filter((name) => skills.has(name))
  );
  const preloadedCosts = preloadedOutputs
    .map((skill) => ({ name: skill.name, tokens: estimateTextTokens(skill.output) }))
    .sort((a, b) => b.tokens - a.tokens);
  const estimatedPreloadedTokens = preloadedCosts.reduce((total, skill) => total + skill.tokens, 0);

  // Claimed before the preview below loads the store, so this report prints the
  // stranded-corrections notice inside its own Prompt size block rather than
  // letting the store's `logger.warn` land above the report as a stray line.
  // Reported whether or not `learning.apply` is on: corrections left at the
  // pre-0.17 sibling path are equally invisible either way, and an agent that
  // has since turned application off is exactly where nobody would notice.
  //
  // Unconditional, unlike the run-path notice, which stops once the keyed file
  // exists. A diagnostic that reports "corrections file: <new path>" while an
  // old one sits unread beside the agent is answering a question nobody asked.
  const strandedLearnings = strandedLearningsNotice(agentFilePath, projectContext.stateRoot);

  // Learned guidelines are appended to the instructions at run time too, and only
  // the highest-ranked few are: the rest are stored but have no effect on any run.
  // Report both numbers here, because a large learnings file otherwise looks
  // healthy while most of its corrections never reach the model.
  const learningPreview = agent.config.learning?.apply
    ? await previewLearningPrompt(agent, agentFilePath, projectContext.stateRoot)
    : undefined;
  const estimatedLearningTokens = learningPreview ? estimateTextTokens(learningPreview.prompt) : 0;

  const estimatedRequestTokens =
    estimatedInstructionTokens + estimatedPreloadedTokens + estimatedCatalogTokens + estimatedLearningTokens;

  console.log(chalk.bold('\nPrompt size'));
  console.log(`  agent body: ${instructionWords.toLocaleString()} words, ${formatEstimatedTokens(estimatedInstructionTokens)} tokens/model request`);
  console.log(`  longest line: ${longestInstructionLine.toLocaleString()} characters`);
  if (instructionWords > VERY_LARGE_AGENT_BODY_WORDS) {
    console.log(chalk.yellow('  Very large body: split/reference it, or record why the complexity must stay inline.'));
  } else if (instructionWords > LARGE_AGENT_BODY_WORDS) {
    console.log(chalk.yellow('  Large body: compress duplicated rules, rationale, and derivable branches.'));
  }
  if (longestInstructionLine > DENSE_INSTRUCTION_LINE_CHARS) {
    console.log(chalk.yellow('  Dense line: split it into one invariant or branch per line; preserve explicit scope and conditions.'));
  }
  if (preloadedCosts.length > 0) {
    console.log(`  preloaded skill bodies: ${preloadedCosts.length}, ${formatEstimatedTokens(estimatedPreloadedTokens)} tokens/model request`);
    for (const skill of preloadedCosts) {
      console.log(chalk.gray(`    ${skill.name}: ${formatEstimatedTokens(skill.tokens)} tokens`));
    }
    if (estimatedPreloadedTokens > VERY_LARGE_PRELOADED_SKILL_TOKENS) {
      console.log(chalk.yellow('  Very large preloaded skills: their full text ships on every request, including runs that never use them.'));
      console.log(chalk.gray('  Drop the situational ones from `skills:` and let the agent load them on demand.'));
    } else if (estimatedPreloadedTokens > LARGE_PRELOADED_SKILL_TOKENS) {
      console.log(chalk.yellow('  Large preloaded skills: preload only what every run needs; the rest can load on demand.'));
    }
  }
  if (learningPreview) {
    const dormant = learningPreview.total - learningPreview.count - learningPreview.stale;
    console.log(`  learned guidelines: ${learningPreview.count} of ${learningPreview.total} applied, ${formatEstimatedTokens(estimatedLearningTokens)} tokens/model request`);
    if (dormant > 0) {
      console.log(chalk.yellow(`  ${dormant} stored learning${dormant === 1 ? '' : 's'} never reach the model: only the top ${learningPreview.cap} are injected per run.`));
      console.log(chalk.gray(`  Fix: agentuse learnings tidy ${agentFilePath}`));
    }
    if (learningPreview.stale > 0) {
      console.log(chalk.yellow(`  ${learningPreview.stale} learning${learningPreview.stale === 1 ? ' is' : 's are'} stale: the instructions changed since they were vetted. They are held out of injection until the next capture or tidy re-vets them.`));
    }
  }
  // Legacy `learning:` forms that still parse with a narrowed meaning. The
  // parse-time warning prints once and scrolls away; doctor is where the
  // mapping stays discoverable.
  for (const notice of agent.configNotices ?? []) {
    console.log(chalk.yellow(`  ${notice}`));
  }
  // The corrections file no longer sits beside the agent, and its path carries a
  // project digest nobody can construct by hand, so name it here — including for
  // an agent that has captured nothing yet, which is when "where did it go?" is
  // the actual question.
  if (agent.config.learning) {
    console.log(chalk.gray(`  learnings file: ${resolveLearningFilePath(agentFilePath, projectContext.stateRoot)}`));
    // Per-channel and quarantine counts: "capture is producing junk" should be
    // measurable here, not anecdotal.
    try {
      const storedLearnings = await LearningStore.fromAgentFile(agentFilePath, projectContext.stateRoot, agent.name).load();
      const quarantined = storedLearnings.filter((l) => l.state === 'quarantined');
      const byChannel = new Map<string, number>();
      for (const l of storedLearnings) {
        if (l.state === 'retired') continue;
        const channel = l.channel ?? 'legacy';
        byChannel.set(channel, (byChannel.get(channel) ?? 0) + 1);
      }
      if (byChannel.size > 0) {
        console.log(chalk.gray(`  by channel: ${[...byChannel.entries()].map(([channel, n]) => `${channel}:${n}`).join(', ')}`));
      }
      if (quarantined.length > 0) {
        console.log(chalk.yellow(`  ${quarantined.length} learning${quarantined.length === 1 ? '' : 's'} quarantined (failed the vet, never injected):`));
        for (const q of quarantined) {
          console.log(chalk.gray(`    [${q.category}] ${q.title}${q.quarantineReason ? ` — ${q.quarantineReason}` : ''}`));
        }
      }
    } catch {
      // Counts are a diagnostic nicety; an unreadable store is reported elsewhere.
    }
  }
  if (strandedLearnings) {
    for (const line of strandedLearnings.split('\n')) console.log(chalk.yellow(`  ${line}`));
  }
  console.log(chalk.gray(`  total: ${formatEstimatedTokens(estimatedRequestTokens)} tokens/model request (agent body + preloaded skills + skill catalog${learningPreview ? ' + learned guidelines' : ''})`));

  console.log(chalk.bold('\nSkill discovery'));
  console.log(`  mode: ${agent.config.skills!.auto ? 'open' : 'closed'}`);
  console.log(`  discovered: ${skills.size}`);
  console.log(`  visible: ${visibleSkills.length}`);
  console.log(`  preloaded: ${explicitSkillNames.length > 0 ? explicitSkillNames.join(', ') : 'none'}`);
  console.log(`  estimated catalog: ${formatEstimatedTokens(estimatedCatalogTokens)} tokens/model request`);
  // The open-discovery hint below already prescribes `auto: false`; don't print
  // that fix twice when both fire.
  const explainsClosingDiscovery = agent.config.skills!.auto && explicitSkillNames.length > 0;
  if (estimatedCatalogTokens > LARGE_SKILL_CATALOG_TOKENS) {
    const severity = estimatedCatalogTokens > VERY_LARGE_SKILL_CATALOG_TOKENS ? 'Very large' : 'Large';
    console.log(chalk.yellow(`  ${severity} catalog: ${visibleSkills.length} visible skills ship a name and description on every request.`));
    if (!agent.config.skills!.auto) {
      console.log(chalk.gray('  Shorten the listed skills to the ones this agent actually needs.'));
    } else if (!explainsClosingDiscovery) {
      console.log(chalk.gray('  Close discovery with `auto: false` and list only the skills this agent needs.'));
    }
  }
  if (explainsClosingDiscovery) {
    console.log(chalk.yellow('  Listed skills are preloaded; they do not restrict discovery.'));
    console.log(chalk.gray('  Add `auto: false` to expose only the listed skills.'));
  }

  // Per inspected skill: the bash commands it declares (allowed-tools), whether
  // it is trusted, and where trust routes each grant (auto-run vs gated). A skill
  // is a source of grants only when trusted; otherwise its declared commands run
  // only if the author also lists them in tools.bash.commands.
  const skillReports = inspectedSkills.map((name) => {
    const skill = skills.get(name)!;
    const declared = [...new Set((skill.allowedTools ?? [])
      .map((tool) => extractCommandFromAllowedTool(tool))
      .filter((head): head is string => Boolean(head)))].sort();
    const trusted = isSkillTrusted(agent.config.skills, name);
    const granted = trusted ? declared : declared.filter((head) => globallyAllowsCommand(agent, head));
    const notGranted = trusted ? [] : declared.filter((head) => !globallyAllowsCommand(agent, head));
    // Advisory: granted commands that look irreversible and aren't already gated,
    // so the author knows what to consider adding to tools.bash.gated.
    const gatedPatterns = agent.config.tools?.bash?.gated ?? [];
    const shouldConsiderGating = granted.filter((head) =>
      looksEffectful(`${head} *`) && !isEffectful(`${head} x`, gatedPatterns));
    return { name, declared, trusted, granted, notGranted, shouldConsiderGating };
  });

  if (unknownExplicit.length > 0) {
    console.log(chalk.red('\nProblems:'));
    for (const name of unknownExplicit) {
      console.log(`- Explicit skill not found: ${name}`);
    }
  }

  if (trustsAllSkills(agent.config.skills)) {
    console.log(chalk.yellow('\nSkill trust: all skills trusted (skills: trusted)'));
    console.log(chalk.gray('Every discovered skill is granted the bash commands it declares in allowed-tools. Trust is a real decision, like installing an editor extension: gate irreversible commands yourself with tools.bash.gated.'));
  }

  if (skillReports.length > 0) {
    console.log(chalk.bold('\nSkills'));
    for (const report of skillReports) {
      console.log(`\n${chalk.cyan(report.name)}${report.trusted ? chalk.green(' (trusted)') : ''}`);
      if (report.declared.length === 0) {
        console.log(chalk.gray('  Declares no bash commands in allowed-tools.'));
        continue;
      }
      console.log(`  declares: ${report.declared.join(', ')}`);
      if (report.trusted) {
        console.log(`  granted (auto-run): ${report.granted.join(', ')}`);
        if (report.shouldConsiderGating.length > 0) {
          console.log(chalk.yellow(`  looks irreversible, not gated: ${report.shouldConsiderGating.join(', ')}`));
          console.log(chalk.gray(`  Consider gating the irreversible commands under tools.bash.gated (e.g. \`${report.shouldConsiderGating[0]} reply *\`).`));
        }
      } else if (report.notGranted.length > 0) {
        console.log(`  not granted: ${report.notGranted.join(', ')}`);
      }
    }
  }

  const ungrantedSkills = skillReports.filter((report) => report.notGranted.length > 0);
  if (ungrantedSkills.length > 0) {
    console.log(chalk.yellow('\nSome skills declare commands the agent has not granted.'));
    console.log(chalk.gray('Trust a skill to grant the commands it declares:'));
    console.log('skills:');
    if (agent.config.skills!.auto) console.log('  auto: true');
    for (const report of ungrantedSkills) {
      console.log(`  ${report.name}: trusted`);
    }
    console.log(chalk.gray('Or list specific commands yourself under tools.bash.commands. Gate irreversible ones with tools.bash.gated.'));
  }

  if (unknownExplicit.length === 0 && ungrantedSkills.length === 0) {
    console.log(chalk.green('\nNo skill capability problems found.'));
    if (agent.config.skills!.auto && explicitSkillNames.length === 0 && skillReports.length === 0) {
      console.log(chalk.gray('Auto skills are enabled. Define core skills explicitly to include them in static inspection.'));
    }
  }

  // Gated-command heuristic (advisory): allowlisted commands that LOOK effectful
  // but are not covered by a `tools.bash.gated` pattern. Nudge only - AgentUse
  // never auto-gates from a keyword guess (a deploy agent that legitimately pushes
  // should not be force-gated), so this is a suggestion the author can ignore.
  const bashCommands = agent.config.tools?.bash?.commands ?? [];
  const gatedPatterns = agent.config.tools?.bash?.gated ?? [];
  const effectfulNotGated = bashCommands.filter(
    (cmd) => looksEffectful(cmd) && !isEffectful(cmd, gatedPatterns)
  );
  if (effectfulNotGated.length > 0) {
    console.log(chalk.yellow('\nGated commands (heuristic):'));
    for (const cmd of effectfulNotGated) {
      console.log(`- \`${cmd}\` looks effectful but is not gated.`);
    }
    console.log(chalk.gray('\nIf a command performs an irreversible action (post, send, delete, deploy), consider moving it under tools.bash.gated so it runs only after human approval:'));
    console.log('tools:');
    console.log('  bash:');
    console.log('    gated:');
    for (const cmd of effectfulNotGated) {
      console.log(`      - "${cmd}"`);
    }
    console.log(chalk.gray('Advisory only: AgentUse never auto-gates from a keyword guess.'));
  }

  // Wildcard-tail grants (advisory): the verb heuristic above reads the literal
  // pattern text, so it flags `birdc reply *` but not the strictly broader
  // `birdc *` - the wider grant drew the weaker warning. Report the blind spot
  // itself: we cannot see what subcommands these authorize.
  // Stay quiet about a head the author has already reasoned about: a gated entry
  // naming that same program, or any substring-style gated pattern (leading `*`,
  // which cannot be attributed to a head - browser posting is usually written
  // that way). An agent that gates `git push *` still gets nudged about `birdc *`.
  const gatedHeads = new Set(gatedPatterns.map((p) => commandHead(p)));
  const gatedIsUnattributable = gatedPatterns.some((p) => commandHead(p) === undefined);
  const unnamedNotGated = bashCommands.filter(
    (cmd) => grantsUnnamedSubcommands(cmd)
      && !looksEffectful(cmd)
      && !gatedIsUnattributable
      && !gatedHeads.has(commandHead(cmd))
  );
  if (unnamedNotGated.length > 0) {
    console.log(chalk.yellow('\nWildcard command grants (heuristic):'));
    for (const cmd of unnamedNotGated) {
      console.log(`- \`${cmd}\` grants every subcommand, including any this pattern never names.`);
    }
    console.log(chalk.gray('\nIf any of those subcommands is irreversible, list it under tools.bash.gated. Gated wins over commands, so the broad entry above stays usable for reads while the effectful verb needs approval:'));
    console.log('tools:');
    console.log('  bash:');
    console.log('    gated:');
    for (const cmd of unnamedNotGated) {
      console.log(`      - "${cmd.replace(/\*\s*$/, '<subcommand> *')}"`);
    }
    console.log(chalk.gray('Advisory only: a wildcard grant is often correct (read-only CLIs).'));
  }

  // Unpinned interpreter grants: the one entry that voids the rest of the
  // allowlist, since an agent that can write code can do anything the allowlist
  // withheld. Not folded into the advisories above - the remedy is to pin the
  // script, not to gate a verb.
  const arbitraryCode = bashCommands.filter(
    (cmd) => grantsArbitraryCode(cmd) && !isEffectful(cmd, gatedPatterns)
  );
  if (arbitraryCode.length > 0) {
    console.log(chalk.yellow('\nArbitrary code grants (heuristic):'));
    for (const cmd of arbitraryCode) {
      console.log(`- \`${cmd}\` runs code the pattern does not pin, so it can do anything the rest of the allowlist withholds.`);
    }
    console.log(chalk.gray('\nPin what executes, so the allowlist keeps meaning something:'));
    console.log(chalk.gray('    - "python3 scripts/report.py *"     # not "python3 *"'));
    console.log(chalk.gray('If the agent genuinely needs to write its own code, that is a deliberate choice - gate it, or scope the run with sandbox:.'));
  }

  console.log(chalk.gray('\nFor runtime-accurate diagnosis, run `agentuse doctor <agent-file> --last-run`.'));

  if (unknownExplicit.length > 0) {
    process.exitCode = 1;
  }
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Diagnose an AgentUse agent configuration')
    .argument('<file>', 'Agent file to diagnose')
    .option('--last-run', 'Analyze the latest recorded session for this agent')
    .action((file: string, options: DoctorOptions) => {
      runDoctor(file, options).catch((error) => {
        console.error(chalk.red(`Doctor failed: ${(error as Error).message}`));
        process.exit(1);
      });
    });
}
