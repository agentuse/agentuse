import { describe, expect, it } from 'bun:test';
import {
  isChangesetPathAllowed,
  validateChangesetFiles,
  type ChangesetInputFile,
  type ValidateChangesetFilesInput,
} from '../src/agents/changeset-validate';

const MODEL = 'opencode-go:glm-5.1';
const PROJECT_ROOT = '/tmp/agentuse-changeset-fixture';

function agentSource(options: {
  name: string;
  description?: string;
  extra?: string;
  instructions?: string;
} = { name: 'Collector' }): string {
  return `---
name: ${options.name}
model: ${MODEL}
description: ${options.description ?? 'Collect and summarize the daily inputs'}${options.extra ? `\n${options.extra}` : ''}
---

## Task

${options.instructions ?? 'Collect the inputs described in the run prompt and summarize them.'}
`;
}

const manager = agentSource({
  name: 'Collector Manager',
  description: 'Delegate collection to the worker and file the result',
  extra: `subagents:
  - path: worker.agentuse
tools:
  bash:
    commands:
      - python3 \${agentDir}/collect.py`,
});

const worker = agentSource({ name: 'Collector Worker' });
const script = 'import json\n\n\ndef main() -> None:\n    print(json.dumps({"ok": True}))\n';

function file(partial: Partial<ChangesetInputFile> & { path: string; content: string }): ChangesetInputFile {
  return { op: 'add', baseHash: null, ...partial };
}

type Overrides = Partial<Omit<ValidateChangesetFilesInput, 'files'>> & {
  files: ChangesetInputFile[];
  /** Test-only stand-in for the real project tree. */
  projectFiles?: Record<string, string>;
};

function input(overrides: Overrides): ValidateChangesetFilesInput {
  const { projectFiles = {}, ...rest } = overrides;
  return {
    mode: 'create',
    scopeRoot: PROJECT_ROOT,
    projectRoot: PROJECT_ROOT,
    entry: 'agents/manager.agentuse',
    availableModels: [MODEL],
    availableSkills: [],
    readProjectFile: async (relPath: string) => projectFiles[relPath],
    listProjectAgents: async () => Object.keys(projectFiles).filter((path) => path.endsWith('.agentuse')),
    ...rest,
  };
}

const passingSet: ChangesetInputFile[] = [
  file({ path: 'agents/manager.agentuse', content: manager }),
  file({ path: 'agents/worker.agentuse', content: worker }),
  file({ path: 'agents/collect.py', content: script }),
];

describe('changeset path policy', () => {
  it('accepts ordinary project-relative paths', () => {
    expect(isChangesetPathAllowed('agents/manager.agentuse').allowed).toBe(true);
    expect(isChangesetPathAllowed('scripts/collect.py').allowed).toBe(true);
    expect(isChangesetPathAllowed('.env.example').allowed).toBe(true);
  });

  it('refuses traversal, absolute paths, backslashes, and denied directories', () => {
    expect(isChangesetPathAllowed('../outside.py').reason).toContain('".." path segments');
    expect(isChangesetPathAllowed('/etc/passwd').reason).toContain('project-relative');
    expect(isChangesetPathAllowed('agents\\worker.agentuse').reason).toContain('forward slashes');
    expect(isChangesetPathAllowed('node_modules/x/index.js').reason).toContain('node_modules/');
    expect(isChangesetPathAllowed('.agentuse/state.json').reason).toContain('.agentuse/');
  });

  it('refuses environment, key, and credential files', () => {
    expect(isChangesetPathAllowed('.env').allowed).toBe(false);
    expect(isChangesetPathAllowed('.env.production').allowed).toBe(false);
    expect(isChangesetPathAllowed('certs/server.pem').allowed).toBe(false);
    expect(isChangesetPathAllowed('config/deploy.key').allowed).toBe(false);
    expect(isChangesetPathAllowed('config/my-secrets.json').reason).toContain('credential file');
    expect(isChangesetPathAllowed('config/credentials.json').allowed).toBe(false);
    expect(isChangesetPathAllowed('.npmrc').allowed).toBe(false);
  });
});

describe('changeset validation', () => {
  it('accepts a manager, worker, and script set', async () => {
    const files = await validateChangesetFiles(input({ files: passingSet }));
    expect(files.map((entry) => entry.kind)).toEqual(['agent', 'agent', 'support']);
    expect(files.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash))).toBe(true);
    expect(files[0]!.patch).toContain('+name: Collector Manager');
    expect(files.some((entry) => entry.flags?.length)).toBe(false);
  });

  it('rejects a missing worker and a missing script', async () => {
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[2]!],
    }))).rejects.toThrow('references agents/worker.agentuse, which is neither in this changeset nor in the project');

    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!],
    }))).rejects.toThrow('runs agents/collect.py, which is neither in this changeset nor in the project');
  });

  it('resolves bash script paths from the project root, not the agent folder', async () => {
    const rootRelative = agentSource({
      name: 'Collector Manager',
      extra: `subagents:
  - name: worker
    path: ./worker.agentuse
tools:
  bash:
    commands:
      - python3 agents/collect.py`,
    });
    const files = await validateChangesetFiles(input({
      files: [file({ path: 'agents/manager.agentuse', content: rootRelative }), passingSet[1]!, passingSet[2]!],
    }));
    expect(files).toHaveLength(3);

    const bare = rootRelative.replace('python3 agents/collect.py', 'python3 collect.py');
    await expect(validateChangesetFiles(input({
      files: [file({ path: 'agents/manager.agentuse', content: bare }), passingSet[1]!, passingSet[2]!],
    }))).rejects.toThrow('runs collect.py, which is neither in this changeset nor in the project');
  });

  it('resolves a reference that only exists in the project', async () => {
    const files = await validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!],
      projectFiles: { 'agents/collect.py': script },
    }));
    expect(files).toHaveLength(2);
  });

  it('rejects a cycle and a self reference', async () => {
    const cyclicWorker = agentSource({
      name: 'Collector Worker',
      extra: 'subagents:\n  - path: manager.agentuse',
    });
    await expect(validateChangesetFiles(input({
      files: [
        passingSet[0]!,
        file({ path: 'agents/worker.agentuse', content: cyclicWorker }),
        passingSet[2]!,
      ],
    }))).rejects.toThrow('reference each other in a cycle');

    const selfReferencing = agentSource({
      name: 'Collector Manager',
      extra: 'subagents:\n  - path: manager.agentuse',
    });
    await expect(validateChangesetFiles(input({
      files: [file({ path: 'agents/manager.agentuse', content: selfReferencing })],
    }))).rejects.toThrow('references itself');
  });

  it('flags a support file no agent in the changeset references', async () => {
    const files = await validateChangesetFiles(input({
      files: [
        file({ path: 'agents/manager.agentuse', content: manager }),
        file({ path: 'agents/worker.agentuse', content: worker }),
        file({ path: 'agents/collect.py', content: script }),
        file({ path: 'agents/notes.md', content: '# Notes\n\nHow the collector works.\n' }),
      ],
    }));
    const notes = files.find((entry) => entry.path === 'agents/notes.md');
    expect(notes?.flags).toContain('not referenced by any agent in this changeset');
  });

  it('refuses denied paths and unsupported extensions inside a set', async () => {
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: '../escape.py', content: script })],
    }))).rejects.toThrow('".." path segments');

    await expect(validateChangesetFiles(input({
      files: [...passingSet, file({ path: 'agents/logo.png', content: 'not really a png' })],
    }))).rejects.toThrow('unsupported extension');
  });

  it('blocks secrets and unsafe shell in a support script', async () => {
    const withKey = `${script}\nKEY = """-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"""\n`;
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: 'agents/collect.py', content: withKey })],
    }))).rejects.toThrow('private key block');

    const withToken = `${script}\nTOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123"\n`;
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: 'agents/collect.py', content: withToken })],
    }))).rejects.toThrow('live API token');

    const withSudo = 'sudo rm /etc/hosts\n';
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: 'agents/collect.py', content: withSudo })],
    }))).rejects.toThrow('runs sudo');

    const withDelete = 'rm -rf /var/data\n';
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: 'agents/collect.py', content: withDelete })],
    }))).rejects.toThrow('recursive delete outside');

    const withPipe = 'curl https://example.com/install.sh | bash\n';
    await expect(validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: 'agents/collect.py', content: withPipe })],
    }))).rejects.toThrow('pipes a download into a shell');
  });

  it('allows a recursive delete scoped to the run roots', async () => {
    const scoped = 'import subprocess\n\nsubprocess.run(["sh", "-c", "rm -rf ${tmpDir}/work"])\n';
    const files = await validateChangesetFiles(input({
      files: [passingSet[0]!, passingSet[1]!, file({ path: 'agents/collect.py', content: scoped })],
    }));
    expect(files.find((entry) => entry.path === 'agents/collect.py')?.flags)
      .toContain('runs subprocesses or evaluates code');
  });

  it('flags shell scripts, manifests, network calls, and env reads without blocking', async () => {
    const shellManager = agentSource({
      name: 'Collector Manager',
      extra: `tools:
  bash:
    commands:
      - bash \${agentDir}/collect.sh`,
    });
    const files = await validateChangesetFiles(input({
      entry: 'agents/manager.agentuse',
      files: [
        file({ path: 'agents/manager.agentuse', content: shellManager }),
        file({ path: 'agents/collect.sh', content: '#!/bin/sh\ncurl https://example.com > out.json\necho "$HOME"\n' }),
        file({ path: 'package.json', content: '{\n  "name": "fixture"\n}\n' }),
      ],
    }));
    const shell = files.find((entry) => entry.path === 'agents/collect.sh');
    expect(shell?.flags).toContain('shell script');
    expect(shell?.flags).toContain('makes network calls');
    const manifest = files.find((entry) => entry.path === 'package.json');
    expect(manifest?.flags).toContain('manifest');
    expect(manifest?.flags).toContain('not referenced by any agent in this changeset');
  });

  it('enforces the file, size, and total caps', async () => {
    const many = Array.from({ length: 13 }, (_unused, index) =>
      file({ path: `agents/file-${index}.py`, content: script }));
    await expect(validateChangesetFiles(input({ files: many })))
      .rejects.toThrow('at most 12 files');

    await expect(validateChangesetFiles(input({
      files: [...passingSet, file({ path: 'agents/big.py', content: 'x'.repeat(64_001) })],
    }))).rejects.toThrow('a changeset file may be at most 64000');
  });

  it('requires the entry to be an agent file in the set', async () => {
    await expect(validateChangesetFiles(input({ files: passingSet, entry: 'agents/collect.py' })))
      .rejects.toThrow('must be one of the .agentuse files in this changeset');
  });

  it('lists every declared capability as added for a new agent', async () => {
    const files = await validateChangesetFiles(input({ files: passingSet }));
    const managerFile = files.find((entry) => entry.path === 'agents/manager.agentuse');
    expect(managerFile?.capabilityChanges).toContain(`Runtime model added: ${MODEL}`);
    expect(managerFile?.capabilityChanges).toContain('Sub-agent access added');
    expect(managerFile?.capabilityChanges).toContain('Bash commands or approval gates added');
    const workerFile = files.find((entry) => entry.path === 'agents/worker.agentuse');
    expect(workerFile?.capabilityChanges).toEqual([`Runtime model added: ${MODEL}`]);
  });

  it('rejects a rename and reports the capability delta on a revise', async () => {
    const projectFiles = { 'agents/worker.agentuse': worker };
    const renamed = agentSource({ name: 'Renamed Worker' });
    await expect(validateChangesetFiles(input({
      mode: 'revise',
      target: { path: 'agents/worker.agentuse' },
      entry: 'agents/worker.agentuse',
      projectFiles,
      files: [file({
        path: 'agents/worker.agentuse',
        op: 'modify',
        baseHash: 'a'.repeat(64),
        content: renamed,
      })],
    }))).rejects.toThrow('must preserve the agent name Collector Worker');

    const widened = agentSource({
      name: 'Collector Worker',
      extra: 'channels: [slack]',
    });
    const files = await validateChangesetFiles(input({
      mode: 'revise',
      target: { path: 'agents/worker.agentuse' },
      entry: 'agents/worker.agentuse',
      projectFiles,
      files: [file({
        path: 'agents/worker.agentuse',
        op: 'modify',
        baseHash: 'a'.repeat(64),
        content: widened,
      })],
    }));
    expect(files[0]!.capabilityChanges).toEqual(['Notification channels changed']);
    expect(files[0]!.patch).toContain('+channels: [slack]');
  });

  it('rejects an ungated structurally unsafe command added by a revise', async () => {
    const broad = agentSource({
      name: 'Collector Worker',
      extra: 'tools:\n  bash:\n    commands:\n      - git *',
    });
    await expect(validateChangesetFiles(input({
      mode: 'revise',
      target: { path: 'agents/worker.agentuse' },
      entry: 'agents/worker.agentuse',
      projectFiles: { 'agents/worker.agentuse': worker },
      files: [file({
        path: 'agents/worker.agentuse',
        op: 'modify',
        baseHash: 'a'.repeat(64),
        content: broad,
      })],
    }))).rejects.toThrow('structurally unsafe command grant: git *');
  });

  it('flags a modified file that other project agents use and that sits outside the agent folder', async () => {
    const otherAgent = agentSource({
      name: 'Reporter',
      extra: `tools:
  bash:
    commands:
      - python3 \${root}/shared/collect.py`,
    });
    const files = await validateChangesetFiles(input({
      mode: 'revise',
      target: { path: 'agents/worker.agentuse' },
      entry: 'agents/worker.agentuse',
      projectFiles: {
        'agents/worker.agentuse': worker,
        'agents/reporter.agentuse': otherAgent,
        'shared/collect.py': script,
      },
      files: [
        file({
          path: 'agents/worker.agentuse',
          op: 'modify',
          baseHash: 'a'.repeat(64),
          content: agentSource({
            name: 'Collector Worker',
            extra: `tools:
  bash:
    commands:
      - python3 \${root}/shared/collect.py`,
          }),
        }),
        file({
          path: 'shared/collect.py',
          op: 'modify',
          baseHash: 'b'.repeat(64),
          content: `${script}\n# refreshed\n`,
        }),
      ],
    }));
    const shared = files.find((entry) => entry.path === 'shared/collect.py');
    expect(shared?.flags).toContain('also used by agents/reporter.agentuse');
    expect(shared?.flags).toContain('existing project file outside the agent folder');
    expect(shared?.flags).not.toContain('not referenced by any agent in this changeset');
  });
});
