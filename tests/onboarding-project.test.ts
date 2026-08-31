import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FIRST_PROJECT_DEFAULT_NAME, managedProjectSlug, terminalFirstAgentPrompt, validateManagedProjectName } from '../src/onboarding';
import { getManagedProjectsRoot, removeServeProject } from '../src/utils/global-config';
import { createManagedProject, createManagedProjectTransaction, rollbackManagedProject } from '../src/utils/managed-project';
import { createSetupCommand, resolveSetupSurface, webSetupServeArgs } from '../src/cli/setup';

describe('managed onboarding projects', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('creates a readable filesystem-safe slug', () => {
    expect(FIRST_PROJECT_DEFAULT_NAME).toBe('my-agents');
    expect(managedProjectSlug('  My Support Agents  ')).toBe('my-support-agents');
    expect(validateManagedProjectName('Résumé triage')).toEqual({ name: 'Résumé triage', slug: 'resume-triage' });
    expect(() => validateManagedProjectName('../')).toThrow('letter or number');
  });

  it('stores managed projects beside the selected config and preserves unrelated fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-onboarding-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      env: { KEEP: 'yes' },
      future: { keep: true },
      serve: { projects: [], port: 14444, brand: { name: 'Acme' } },
    }));
    const projectRoot = join(getManagedProjectsRoot(configPath), 'my-agents');

    const created = await createManagedProject('my-agents', { configPath });

    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(created).toEqual({ id: 'my-agents', name: 'my-agents', root: projectRoot });
    expect(existsSync(join(projectRoot, 'agents'))).toBe(true);
    expect(existsSync(join(projectRoot, '.agentuse'))).toBe(true);
    expect(readFileSync(join(projectRoot, 'ABOUT.md'), 'utf8')).toContain('name: "my-agents"');
    expect(saved.env).toEqual({ KEEP: 'yes' });
    expect(saved.future).toEqual({ keep: true });
    expect(saved.serve.port).toBe(14444);
    expect(saved.serve.brand).toEqual({ name: 'Acme' });
    expect(saved.serve.projects).toEqual([{ id: 'my-agents', path: projectRoot }]);
    expect(saved.serve.default).toBeUndefined();
  });

  it('never overwrites an existing managed project directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-onboarding-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const projectRoot = join(getManagedProjectsRoot(configPath), 'my-agents');
    const first = await createManagedProject('my-agents', { configPath });
    expect(first.root).toBe(projectRoot);
    await expect(createManagedProject('my-agents', { configPath })).rejects.toThrow('already exists');
  });

  it('disconnects a saved project without deleting files or unrelated config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-onboarding-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const keepPath = join(root, 'keep');
    const removePath = join(root, 'remove');
    writeFileSync(configPath, JSON.stringify({
      future: { keep: true },
      serve: {
        port: 14444,
        default: 'remove',
        projects: [{ id: 'keep', path: keepPath }, { id: 'remove', path: removePath }],
      },
    }));
    writeFileSync(removePath, 'project data');

    removeServeProject({ id: 'remove', path: removePath }, configPath);

    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.future).toEqual({ keep: true });
    expect(saved.serve.port).toBe(14444);
    expect(saved.serve.projects).toEqual([{ id: 'keep', path: keepPath }]);
    expect(saved.serve.default).toBeUndefined();
    expect(readFileSync(removePath, 'utf8')).toBe('project data');
  });

  it('can stage an unregistered project and roll it back after attachment failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-onboarding-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ serve: { projects: [] } }));

    const created = await createManagedProject('my-agents', { configPath, register: false });

    expect(existsSync(created.root)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).serve.projects).toEqual([]);
    await rollbackManagedProject(created);
    expect(existsSync(created.root)).toBe(false);
  });

  it('rolls back files and config when runtime attachment rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-onboarding-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ serve: { projects: [] } }));
    const projectRoot = join(getManagedProjectsRoot(configPath), 'my-agents');

    await expect(createManagedProjectTransaction(
      'my-agents',
      async () => { throw new Error('worker startup rejected'); },
      { configPath },
    )).rejects.toThrow('worker startup rejected');

    expect(existsSync(projectRoot)).toBe(false);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).serve.projects).toEqual([]);
  });

  it('selects browser or terminal setup without guessing in non-interactive shells', () => {
    expect(resolveSetupSurface({ web: true }, false)).toBe('web');
    expect(resolveSetupSurface({ terminal: true }, false)).toBe('terminal');
    expect(resolveSetupSurface({ yes: true }, false)).toBe('terminal');
    expect(resolveSetupSurface({}, true)).toBe('prompt');
    expect(() => resolveSetupSurface({}, false)).toThrow('--web or --terminal');
    expect(() => resolveSetupSurface({ web: true, terminal: true }, true)).toThrow('not both');
  });

  it('forwards Web setup transport and authentication options to serve', () => {
    expect(webSetupServeArgs({
      host: '0.0.0.0',
      port: '12233',
      auth: false,
    })).toEqual(['--open', '--port', '12233', '--host', '0.0.0.0', '--no-auth']);
    expect(webSetupServeArgs({})).toEqual(['--open']);

    const command = createSetupCommand();
    command.parseOptions(['--web', '--no-auth']);
    expect(command.opts()).toMatchObject({ web: true, auth: false });
  });

  it('gives coding agents a terminal-specific first-agent handoff', () => {
    const prompt = terminalFirstAgentPrompt('/tmp/my-agents');
    expect(prompt).toContain('onboarding skill for terminal setup');
    expect(prompt).toContain('Project directory: /tmp/my-agents');
    expect(prompt).toContain('agentuse provider list');
    expect(prompt).toContain('agentuse provider login');
    expect(prompt).toContain('my own terminal');
    expect(prompt).toContain('interactive login or ask me to paste credentials');
    expect(prompt).toContain('callback');
    expect(prompt).toContain('using only that provider');
    expect(prompt).toMatch(/agentuse\s+doctor and agentuse test/);
    expect(prompt).toContain('exact agentuse run command');
    expect(prompt).toContain('Do not perform a real run yet');
  });

  it('requires a runnable provider before the onboarding skill creates an agent', () => {
    const skill = readFileSync(join(process.cwd(), 'skill-data/onboarding/SKILL.md'), 'utf8');
    const providerStep = skill.indexOf('## 2. Confirm a Provider Before Creating Anything');
    const createStep = skill.indexOf('## 3. Create It in the Confirmed Project');

    expect(providerStep).toBeGreaterThan(-1);
    expect(createStep).toBeGreaterThan(providerStep);
    expect(skill).toContain('agentuse provider list');
    expect(skill).toContain('do not write the agent file yet');
    expect(skill).toContain('use only a model from that provider');
  });
});
