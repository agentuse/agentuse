import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  isProjectDiscoveryPathAllowed,
  prepareProjectDiscoveryView,
  readProjectDiscoveryFile,
} from '../src/agents/discover';

// Each escape attempt sets up a real project next to a real "outside" folder
// holding a secret, then proves the reader refuses to hand that secret back.
const SECRET = 'outside-secret-value';
let base: string;
let project: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(os.tmpdir(), 'discover-sandbox-')));
  project = join(base, 'project');
  outside = join(base, 'other');
  await mkdir(join(project, 'docs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Project');
  await writeFile(join(project, 'docs', 'guide.md'), 'nested guide');
  await writeFile(join(outside, 'README.md'), SECRET);
  await writeFile(join(outside, 'guide.md'), SECRET);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = (relativePath: string, maxBytes = 16_000) => readProjectDiscoveryFile(project, relativePath, maxBytes);

describe('project file reader: path text', () => {
  it('refuses a sibling folder through ..', async () => {
    expect(await read('../other/README.md')).toBeUndefined();
  });

  it('refuses an absolute path', async () => {
    expect(await read('/etc/passwd')).toBeUndefined();
  });

  it('refuses .. in the middle of a path', async () => {
    expect(await read('docs/../../other/README.md')).toBeUndefined();
  });

  it('refuses backslash separators', async () => {
    expect(await read('docs\\..\\README.md')).toBeUndefined();
  });

  it('refuses a NUL byte', async () => {
    expect(await read('README.md\0.txt')).toBeUndefined();
  });

  it('refuses a newline', async () => {
    await writeFile(join(project, 'a\nb.md'), 'newline name');
    expect(await read('a\nb.md')).toBeUndefined();
  });

  it('refuses a path over 512 characters', async () => {
    expect(await read(`${'a/'.repeat(256)}x`)).toBeUndefined();
  });
});

describe('project file reader: links', () => {
  it('refuses a file symlink to an outside file', async () => {
    await symlink(join(outside, 'README.md'), join(project, 'linked.md'));
    expect(await read('linked.md')).toBeUndefined();
  });

  it('refuses a directory symlink in the middle of the path', async () => {
    await symlink(outside, join(project, 'docs-link'));
    expect(await read('docs-link/guide.md')).toBeUndefined();
  });

  it('refuses a hard link to an outside file', async () => {
    await link(join(outside, 'README.md'), join(project, 'hard.md'));
    expect(await read('hard.md')).toBeUndefined();
  });

  it('refuses a symlink to /dev/zero', async () => {
    await symlink('/dev/zero', join(project, 'zero'));
    expect(await read('zero')).toBeUndefined();
  });

  it('refuses a FIFO', async () => {
    execFileSync('mkfifo', [join(project, 'pipe')]);
    expect(await read('pipe')).toBeUndefined();
  });
});

describe('project file reader: folder swapped during the read', () => {
  // The reader exposes two hooks at the exact points a racing process would act,
  // so the swap is deterministic instead of a timing loop.
  const swapDocsToOutside = async () => {
    await rename(join(project, 'docs'), join(project, 'docs-real'));
    await symlink(outside, join(project, 'docs'));
  };
  const swapDocsBack = async () => {
    await rm(join(project, 'docs'));
    await rename(join(project, 'docs-real'), join(project, 'docs'));
  };

  it('refuses when a checked folder becomes a symlink before the open', async () => {
    const buffer = await readProjectDiscoveryFile(project, 'docs/guide.md', 16_000, { beforeOpen: swapDocsToOutside });
    expect(buffer).toBeUndefined();
  });

  it('refuses when the folder is swapped back after the open (identity check)', async () => {
    const buffer = await readProjectDiscoveryFile(project, 'docs/guide.md', 16_000, {
      beforeOpen: swapDocsToOutside,
      afterOpen: swapDocsBack,
    });
    expect(buffer).toBeUndefined();
  });

  it('refuses a hard link made after the open (nlink on the identity check)', async () => {
    const buffer = await readProjectDiscoveryFile(project, 'docs/guide.md', 16_000, {
      beforeOpen: swapDocsToOutside,
      afterOpen: async () => {
        await swapDocsBack();
        await rm(join(project, 'docs', 'guide.md'));
        await link(join(outside, 'guide.md'), join(project, 'docs', 'guide.md'));
      },
    });
    expect(buffer).toBeUndefined();
  });

  it('does not hang when the file is replaced by a FIFO before the open', async () => {
    const buffer = await readProjectDiscoveryFile(project, 'README.md', 16_000, {
      beforeOpen: async () => {
        await rm(join(project, 'README.md'));
        execFileSync('mkfifo', [join(project, 'README.md')]);
      },
    });
    expect(buffer).toBeUndefined();
  });
});

describe('project file reader: size', () => {
  it('returns at most the byte cap', async () => {
    await writeFile(join(project, 'big.txt'), 'x'.repeat(5_000));
    const buffer = await read('big.txt', 100);
    expect(buffer?.length).toBe(100);
  });
});

describe('project file reader: allowed files', () => {
  it('reads a normal file', async () => {
    expect((await read('README.md'))?.toString()).toBe('# Project');
  });

  it('reads a nested normal file', async () => {
    expect((await read('docs/guide.md'))?.toString()).toBe('nested guide');
  });

  it('reads .env.example', async () => {
    await writeFile(join(project, '.env.example'), 'API_URL=');
    expect(isProjectDiscoveryPathAllowed('.env.example')).toBe(true);
    expect((await read('.env.example'))?.toString()).toBe('API_URL=');
  });
});

describe('project path filter: secret names', () => {
  it('blocks .ENV in any case', () => {
    expect(isProjectDiscoveryPathAllowed('.ENV')).toBe(false);
  });

  it('blocks files inside a Secrets folder', () => {
    expect(isProjectDiscoveryPathAllowed('Secrets/app.yaml')).toBe(false);
  });

  it('blocks files inside a credentials folder', () => {
    expect(isProjectDiscoveryPathAllowed('credentials/x.txt')).toBe(false);
  });

  it('blocks a blocked name written in NFD or compatibility lookalike form', () => {
    // NFD "Secréts" stays distinct after NFC, so the real lookalike risk is
    // a compatibility form: fullwidth "ｓｅｃｒｅｔｓ" folds to "secrets" under NFKC.
    expect(isProjectDiscoveryPathAllowed('ｓｅｃｒｅｔｓ/app.yaml')).toBe(false);
    expect(isProjectDiscoveryPathAllowed('．ｅｎｖ')).toBe(false);
  });

  it('makes the reader itself refuse secret names, not only the view', async () => {
    await writeFile(join(project, '.env'), 'TOKEN=x');
    await mkdir(join(project, 'secrets'));
    await writeFile(join(project, 'secrets', 'prod.yaml'), 'key: x');
    expect(await read('.env')).toBeUndefined();
    expect(await read('secrets/prod.yaml')).toBeUndefined();
  });

  it('keeps ordinary source folders such as src/auth', () => {
    expect(isProjectDiscoveryPathAllowed('src/auth/session.ts')).toBe(true);
  });
});

describe('project discovery view', () => {
  it('skips a binary file', async () => {
    await writeFile(join(project, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const view = await prepareProjectDiscoveryView(project);
    try {
      expect(view.availableFiles).toContain('README.md');
      expect(view.availableFiles).not.toContain('image.bin');
    } finally {
      await view.cleanup();
    }
  });

  it('leaves out files git ignores', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    await writeFile(join(project, '.gitignore'), 'private-notes.md\n');
    await writeFile(join(project, 'private-notes.md'), 'ignored notes');
    const view = await prepareProjectDiscoveryView(project);
    try {
      expect(view.availableFiles).toContain('README.md');
      expect(view.availableFiles).toContain('docs/guide.md');
      expect(view.availableFiles).not.toContain('private-notes.md');
    } finally {
      await view.cleanup();
    }
  });

  it('keeps a file whose name is stored in NFD', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    await writeFile(join(project, 'café.md'.normalize('NFD')), 'accented name');
    const view = await prepareProjectDiscoveryView(project);
    try {
      expect(view.availableFiles.map((file) => file.normalize('NFC'))).toContain('café.md');
    } finally {
      await view.cleanup();
    }
  });

  it('fails closed when git errors for a reason other than "not a repository"', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    await writeFile(join(project, '.git', 'index'), 'not an index');
    await expect(prepareProjectDiscoveryView(project)).rejects.toThrow('git');
  });

  it('does not run a core.fsmonitor command planted in the project', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    const marker = join(base, 'fsmonitor-ran');
    const hook = join(base, 'fsmonitor-hook.sh');
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: project });
    const view = await prepareProjectDiscoveryView(project);
    await view.cleanup();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

describe('project root that covers the home folder', () => {
  let homeSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    homeSpy?.mockRestore();
    homeSpy = undefined;
  });

  it('refuses the home folder itself', async () => {
    homeSpy = spyOn(os, 'homedir').mockReturnValue(project);
    expect(await read('README.md')).toBeUndefined();
    await expect(prepareProjectDiscoveryView(project)).rejects.toThrow('home folder');
  });

  it('refuses a folder above the home folder', async () => {
    homeSpy = spyOn(os, 'homedir').mockReturnValue(join(project, 'docs'));
    expect(await read('README.md')).toBeUndefined();
    await expect(prepareProjectDiscoveryView(project)).rejects.toThrow('home folder');
  });

  it('refuses the filesystem root', async () => {
    expect(await readProjectDiscoveryFile('/', 'etc/hosts', 16_000)).toBeUndefined();
    await expect(prepareProjectDiscoveryView('/')).rejects.toThrow('home folder');
  });
});
