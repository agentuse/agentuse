import { describe, expect, test } from 'bun:test';
import { CommandValidator } from '../src/tools/command-validator';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('CommandValidator', () => {
  const projectRoot = path.join(os.tmpdir(), 'test-project');

  // Setup test directory
  if (!fs.existsSync(projectRoot)) {
    fs.mkdirSync(projectRoot, { recursive: true });
  }

  describe('Auto-allow cd', () => {
    test('allows cd within project', async () => {
      const validator = new CommandValidator(['echo *'], projectRoot);
      const result = await validator.validate('cd src');
      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('cd *');
    });

    test('allows cd in compound commands', async () => {
      const validator = new CommandValidator(['./server.sh *'], projectRoot);
      const result = await validator.validate('cd dir && ./server.sh start');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Structured pattern matching', () => {
    test('matches git push with wildcards', async () => {
      const validator = new CommandValidator(['git push *'], projectRoot);
      const result = await validator.validate('git push origin main');
      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toContain('git push *');
    });

    test('matches npm run with subcommand', async () => {
      const validator = new CommandValidator(['npm run *'], projectRoot);
      const result = await validator.validate('npm run build');
      expect(result.allowed).toBe(true);
    });

    test('blocks commands not in allowlist', async () => {
      const validator = new CommandValidator(['git status'], projectRoot);
      const result = await validator.validate('git push origin main');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not in allowlist');
    });
  });

  describe('Pattern priority', () => {
    test('more specific patterns override general ones', async () => {
      const validator = new CommandValidator(
        ['git *', 'git push *'],
        projectRoot
      );

      // Both patterns should allow git push
      const result = await validator.validate('git push origin main');
      expect(result.allowed).toBe(true);
    });

    test('longer patterns are more specific', async () => {
      const validator = new CommandValidator(
        ['*', 'git *', 'git push *'],
        projectRoot
      );

      const result = await validator.validate('git push origin main');
      expect(result.allowed).toBe(true);
      // Should match the most specific pattern
      expect(result.matchedPattern).toContain('git push *');
    });
  });

  describe('Compound commands', () => {
    test('validates all commands in pipeline', async () => {
      const validator = new CommandValidator(
        ['echo *', 'grep *'],
        projectRoot
      );

      const result = await validator.validate('echo hello | grep lo');
      expect(result.allowed).toBe(true);
    });

    test('blocks if any command in chain fails', async () => {
      const validator = new CommandValidator(['echo *'], projectRoot);

      const result = await validator.validate('echo hello && curl example.com');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not in allowlist');
    });

    test('handles complex compound commands', async () => {
      const validator = new CommandValidator(
        ['git *', './build.sh *'],
        projectRoot
      );

      const result = await validator.validate('git pull && ./build.sh production');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Relative paths', () => {
    test('allows relative script paths', async () => {
      const validator = new CommandValidator(
        ['./server.sh *'],
        projectRoot
      );

      const result = await validator.validate('./server.sh start');
      expect(result.allowed).toBe(true);
    });

    test('allows compound commands with cd and relative script', async () => {
      // To allow "cd dir && ./script", you need both patterns
      const validator = new CommandValidator(
        ['./server.sh *'],  // Allow the relative script
        projectRoot
      );

      // cd is auto-allowed, ./server.sh needs to be in allowlist
      const result = await validator.validate('cd .agentuse/skills/browser && ./server.sh start');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Built-in denylist', () => {
    test('blocks dangerous rm commands', async () => {
      const validator = new CommandValidator(['rm *'], projectRoot);

      const result = await validator.validate('rm -rf /');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('built-in security policy');
    });

    test('blocks sudo commands', async () => {
      const validator = new CommandValidator(['sudo *'], projectRoot);

      const result = await validator.validate('sudo rm -rf /');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('built-in security policy');
    });

    test('blocks credential theft', async () => {
      const validator = new CommandValidator(['cat *'], projectRoot);

      const result = await validator.validate('cat ~/.ssh/id_rsa');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('built-in security policy');
    });
  });

  describe('External directory access', () => {
    test('blocks access outside project root', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot);

      // Try to cd to parent directory
      const result = await validator.validate('cd ..');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('outside project root');
    });

    test('allows access within project', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot);

      const result = await validator.validate('cd src/components');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Edge cases', () => {
    test('handles empty commands', async () => {
      const validator = new CommandValidator(['*'], projectRoot);

      const result = await validator.validate('');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('Empty command');
    });

    test('handles commands with quotes', async () => {
      const validator = new CommandValidator(['echo *'], projectRoot);

      const result = await validator.validate('echo "hello world"');
      expect(result.allowed).toBe(true);
    });

    test('handles complex flag combinations', async () => {
      const validator = new CommandValidator(['git *'], projectRoot);

      const result = await validator.validate('git log --oneline --graph --all');
      expect(result.allowed).toBe(true);
    });
  });
});
