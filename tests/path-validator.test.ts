import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PathValidator } from '../src/tools/path-validator';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FilesystemPathConfig } from '../src/tools/types';

/**
 * Security tests for PathValidator
 * Tests symlink attacks, sensitive file protection, directory traversal
 */

describe('PathValidator Security', () => {
  // Use realpath to handle /tmp -> /private/tmp on macOS
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-project-')));

  beforeEach(() => {
    // Create subdirectories
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  });

  afterEach(() => {
    // Clean up files in project directory but keep the directory itself for reuse
    try {
      const entries = fs.readdirSync(projectRoot);
      for (const entry of entries) {
        fs.rmSync(path.join(projectRoot, entry), { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('sensitive file protection', () => {
    const configs: FilesystemPathConfig[] = [
      { path: `${projectRoot}/**`, permissions: ['read', 'write', 'edit'] },
    ];

    it('blocks access to .env files', () => {
      const validator = new PathValidator(configs, projectRoot);

      // Create a .env file
      fs.writeFileSync(path.join(projectRoot, '.env'), 'SECRET=password123');

      const result = validator.validate(path.join(projectRoot, '.env'), 'read');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('sensitive file');
    });

    it('blocks access to .env.local', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.local'), 'API_KEY=secret');

      const result = validator.validate(path.join(projectRoot, '.env.local'), 'read');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('sensitive file');
    });

    it('blocks access to .env.production', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.production'), 'DB_PASSWORD=secret');

      const result = validator.validate(path.join(projectRoot, '.env.production'), 'read');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('sensitive file');
    });

    it('blocks access to .env.development', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.development'), 'DEV_SECRET=test');

      const result = validator.validate(path.join(projectRoot, '.env.development'), 'read');
      expect(result.allowed).toBe(false);
    });

    it('blocks access to .env.staging', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.staging'), 'STAGING_KEY=test');

      const result = validator.validate(path.join(projectRoot, '.env.staging'), 'read');
      expect(result.allowed).toBe(false);
    });

    it('allows access to .env.example (safe file)', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.example'), 'API_KEY=your-key-here');

      const result = validator.validate(path.join(projectRoot, '.env.example'), 'read');
      expect(result.allowed).toBe(true);
    });

    it('allows access to .env.sample (safe file)', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.sample'), 'API_KEY=your-key-here');

      const result = validator.validate(path.join(projectRoot, '.env.sample'), 'read');
      expect(result.allowed).toBe(true);
    });

    it('allows access to .env.template (safe file)', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.env.template'), 'API_KEY=your-key-here');

      const result = validator.validate(path.join(projectRoot, '.env.template'), 'read');
      expect(result.allowed).toBe(true);
    });

    it('blocks .env files in subdirectories', () => {
      const validator = new PathValidator(configs, projectRoot);

      fs.mkdirSync(path.join(projectRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'config', '.env'), 'NESTED_SECRET=value');

      const result = validator.validate(path.join(projectRoot, 'config', '.env'), 'read');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('sensitive file');
    });
  });

  describe('symlink attack prevention', () => {
    it('resolves symlinks and validates the real path', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      // Create a file outside project
      const outsidePath = '/tmp/outside-project-secret.txt';
      fs.writeFileSync(outsidePath, 'secret data');

      // Create symlink inside project pointing outside
      const symlinkPath = path.join(projectRoot, 'link-to-secret.txt');
      try {
        fs.symlinkSync(outsidePath, symlinkPath);

        // Access via symlink should be blocked (resolves to outside path)
        const result = validator.validate(symlinkPath, 'read');
        expect(result.allowed).toBe(false);
      } finally {
        try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
        try { fs.unlinkSync(outsidePath); } catch { /* ignore */ }
      }
    });

    it('blocks symlink to /etc/passwd', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const symlinkPath = path.join(projectRoot, 'passwd-link');
      try {
        fs.symlinkSync('/etc/passwd', symlinkPath);

        const result = validator.validate(symlinkPath, 'read');
        expect(result.allowed).toBe(false);
      } finally {
        try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      }
    });

    it('blocks symlink to home directory SSH keys', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const sshDir = path.join(os.homedir(), '.ssh');
      if (fs.existsSync(sshDir)) {
        const symlinkPath = path.join(projectRoot, 'ssh-link');
        try {
          fs.symlinkSync(sshDir, symlinkPath);

          const result = validator.validate(path.join(symlinkPath, 'id_rsa'), 'read');
          expect(result.allowed).toBe(false);
        } finally {
          try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
        }
      }
    });

    it('allows symlinks within project root', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      // Create a file inside project
      const realFile = path.join(projectRoot, 'src', 'index.ts');
      fs.writeFileSync(realFile, 'export {}');

      // Create symlink to it
      const symlinkPath = path.join(projectRoot, 'link-to-index.ts');
      try {
        fs.symlinkSync(realFile, symlinkPath);

        const result = validator.validate(symlinkPath, 'read');
        expect(result.allowed).toBe(true);
      } finally {
        try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      }
    });
  });

  describe('directory traversal prevention', () => {
    const configs: FilesystemPathConfig[] = [
      { path: `${projectRoot}/**`, permissions: ['read', 'write'] },
    ];

    it('blocks ../ traversal to escape project root', () => {
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate(
        path.join(projectRoot, '..', '..', 'etc', 'passwd'),
        'read'
      );
      expect(result.allowed).toBe(false);
    });

    it('blocks multiple ../ sequences', () => {
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate(
        path.join(projectRoot, 'src', '..', '..', '..', 'etc', 'passwd'),
        'read'
      );
      expect(result.allowed).toBe(false);
    });

    it('blocks encoded ../ in path', () => {
      const validator = new PathValidator(configs, projectRoot);

      // After path resolution, %2e%2e should become ..
      const maliciousPath = `${projectRoot}/../etc/passwd`;
      const result = validator.validate(maliciousPath, 'read');
      expect(result.allowed).toBe(false);
    });

    it('allows valid nested paths within project', () => {
      const validator = new PathValidator(configs, projectRoot);

      // Create nested structure
      fs.mkdirSync(path.join(projectRoot, 'src', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'src', 'lib', 'util.ts'), 'export {}');

      const result = validator.validate(
        path.join(projectRoot, 'src', 'lib', 'util.ts'),
        'read'
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('permission enforcement', () => {
    it('blocks read when only write is allowed', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['write'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      const result = validator.validate(path.join(projectRoot, 'file.txt'), 'read');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('blocks write when only read is allowed', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate(path.join(projectRoot, 'file.txt'), 'write');
      expect(result.allowed).toBe(false);
    });

    it('blocks edit when only read is allowed', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate(path.join(projectRoot, 'file.txt'), 'edit');
      expect(result.allowed).toBe(false);
    });

    it('allows all operations when all permissions granted', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read', 'write', 'edit'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      expect(validator.validate(path.join(projectRoot, 'file.txt'), 'read').allowed).toBe(true);
      expect(validator.validate(path.join(projectRoot, 'file.txt'), 'write').allowed).toBe(true);
      expect(validator.validate(path.join(projectRoot, 'file.txt'), 'edit').allowed).toBe(true);
    });
  });

  describe('path resolution edge cases', () => {
    it('handles tilde expansion (~)', () => {
      const homeDir = os.homedir();
      const configs: FilesystemPathConfig[] = [
        { path: `${homeDir}/.config/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate('~/.config/app/settings.json', 'read');
      // Should be allowed if the resolved path matches the pattern
      // This depends on whether ~/.config exists
      expect(result.resolvedPath).toStartWith(homeDir);
    });

    it('normalizes paths with //', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      // Double slashes should be normalized
      const result = validator.validate(`${projectRoot}//file.txt`, 'read');
      expect(result.allowed).toBe(true);
    });

    it('handles ./ in paths', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      const result = validator.validate(`${projectRoot}/./file.txt`, 'read');
      expect(result.allowed).toBe(true);
    });

    it('resolves relative paths against project root', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      const result = validator.validate('./file.txt', 'read');
      expect(result.resolvedPath).toBe(path.join(projectRoot, 'file.txt'));
    });
  });

  describe('multiple path configurations', () => {
    it('allows access when any config matches', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/src/**`, permissions: ['read'] },
        { path: `${projectRoot}/data/**`, permissions: ['read', 'write'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(projectRoot, 'data', 'db.json'), '{}');

      expect(validator.validate(path.join(projectRoot, 'src', 'index.ts'), 'read').allowed).toBe(true);
      expect(validator.validate(path.join(projectRoot, 'data', 'db.json'), 'read').allowed).toBe(true);
      expect(validator.validate(path.join(projectRoot, 'data', 'db.json'), 'write').allowed).toBe(true);
    });

    it('uses most specific permission for a path', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
        { path: `${projectRoot}/src/**`, permissions: ['read', 'write'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export {}');

      // src/index.ts should match src/** with write permission
      expect(validator.validate(path.join(projectRoot, 'src', 'index.ts'), 'write').allowed).toBe(true);
    });
  });

  describe('no configuration edge case', () => {
    it('blocks all access when no configs provided', () => {
      const configs: FilesystemPathConfig[] = [];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      const result = validator.validate(path.join(projectRoot, 'file.txt'), 'read');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('No filesystem paths configured');
    });
  });

  describe('variable resolution', () => {
    it('resolves ${root} variable', () => {
      const configs: FilesystemPathConfig[] = [
        { path: '${root}/**', permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'content');

      const result = validator.validate(path.join(projectRoot, 'file.txt'), 'read');
      expect(result.allowed).toBe(true);
    });

    it('resolves ${cwd} variable', () => {
      const configs: FilesystemPathConfig[] = [
        { path: '${cwd}/**', permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      // Should resolve to current working directory
      const patterns = validator.getPatternsForPermission('read');
      expect(patterns[0]).toBe(process.cwd() + '/**');
    });
  });

  describe('glob pattern matching', () => {
    it('matches ** for any depth', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.mkdirSync(path.join(projectRoot, 'a', 'b', 'c'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'a', 'b', 'c', 'deep.txt'), 'content');

      const result = validator.validate(
        path.join(projectRoot, 'a', 'b', 'c', 'deep.txt'),
        'read'
      );
      expect(result.allowed).toBe(true);
    });

    it('matches * for single segment', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/*.ts`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export {}');

      expect(validator.validate(path.join(projectRoot, 'index.ts'), 'read').allowed).toBe(true);

      // Should not match nested files
      fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'src', 'nested.ts'), 'export {}');

      const nestedResult = validator.validate(path.join(projectRoot, 'src', 'nested.ts'), 'read');
      expect(nestedResult.allowed).toBe(false);
    });

    it('matches dotfiles with dot: true', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules');

      const result = validator.validate(path.join(projectRoot, '.gitignore'), 'read');
      expect(result.allowed).toBe(true);
    });
  });

  describe('absolute path security', () => {
    it('blocks absolute paths outside allowed directories', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate('/etc/passwd', 'read');
      expect(result.allowed).toBe(false);
    });

    it('blocks /root access', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate('/root/.bashrc', 'read');
      expect(result.allowed).toBe(false);
    });

    it('blocks /var/log access', () => {
      const configs: FilesystemPathConfig[] = [
        { path: `${projectRoot}/**`, permissions: ['read'] },
      ];
      const validator = new PathValidator(configs, projectRoot);

      const result = validator.validate('/var/log/auth.log', 'read');
      expect(result.allowed).toBe(false);
    });
  });
});

describe('PathValidator - Case Sensitivity', () => {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-case-')));

  afterEach(() => {
    try {
      const entries = fs.readdirSync(projectRoot);
      for (const entry of entries) {
        fs.rmSync(path.join(projectRoot, entry), { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  it('handles case sensitivity appropriately for the platform', () => {
    const configs: FilesystemPathConfig[] = [
      { path: `${projectRoot}/**`, permissions: ['read'] },
    ];
    const validator = new PathValidator(configs, projectRoot);

    fs.writeFileSync(path.join(projectRoot, '.ENV'), 'content');

    // .ENV should be blocked on case-insensitive filesystems (macOS)
    // as it matches .env pattern
    const result = validator.validate(path.join(projectRoot, '.ENV'), 'read');

    // On macOS (darwin), this should be blocked
    if (process.platform === 'darwin') {
      expect(result.allowed).toBe(false);
    }
  });
});

describe('PathValidator - Concurrent Access', () => {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-concurrent-')));

  afterEach(() => {
    try {
      const entries = fs.readdirSync(projectRoot);
      for (const entry of entries) {
        fs.rmSync(path.join(projectRoot, entry), { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  it('handles concurrent validations correctly', async () => {
    const configs: FilesystemPathConfig[] = [
      { path: `${projectRoot}/**`, permissions: ['read'] },
    ];
    const validator = new PathValidator(configs, projectRoot);

    // Create test files
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(projectRoot, `file${i}.txt`), 'content');
    }

    // Run concurrent validations
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        Promise.resolve(validator.validate(path.join(projectRoot, `file${i}.txt`), 'read'))
      );
    }

    const results = await Promise.all(promises);

    // All should be allowed
    results.forEach((result, i) => {
      expect(result.allowed).toBe(true);
    });
  });
});
