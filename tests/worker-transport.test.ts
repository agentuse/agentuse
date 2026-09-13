import { describe, expect, it, spyOn } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { AgentWorker } from '../src/cli/serve.js';
import { logger } from '../src/utils/logger.js';

type PendingResponse = {
  success: boolean;
  error?: { code: string; message: string };
};

type TestableAgentWorker = {
  pendingRequests: Map<string, {
    resolve: (value: PendingResponse) => void;
    timeoutId?: NodeJS.Timeout;
  }>;
  handleWorkerMessage: (line: string) => void;
};

describe('serve worker response transport', () => {
  it('fails the matching request immediately when a framed response is invalid JSON', async () => {
    const worker = new AgentWorker() as unknown as TestableAgentWorker;
    const secretPayload = 'private-session-content';
    const errorLogs: string[] = [];
    const errorSpy = spyOn(logger, 'error').mockImplementation((message) => {
      errorLogs.push(String(message));
    });

    try {
      const responsePromise = new Promise<PendingResponse>((resolve) => {
        worker.pendingRequests.set('req-17', { resolve });
      });

      // This is the first fragment readline would emit if an unsafe separator
      // split a JSON response after its request id.
      worker.handleWorkerMessage(
        `{"id":"req-17","success":true,"result":{"text":"${secretPayload}`,
      );

      const response = await responsePromise;
      expect(response).toMatchObject({
        success: false,
        error: { code: 'WORKER_PROTOCOL_ERROR' },
      });
      expect(response.error?.message).toMatch(/Diagnostic ID: [0-9A-Z]{26}$/);
      expect(worker.pendingRequests.has('req-17')).toBe(false);

      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0]).toContain('requestId=req-17');
      expect(errorLogs[0]).toContain('matched=true');
      expect(errorLogs[0]).toMatch(/diagnosticId=[0-9A-Z]{26}/);
      expect(errorLogs[0]).toMatch(/bytes=\d+ chars=\d+/);
      expect(errorLogs[0]).not.toContain(secretPayload);
      const diagnosticId = response.error?.message.match(/Diagnostic ID: ([0-9A-Z]{26})$/)?.[1];
      expect(errorLogs[0]).toContain(`diagnosticId=${diagnosticId}`);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails a matching request whose JSON envelope is structurally invalid', async () => {
    const worker = new AgentWorker() as unknown as TestableAgentWorker;
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    try {
      const responsePromise = new Promise<PendingResponse>((resolve) => {
        worker.pendingRequests.set('req-18', { resolve });
      });

      worker.handleWorkerMessage('{"id":"req-18","result":{}}');

      await expect(responsePromise).resolves.toMatchObject({
        success: false,
        error: { code: 'WORKER_PROTOCOL_ERROR' },
      });
      expect(worker.pendingRequests.has('req-18')).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('treats worker protocol failures as terminal session-page errors', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', 'src', 'cli', 'serve', 'web', 'hooks', 'use-approval-stream.ts'),
      'utf8',
    );
    expect(source).toContain("const TERMINAL_CODES = new Set(['SESSION_CORRUPTED', 'WORKER_PROTOCOL_ERROR']);");
  });
});
