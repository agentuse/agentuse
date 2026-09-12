import { Command } from 'commander';
import { resolve } from 'node:path';
import { parseAgent } from '../parser';
import { resolveMockScope } from '../runner/mock-tools';
const isURL = (value: string) => /^https?:\/\//.test(value);

export interface RunCommandOptions {
  quiet?: boolean; debug?: boolean; codeMode?: boolean; tty?: boolean; noTty?: boolean; compact?: boolean;
  timeout: string; directory?: string; envFile?: string; model?: string; sessionId?: string;
  json?: boolean; mock?: boolean; mockModel?: string; mockApproval?: boolean | string; mockGated?: boolean; replay?: string;
  resultSession?: string; selectorModel?: string; judge?: string;
}
type TestOptions = RunCommandOptions & { scope?: string; approval?: string; session?: string };

function common(command: Command): Command {
  return command
    .option('-q, --quiet', 'Suppress informational output')
    .option('-d, --debug', 'Show detailed logging')
    .option('--no-tty', 'Disable terminal animations')
    .option('--compact', 'Use a compact header')
    .option('--timeout <seconds>', 'Maximum execution time in seconds', '300')
    .option('-C, --directory <path>', 'Use this project directory')
    .option('--env-file <path>', 'Load a custom environment file')
    .option('-m, --model <model>', 'Override the agent model')
    .option('--json', 'Print a structured report');
}
function workflowOptions(command: Command, legacy: boolean): Command {
  return common(command)
    .option('--no-code-mode', 'Disable code_exec for comparison')
    .option('--scope <scope>', legacy ? 'Mock all or gated tools (default: adaptive)' : 'Mock all tools (default), or gated bash only; other tools run live', legacy ? undefined : 'all')
    .option('--approval <decision>', 'Simulate approve, reject, or comment:<text> (default: approve)')
    .option('--mock-model <model>', 'Model generating simulated tool responses; or set AGENTUSE_MOCK_MODEL');
}

export function registerTestCommands(program: Command, run: (file: string, prompt: string[], options: RunCommandOptions) => Promise<void>): void {
  program.enablePositionalOptions();
  const test = workflowOptions(program.command('test [file] [prompt...]').enablePositionalOptions()
    .description('Test workflow behavior or compare a result using evidence from a past job'), true)
    .option('--replay <session-id>', 'Compatibility: strict recorded-tool replay; stops on missing inputs')
    .addHelpText('after', '\nChoose what to test:\n  test workflow <agent>                 Does the agent carry out its steps correctly?\n  test result <agent> --session <id>    What result do updated instructions produce from the same evidence?\n\nCompatibility: test <agent> retains adaptive mocking; test <agent> --replay <id> retains strict replay.\n');

  // The parent advertises the two jobs; legacy flags remain accepted.
  for (const option of test.options) option.hideHelp();

  async function flow(command: Command, file: string, prompt: string[], options: TestOptions, legacy: boolean) {
    if (options.scope && !['all', 'gated'].includes(options.scope)) command.error('Invalid --scope. Use all or gated.');
    if (options.approval && !['approve', 'reject'].includes(options.approval) && !/^comment:.+/.test(options.approval)) command.error('Invalid --approval. Use approve, reject, or comment:<text>.');
    let scope = options.scope ?? 'all';
    if (legacy && !options.scope) {
      try { scope = resolveMockScope((await parseAgent(options.directory ? resolve(options.directory, file) : file)).config); }
      catch { /* The shared run pipeline reports parsing errors. */ }
    }
    const { scope: _scope, approval, ...rest } = options;
    await run(file, prompt, { ...rest, ...(scope === 'all' ? { mock: true } : { mockGated: true }), mockApproval: approval ?? 'approve' });
  }
  test.action(async (file: string | undefined, prompt: string[], options: TestOptions) => {
    if (!file) { test.outputHelp(); return; }
    if (options.replay) {
      if (options.scope || options.approval || options.mockModel || prompt.length || isURL(file)) test.error('--replay requires a local agent and recorded prompt; do not combine with --scope, --approval, --mock-model, or a new prompt.');
      await run(file, [], options);
    } else await flow(test, file, prompt, options, true);
  });
  // Options belong after the mode. Do not silently ignore parent-level flags.
  test.hook('preSubcommand', () => {
    for (const key of Object.keys(test.opts())) {
      if (test.getOptionValueSource(key) === 'cli') test.error(`Place test options after workflow or result (received --${key} before the mode).`);
    }
  });
  const workflow = workflowOptions(test.command('workflow <agent> [prompt...]')
    .description('Check the agent’s steps and approval branches using simulated tool responses'), false)
    .addHelpText('after', '\nExamples:\n  agentuse test workflow reply.agentuse --mock-model openai:gpt-5.4-nano\n  agentuse test workflow reply.agentuse --approval reject\n\nCompletion is not a quality verdict. --scope gated runs non-gated tools live.\n');
  workflow.action((file: string, prompt: string[], options: TestOptions) => flow(workflow, file, prompt, options, false));
  const result = common(test.command('result <agent>')
    .description('Generate a new result from a past job’s evidence and compare it with the original'))
    .requiredOption('--session <id>', 'Past real session supplying the task and evidence')
    .option('--selector-model <model>', 'Model selecting source evidence on first use (default: agent model)')
    .option('--judge <agent>', 'Local judge agent defining quality criteria; runs without tools')
    .addHelpText('after', '\nExample:\n  agentuse test result reply.agentuse --session <id>\n\nReuses saved evidence after the first extraction. Uses current instructions and explicit references.\nNo research, publishing, workflow tools, or approval decisions execute.\nWithout --judge, the result is a comparison, not a pass or an improvement claim.\n');
  result.action(async (file: string, options: TestOptions) => {
    if (isURL(file) || (options.judge && isURL(options.judge))) result.error('Result tests require local agent files.');
    const { session, ...rest } = options;
    await run(file, [], { ...rest, resultSession: session! });
  });
}
