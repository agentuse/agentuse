import { describe, expect, it } from 'bun:test';
import { shortenCommand } from '../src/cli/serve/web/lib/shorten-command';

describe('shortening a command for display', () => {
  it('collapses a long path to its last segments, keeping the script and args', () => {
    const cmd = 'uv run /Users/llch/.claude/skills/helpscout-cs-agent/scripts/get_conversation.py --number 301607';

    expect(shortenCommand(cmd)).toBe('uv run …/scripts/get_conversation.py --number 301607');
  });

  it('shortens every path in a compound command', () => {
    const cmd = 'cat /a/b/c/d/one.md && cat /a/b/c/d/two.md';

    expect(shortenCommand(cmd)).toBe('cat …/d/one.md && cat …/d/two.md');
  });

  it('keeps short paths whole', () => {
    expect(shortenCommand('cat ./notes.md')).toBe('cat ./notes.md');
    expect(shortenCommand('ls /tmp')).toBe('ls /tmp');
  });

  it('leaves a command with no path untouched', () => {
    expect(shortenCommand('npm run build --workspace web')).toBe('npm run build --workspace web');
  });

  it('does not swallow the shell operators around a path', () => {
    const cmd = 'cd /very/long/project/root && npm test';

    expect(shortenCommand(cmd)).toBe('cd …/project/root && npm test');
  });

  it('still caps a command that is long without being pathy', () => {
    const cmd = `echo ${'word '.repeat(60)}`;
    const out = shortenCommand(cmd);

    expect(out.length).toBe(96);
    expect(out.endsWith('…')).toBe(true);
  });

  it('shortens a bare path argument too', () => {
    expect(shortenCommand('/Users/llch/workspace/repo/docs/spec.md'))
      .toBe('…/docs/spec.md');
  });
});
