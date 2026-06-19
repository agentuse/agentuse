import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBashTool } from '../src/tools/bash.js';
import type { ToolOutputArtifactRef } from '../src/session/types.js';

function memoryArtifactSink(ref: ToolOutputArtifactRef = {
  kind: 'tool-output',
  path: 'session/message/artifact/tool-output-tools-bash.txt',
  absolutePath: '/tmp/tool-output-tools-bash.txt',
  bytes: 1024,
  originalChars: 1024,
}) {
  const chunks: string[] = [];
  const finalize = mock(async () => ref);
  const discard = mock(async () => undefined);
  const createStream = mock(async () => ({
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    finalize,
    discard,
  }));

  return {
    chunks,
    createStream,
    finalize,
    discard,
    sink: { createStream },
  };
}

describe('bash full-output artifacts', () => {
  it('finalizes a full-output artifact when bash output is truncated for the model', async () => {
    const originalMax = process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    const originalRatio = process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-bash-artifact-'));
    process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = '40';
    process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO = '0.5';

    try {
      const artifacts = memoryArtifactSink();
      const bashTool = createBashTool(
        { commands: ['printf *'] },
        projectRoot,
        { projectRoot, toolOutputArtifacts: artifacts.sink }
      );

      const full = 'x'.repeat(200);
      const result = await bashTool.execute({ command: `printf ${full}` });

      expect(result.output).toContain('chars truncated');
      expect(result.output).toContain('full output saved to session artifact');
      expect(result.output).toContain('tool-output-tools-bash.txt');
      expect(result.metadata?.truncated).toBe(true);
      expect(result.metadata?.fullOutputArtifact).toMatchObject({
        kind: 'tool-output',
        path: 'session/message/artifact/tool-output-tools-bash.txt',
      });
      expect(result.metadata?.fullOutputArtifact).not.toHaveProperty('absolutePath');
      expect(JSON.stringify(result.metadata?.fullOutputArtifact)).not.toContain('/tmp/tool-output-tools-bash.txt');
      expect(artifacts.createStream).toHaveBeenCalledTimes(1);
      expect(artifacts.finalize).toHaveBeenCalledTimes(1);
      expect(artifacts.discard).not.toHaveBeenCalled();
      expect(artifacts.chunks.join('')).toContain('[stdout]');
      expect(artifacts.chunks.join('')).toContain(full);
    } finally {
      if (originalMax === undefined) delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
      else process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = originalMax;
      if (originalRatio === undefined) delete process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO;
      else process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO = originalRatio;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('discards the full-output stream when bash output fits in model context', async () => {
    const originalMax = process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-bash-small-'));
    process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = '1000';

    try {
      const artifacts = memoryArtifactSink();
      const bashTool = createBashTool(
        { commands: ['printf *'] },
        projectRoot,
        { projectRoot, toolOutputArtifacts: artifacts.sink }
      );

      const result = await bashTool.execute({ command: 'printf small-output' });

      expect(result.output).toContain('small-output');
      expect(result.output).not.toContain('full output saved to session artifact');
      expect(result.metadata?.truncated).toBe(false);
      expect(result.metadata?.fullOutputArtifact).toBeUndefined();
      expect(artifacts.createStream).toHaveBeenCalledTimes(1);
      expect(artifacts.finalize).not.toHaveBeenCalled();
      expect(artifacts.discard).toHaveBeenCalledTimes(1);
    } finally {
      if (originalMax === undefined) delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
      else process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = originalMax;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
