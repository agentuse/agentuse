import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAwaitHumanTool, getSessionUrl } from '../src/tools/await-human';
import { isSuspendSignal } from '../src/runner/suspend';
import { registerServer, unregisterServer } from '../src/utils/server-registry';
import { sessionViewToken } from '../src/utils/session-token';

describe('await_human approval URL', () => {
  const originalPublicUrl = process.env.AGENTUSE_RESUME_PUBLIC_URL;
  const originalServeUrl = process.env.AGENTUSE_SERVE_URL;
  const originalApiKey = process.env.AGENTUSE_API_KEY;
  const originalConfig = process.env.AGENTUSE_CONFIG;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentuse-await-human-'));
    process.env.XDG_DATA_HOME = tmpDir;
    // Point config at a non-existent path so the developer's real
    // ~/.agentuse/config.json never leaks into these tests. Tests that exercise
    // the config fallback override this with their own fixture.
    process.env.AGENTUSE_CONFIG = join(tmpDir, 'missing-config.json');
  });

  afterEach(() => {
    unregisterServer();
    if (originalPublicUrl === undefined) delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    else process.env.AGENTUSE_RESUME_PUBLIC_URL = originalPublicUrl;
    if (originalServeUrl === undefined) delete process.env.AGENTUSE_SERVE_URL;
    else process.env.AGENTUSE_SERVE_URL = originalServeUrl;
    if (originalApiKey === undefined) delete process.env.AGENTUSE_API_KEY;
    else process.env.AGENTUSE_API_KEY = originalApiKey;
    if (originalConfig === undefined) delete process.env.AGENTUSE_CONFIG;
    else process.env.AGENTUSE_CONFIG = originalConfig;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('points the reviewer link at the unified session page (no token when local/no api key)', () => {
    process.env.AGENTUSE_RESUME_PUBLIC_URL = 'https://agentuse.example.com/';
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;

    expect(getSessionUrl('session-1')).toBe(
      'https://agentuse.example.com/sessions/session-1'
    );
  });

  it('carries the session token (HMAC of api key) when an api key is set', () => {
    process.env.AGENTUSE_RESUME_PUBLIC_URL = 'https://agentuse.example.com/';
    delete process.env.AGENTUSE_SERVE_URL;
    process.env.AGENTUSE_API_KEY = 'super-secret-key';

    const token = sessionViewToken('session-1', 'super-secret-key');
    expect(token.length).toBeGreaterThan(0);
    expect(getSessionUrl('session-1')).toBe(
      `https://agentuse.example.com/sessions/session-1?token=${token}`
    );
  });

  it('falls back to the local serve URL when nothing else is configured', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;

    // Query a project root no daemon serves so the registry lookup misses; with
    // config isolated to a missing file, only the hard-coded fallback remains.
    expect(getSessionUrl('session-1', join(tmpDir, 'unserved-project'))).toBe(
      'http://127.0.0.1:12233/sessions/session-1'
    );
  });

  it('falls back to serve.publicUrl from global config when no env URL or daemon is set', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ serve: { publicUrl: 'https://config.example.com' } }));
    process.env.AGENTUSE_CONFIG = configPath;

    // Unserved project root => no daemon match, so the config value is used.
    expect(getSessionUrl('session-1', join(tmpDir, 'unserved-project'))).toBe(
      'https://config.example.com/sessions/session-1'
    );
  });

  it('uses the registered serve public URL for the project when no explicit env URL is set', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;
    registerServer({
      port: 12234,
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1:12234',
      projectRoot: '/tmp/project-a',
      startTime: Date.now(),
      agentCount: 1,
      scheduleCount: 0,
      version: 'test',
      projects: [{ id: 'project-a', root: '/tmp/project-a', agentCount: 1, scheduleCount: 0 }]
    });

    expect(getSessionUrl('session-1', '/tmp/project-a')).toBe(
      'http://127.0.0.1:12234/sessions/session-1'
    );
  });

  it('keeps multi-project session URLs clean and project-free', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;
    registerServer({
      port: 12235,
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1:12235',
      projectRoot: '/tmp/angle-content-system',
      startTime: Date.now(),
      agentCount: 2,
      scheduleCount: 0,
      version: 'test',
      projects: [
        { id: 'angle-content-system', root: '/tmp/angle-content-system', agentCount: 1, scheduleCount: 0 },
        { id: 'consulting-ops', root: '/tmp/consulting-ops', agentCount: 1, scheduleCount: 0 }
      ]
    });

    expect(getSessionUrl('session-1', '/tmp/consulting-ops')).toBe(
      'http://127.0.0.1:12235/sessions/session-1'
    );
  });

  it('accepts structured changes and reference in the input schema', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };

    expect(schema.safeParse({
      prompt: 'Post this comment?',
      changes: [
        { label: 'Comment to post', content: 'The exact comment text' },
        { content: 'Like the post' },
      ],
      reference: {
        label: 'Replying to',
        author: 'Alexandra Griffon (CEO, BlueCargo)',
        url: 'https://www.linkedin.com/feed/update/x/',
        excerpt: 'The economy did not contract, it reorganized.',
      },
    }).success).toBe(true);

    // content is required on each change entry
    expect(schema.safeParse({
      prompt: 'Post?',
      changes: [{ label: 'missing content' }],
    }).success).toBe(false);

    // reference URLs must be http(s)
    expect(schema.safeParse({
      prompt: 'Post?',
      reference: { url: 'javascript:alert(1)' },
    }).success).toBe(false);
  });

  it('requires the verbatim original on any gate that approves a response', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };

    // a reply gate without the original is unjudgeable without leaving the card
    expect(schema.safeParse({
      prompt: 'Approve this LinkedIn comment on Tom Langridge\'s post?',
      changes: [{ label: 'Comment to post', content: 'The exact comment text' }],
      context: 'Original post: agents made 47 unauthorized decisions...',
    }).success).toBe(false);

    // the same gate passes once the original travels in reference.excerpt
    expect(schema.safeParse({
      prompt: 'Approve this LinkedIn comment on Tom Langridge\'s post?',
      changes: [{ label: 'Comment to post', content: 'The exact comment text' }],
      reference: {
        author: 'Tom Langridge (Co-Founder, Fast.io)',
        url: 'https://www.linkedin.com/feed/update/x/',
        excerpt: 'Our agents made 47 unauthorized decisions last month. Nobody has solved this.',
      },
    }).success).toBe(true);

    // a fresh post answers nothing, so it needs no reference
    expect(schema.safeParse({
      prompt: 'Which version of today\'s X post should go out?',
      options: [{ id: 'a', label: 'With the closing line' }, { id: 'b', label: 'Without it' }],
    }).success).toBe(true);

    // a reference that carries only a link is the failure this rule exists for
    expect(schema.safeParse({
      prompt: 'Approve this reply?',
      reference: { author: '@someone', url: 'https://x.com/someone/status/1' },
    }).success).toBe(false);

    // an elided original is no better than a missing one
    expect(schema.safeParse({
      prompt: 'Approve this reply?',
      reference: { excerpt: 'The first two lines of the post [truncated, full text at the link]' },
    }).success).toBe(false);

    // a real post may legitimately trail off; only explicit markers count
    expect(schema.safeParse({
      prompt: 'Approve this reply?',
      reference: { excerpt: 'and then it just kept going...' },
    }).success).toBe(true);
  });

  it('requires displayContent when a change is a command carrying a payload', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };

    const command = 'uv run /Users/x/.claude/skills/postiz-social/postiz_api.py post_thread_x cm71 "2026-09-09T16:00:00Z" '
      + '\'[{"text":"More advice is not the answer when the real gap is an action with no trigger. Pick one daily cue."}]\'';

    // a wall of shell with no business content is unreviewable
    expect(schema.safeParse({
      prompt: 'Approve scheduling this quote short?',
      changes: [{ label: 'Schedule X video', content: command }],
    }).success).toBe(false);

    // displayContent surfaces the post the reviewer is actually approving
    expect(schema.safeParse({
      prompt: 'Approve scheduling this quote short?',
      changes: [{
        label: 'Schedule X video',
        content: command,
        displayContent: 'More advice is not the answer when the real gap is an action with no trigger. Pick one daily cue.',
      }],
    }).success).toBe(true);

    // a short command is its own whole story
    expect(schema.safeParse({
      prompt: 'Approve the deploy?',
      changes: [{ label: 'Deploy', content: 'git push origin main && make deploy' }],
    }).success).toBe(true);

    // long prose is not a command
    expect(schema.safeParse({
      prompt: 'Approve this post?',
      changes: [{ label: 'Post body', content: 'Knowing what to do is not the same as having it survive a full week. '.repeat(5) }],
    }).success).toBe(true);
  });

  it('defines actionable comments as revise-and-re-gate before choice ambiguity', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });
    const description = tool.description ?? '';

    expect(description).toContain('Comment is the revise-and-re-gate branch');
    expect(description).toContain('takes precedence over missing-choice ambiguity');
    expect(description).toContain('Only an explicit request to cancel, abandon, or stop is terminal');
  });

  it('accepts a pick-among-options menu in the input schema', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };

    expect(schema.safeParse({
      prompt: 'Pick one of the newsletter ideas to draft?',
      options: [
        { id: 'candidate-0', label: 'the rebuild nobody chose', description: 'Gray-divorce cluster', recommended: true },
        { id: 'candidate-1', label: 'the domain nobody bills you for' },
        { id: 'candidate-2', label: 'the deadline someone else set' },
      ],
    }).success).toBe(true);

    // a menu needs at least two options
    expect(schema.safeParse({
      prompt: 'Pick?',
      options: [{ id: 'only', label: 'Only option' }],
    }).success).toBe(false);

    // id and label are required and non-empty
    expect(schema.safeParse({
      prompt: 'Pick?',
      options: [{ id: '', label: 'A' }, { id: 'b', label: 'B' }],
    }).success).toBe(false);
    expect(schema.safeParse({
      prompt: 'Pick?',
      options: [{ id: 'a' }, { id: 'b', label: 'B' }],
    }).success).toBe(false);
  });

  it('validates option-scoped changes against unique option ids', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    const options = [
      { id: 'a', label: 'Candidate A' },
      { id: 'b', label: 'Candidate B' },
    ];

    expect(schema.safeParse({
      prompt: 'Pick a reply?',
      reference: { author: '@someone', excerpt: 'The original post, in full.' },
      options,
      changes: [
        { content: 'birdc reply 1 "A"', displayContent: 'A', optionId: 'a' },
        { content: 'birdc reply 1 "B"', displayContent: 'B', optionId: 'b' },
        { content: 'record review' },
      ],
    }).success).toBe(true);

    expect(schema.safeParse({
      prompt: 'Pick?',
      options,
      changes: [{ content: 'birdc reply 1 "C"', optionId: 'c' }],
    }).success).toBe(false);

    expect(schema.safeParse({
      prompt: 'Pick?',
      options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Duplicate A' }],
    }).success).toBe(false);

    expect(schema.safeParse({
      prompt: 'Approve?',
      changes: [{ content: 'birdc reply 1 "A"', optionId: 'a' }],
    }).success).toBe(false);
  });

  it('does not set an approval expiration by default', async () => {
    delete process.env.AGENTUSE_API_KEY;
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });

    try {
      await tool.execute?.({ prompt: 'Approve this?' } as any, {} as any);
      throw new Error('expected suspend signal');
    } catch (err) {
      expect(isSuspendSignal(err)).toBe(true);
      if (!isSuspendSignal(err)) return;
      expect(err.payload.expiresAt).toBeUndefined();
      expect(err.payload.approvalUrl).toContain('/sessions/session-1');
      expect(err.payload.channelMessage).toBeUndefined();
    }
  });

  it('sets an approval expiration only when timeout is configured', async () => {
    const now = Date.now();
    const tool = createAwaitHumanTool('session-1', {
      projectRoot: '/tmp/project-a',
      timeout: '24h'
    });

    try {
      await tool.execute?.({ prompt: 'Approve this?' } as any, {} as any);
      throw new Error('expected suspend signal');
    } catch (err) {
      expect(isSuspendSignal(err)).toBe(true);
      if (!isSuspendSignal(err)) return;
      expect(err.payload.expiresAt).toBeGreaterThanOrEqual(now + 24 * 60 * 60 * 1000 - 1000);
      expect(err.payload.expiresAt).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000 + 1000);
    }
  });

  it('rejects inputs carrying leaked XML tool-call markup at the schema layer', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });

    // Real-world drift shape: the model closed `summary` with XML tool syntax
    // and smuggled the next field in as markup instead of a JSON property.
    const result = (tool.inputSchema as any).safeParse({
      prompt: 'Approve this batch?',
      summary: 'Seven replies staged.</parameter>\n<parameter name="changes">[{"content": "hi"}]',
      context: 'Batch ref 123</parameter>\n</invoke>'
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('XML tool-call markup');
  });

  it('does not false-positive on angle brackets in normal markdown', () => {
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });

    const result = (tool.inputSchema as any).safeParse({
      prompt: 'Approve?',
      summary: 'Uses generics like Array<string> and <div> tags, plus a <placeholder>.',
      changes: [{ content: 'if (a < b && b > c) { ... }' }]
    });

    expect(result.success).toBe(true);
  });

  it('treats bare-number timeouts as seconds, not milliseconds', async () => {
    const now = Date.now();
    const tool = createAwaitHumanTool('session-1', {
      projectRoot: '/tmp/project-a',
      timeout: 3600
    });

    try {
      await tool.execute?.({ prompt: 'Approve this?' } as any, {} as any);
      throw new Error('expected suspend signal');
    } catch (err) {
      expect(isSuspendSignal(err)).toBe(true);
      if (!isSuspendSignal(err)) return;
      expect(err.payload.expiresAt).toBeGreaterThanOrEqual(now + 3600 * 1000 - 1000);
      expect(err.payload.expiresAt).toBeLessThanOrEqual(now + 3600 * 1000 + 1000);
    }
  });
});
