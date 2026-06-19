import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

describe('tool output artifacts', () => {
  it('stores full tool output under the session message directory', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-tool-output-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: { id: 'agents/review', name: 'review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const messageID = await sessionManager.createMessage(sessionID, 'agents/review', {
        user: { prompt: { task: 'inspect output' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const circular: any = { output: 'full output' };
      circular.self = circular;

      const artifact = await sessionManager.writeToolOutputArtifact(
        sessionID,
        'agents/review',
        messageID,
        'bash',
        circular
      );

      expect(artifact.kind).toBe('tool-output');
      expect(artifact.path).toContain(`${sessionID}-agents-review/${messageID}/artifact/tool-output-bash-`);
      expect(artifact.path.endsWith('.json')).toBe(true);
      expect(artifact.absolutePath.endsWith(artifact.path)).toBe(true);
      expect(artifact.bytes).toBeGreaterThan(0);
      expect(artifact.originalChars).toBeGreaterThan(0);

      const stored = JSON.parse(await readFile(artifact.absolutePath, 'utf-8'));
      expect(stored).toMatchObject({
        kind: 'tool-output',
        toolName: 'bash',
        sessionID,
        agentId: 'agents/review',
        messageID,
        output: {
          output: 'full output',
          self: '[Circular]',
        },
      });
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('streams full tool output to a temp artifact and atomically finalizes it', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-tool-stream-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: { id: 'agents/review', name: 'review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const messageID = await sessionManager.createMessage(sessionID, 'agents/review', {
        user: { prompt: { task: 'stream output' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const stream = await sessionManager.createToolOutputArtifactStream(
        sessionID,
        'agents/review',
        messageID,
        'tools__bash',
        { command: 'printf hello' }
      );
      stream.write('hello ');
      stream.write('world');

      const artifact = await stream.finalize();

      expect(artifact.kind).toBe('tool-output');
      expect(artifact.path).toContain(`${sessionID}-agents-review/${messageID}/artifact/tool-output-tools__bash-`);
      expect(artifact.path.endsWith('.txt')).toBe(true);
      expect(artifact.bytes).toBeGreaterThan('hello world'.length);
      expect(artifact.originalChars).toBeGreaterThan('hello world'.length);

      const stored = await readFile(artifact.absolutePath, 'utf-8');
      expect(stored).toContain('# AgentUse Tool Output Artifact');
      expect(stored).toContain('tool: tools__bash');
      expect(stored).toContain('"command": "printf hello"');
      expect(stored).toContain('hello world');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('discards a streaming tool output artifact without exposing the temp file', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-tool-discard-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: { id: 'agents/review', name: 'review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const messageID = await sessionManager.createMessage(sessionID, 'agents/review', {
        user: { prompt: { task: 'discard output' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const stream = await sessionManager.createToolOutputArtifactStream(
        sessionID,
        'agents/review',
        messageID,
        'tools__bash'
      );
      stream.write('small output');
      await stream.discard();

      const sessionDir = await sessionManager.getSessionDirectory(sessionID, 'agents/review');
      const files = await readdir(join(sessionDir, messageID, 'artifact')).catch(() => []);
      expect(files).toEqual([]);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
