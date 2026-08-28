import { describe, expect, it } from 'bun:test';
import { buildCodingAgentPrompt } from '../src/cli/serve/web/routes/agent-detail';
import { buildDebugPrompt, buildOnboardingPrompt, onboardingProjectAgents } from '../src/cli/serve/web/components/debug-prompt-button';
import type { AgentRow } from '../src/cli/serve/web/lib/api';

describe('coding-agent handoff prompts', () => {
  it('requires the creator skill before reviewing or editing agent source', () => {
    const prompt = buildCodingAgentPrompt({
      project: 'demo',
      path: 'agents/reporter.agentuse',
      source: '---\nmodel: demo:test\n---\n\nReport.',
      detail: '',
    });

    expect(prompt).toContain('agentuse skills get core --full');
    expect(prompt).toContain('agentuse skills get creator --full');
    expect(prompt).toContain('compressed, not crammed');
    expect(prompt).toContain('agentuse doctor agents/reporter.agentuse');
  });

  it('loads creator conditionally before a debug handoff edits an agent', () => {
    const prompt = buildDebugPrompt({
      sessionId: '01TESTSESSION',
      agentName: 'reporter',
      agentFilePath: 'agents/reporter.agentuse',
    });

    expect(prompt).toContain('Before editing any `.agentuse` file');
    expect(prompt).toContain('agentuse skills get core --full');
    expect(prompt).toContain('agentuse skills get creator --full');
    expect(prompt).toContain('agentuse doctor <agent-file>');
  });

  it('hands onboarding to a coding agent without restarting serve or running real work', () => {
    const prompt = buildOnboardingPrompt({
      sessionId: '01ONBOARDING',
      projectId: 'demo',
      projectPath: '/workspace/acme-automations',
      agentName: 'Getting started',
      model: 'demo:hello',
    }, 'summarize new support tickets every morning');

    expect(prompt).toStartWith('# Create My First Agent\n');
    expect(prompt).toContain('## Project');
    expect(prompt).toContain('## What I Want to Automate');
    expect(prompt).toContain('## Required Workflow');
    expect(prompt).toContain('## Runtime Guardrails');
    expect(prompt).toContain('Help me create my first AgentUse agent in this project.');
    expect(prompt).toContain('agentuse skills get onboarding --full');
    expect(prompt).toContain('AgentUse `serve` is already running');
    expect(prompt).toContain('- **Directory:** /workspace/acme-automations');
    expect(prompt).toContain('project directory is authoritative');
    expect(prompt).toContain('Do not change its project settings or restart it');
    expect(prompt).toContain('agentuse provider list');
    expect(prompt).toContain('agentuse provider login');
    expect(prompt).toContain('open Terminal and run this command myself');
    expect(prompt).toContain('Do not run this interactive login command for me');
    expect(prompt).toContain('Do not ask me to paste API keys');
    expect(prompt).toContain('Use only a model from a confirmed provider');
    expect(prompt).toContain('summarize new support tickets every morning');
  });

  it('uses the CLI bundled inside AgentUse.app for every Desktop onboarding command', () => {
    const bundledCli = "env HOME='/tmp/fresh-home' XDG_DATA_HOME='/tmp/fresh-data' ELECTRON_RUN_AS_NODE=1 '/Users/Example User/Applications/AgentUse.app/Contents/MacOS/AgentUse' '/Users/Example User/Applications/AgentUse.app/Contents/Resources/app.asar/node_modules/agentuse/bin/cli.js'";
    const prompt = buildOnboardingPrompt({
      sessionId: '01DESKTOPONBOARDING',
      projectPath: '/workspace/acme-automations',
    }, '', {
      surface: 'desktop',
      cliCommand: bundledCli,
      serveAlreadyRunning: true,
      providerStatus: {
        credentialStore: '/tmp/fresh-home/.local/share/agentuse/auth.json',
        providers: [
          { id: 'anthropic', name: 'Anthropic', configured: false, sources: [] },
          { id: 'openai', name: 'OpenAI', configured: false, sources: [] },
        ],
        customProviders: [],
      },
    });

    expect(prompt).toContain('## AgentUse CLI');
    expect(prompt).toContain(`\`\`\`sh\n${bundledCli}\n\`\`\``);
    expect(prompt).toContain(`\`\`\`sh\n${bundledCli} skills get onboarding --full\n\`\`\``);
    expect(prompt).toContain(`\`\`\`sh\n${bundledCli} provider list --json\n\`\`\``);
    expect(prompt).toContain(`\`\`\`sh\n${bundledCli} provider login\n\`\`\``);
    expect(prompt).toContain('open Terminal and run this exact command myself');
    expect(prompt).toContain('Do not run this interactive login command for me');
    expect(prompt).toContain('callback URLs into this chat');
    expect(prompt).toContain('AgentUse Desktop owns the running `serve` process');
    expect(prompt).toContain('## Provider Status from AgentUse Desktop');
    expect(prompt).toContain('"credentialStore": "/tmp/fresh-home/.local/share/agentuse/auth.json"');
    expect(prompt).toContain('"configured": false');
    expect(prompt).toContain('Use this status as authoritative');
    expect(prompt).toContain('at least one source with `stored: true`');
    expect(prompt).not.toContain('Before creating a file, check the available AgentUse providers');
    expect(prompt.indexOf('## Provider Status from AgentUse Desktop')).toBeLessThan(
      prompt.indexOf(`${bundledCli} provider list --json`),
    );
    expect(prompt).toContain('CLI bundled inside AgentUse Desktop');
    expect(prompt).toContain('Do not substitute a package-manager installation or bare `agentuse`');
    expect(prompt).not.toContain('\n  agentuse ');
  });
});

describe('first-agent onboarding detection', () => {
  const agent = (projectId: string, runPath: string, name: string): AgentRow => ({
    projectId,
    path: runPath,
    runPath,
    name,
    model: 'openai:gpt-5.6-luna',
  });

  it('detects agents only in the onboarding project', () => {
    const first = agent('first-project', 'agents/hello-world.agentuse', 'hello-world');
    const unrelated = agent('another-project', 'agents/reporter.agentuse', 'reporter');

    expect(onboardingProjectAgents([unrelated, first], 'first-project')).toEqual([first]);
    expect(onboardingProjectAgents([first], undefined)).toEqual([]);
  });

  it('retains every match so multiple agents route to the project instead of guessing', () => {
    const first = agent('first-project', 'agents/hello-world.agentuse', 'hello-world');
    const second = agent('first-project', 'agents/daily-brief.agentuse', 'daily-brief');

    expect(onboardingProjectAgents([first, second], 'first-project')).toEqual([first, second]);
  });
});
