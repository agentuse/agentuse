import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAX_JSON_BODY_BYTES,
  guardRequestHandler,
  RequestBodyTooLargeError,
  parseJSONBody,
  readRequestBody,
  sendError,
  sendHTML,
  sendJSON,
  sendRequestParseError,
} from '../src/cli/serve/http';

class RequestStub extends EventEmitter {
  pushChunks(chunks: Array<Buffer | string>): void {
    for (const chunk of chunks) this.emit('data', chunk);
    this.emit('end');
  }
}

function responseStub() {
  const response = {
    status: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    body: undefined as string | undefined,
    writeHead(status: number, headers: Record<string, string>) {
      response.status = status;
      response.headers = headers;
      return response;
    },
    end(body?: string) {
      response.body = body;
      return response;
    },
  };
  return response;
}

describe('serve HTTP helpers', () => {
  it('decodes multibyte UTF-8 only after all request chunks arrive', async () => {
    const req = new RequestStub();
    const body = Buffer.from(JSON.stringify({ message: 'before 😀 漢字 after' }));
    const emojiStart = body.indexOf(Buffer.from('😀'));
    const parsed = parseJSONBody(req as IncomingMessage);

    req.pushChunks([
      body.subarray(0, emojiStart + 1),
      body.subarray(emojiStart + 1, emojiStart + 3),
      body.subarray(emojiStart + 3),
    ]);

    expect(await parsed).toEqual({ message: 'before 😀 漢字 after' });
  });

  it('accepts an empty body and rejects malformed JSON', async () => {
    const empty = new RequestStub();
    const emptyResult = parseJSONBody(empty as IncomingMessage);
    empty.pushChunks([]);
    expect(await emptyResult).toEqual({});

    const malformed = new RequestStub();
    const malformedResult = parseJSONBody(malformed as IncomingMessage);
    malformed.pushChunks(['{"missing":']);
    expect(malformedResult).rejects.toThrow('Invalid JSON body');
  });

  it('accepts the byte limit and rejects the first byte beyond it', async () => {
    const jsonOverhead = Buffer.byteLength(JSON.stringify({ value: '' }));
    const boundaryBody = JSON.stringify({ value: 'x'.repeat(MAX_JSON_BODY_BYTES - jsonOverhead) });
    expect(Buffer.byteLength(boundaryBody)).toBe(MAX_JSON_BODY_BYTES);

    const boundary = new RequestStub();
    const boundaryResult = parseJSONBody(boundary as IncomingMessage);
    boundary.pushChunks([boundaryBody]);
    expect((await boundaryResult).value).toHaveLength(MAX_JSON_BODY_BYTES - jsonOverhead);

    const oversized = new RequestStub();
    const oversizedResult = readRequestBody(oversized as IncomingMessage, 4);
    oversized.pushChunks([Buffer.from('1234'), Buffer.from('5')]);
    expect(oversizedResult).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('propagates request errors and ignores a later abort after rejection', async () => {
    const req = new RequestStub();
    const result = readRequestBody(req as IncomingMessage);
    const failure = new Error('socket failed');
    req.emit('error', failure);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    req.emit('error', abort);
    expect(result).rejects.toBe(failure);
  });

  it('writes consistent JSON, error, and no-store HTML responses', () => {
    const json = responseStub();
    sendJSON(json as unknown as ServerResponse, 201, { success: true });
    expect(json).toMatchObject({
      status: 201,
      headers: { 'Content-Type': 'application/json' },
      body: '{"success":true}',
    });

    const error = responseStub();
    sendError(error as unknown as ServerResponse, 409, 'CONFLICT', 'Already running');
    expect(JSON.parse(error.body ?? '')).toEqual({
      success: false,
      error: { code: 'CONFLICT', message: 'Already running' },
    });

    const html = responseStub();
    sendHTML(html as unknown as ServerResponse, 200, '<p>current</p>');
    expect(html).toMatchObject({
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: '<p>current</p>',
    });
  });

  it('maps oversized body errors and leaves unrelated parse errors to callers', () => {
    const response = responseStub();
    expect(sendRequestParseError(
      response as unknown as ServerResponse,
      new RequestBodyTooLargeError(12),
    )).toBe(true);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body ?? '')).toMatchObject({
      error: { code: 'REQUEST_TOO_LARGE' },
    });

    const untouched = responseStub();
    expect(sendRequestParseError(untouched as unknown as ServerResponse, new Error('bad JSON'))).toBe(false);
    expect(untouched.status).toBeUndefined();
  });

  it('answers malformed URLs with 400 and other throws with 500 instead of crashing', async () => {
    const unexpected: unknown[] = [];
    const run = async (thrower: () => void) => {
      const response = Object.assign(responseStub(), { headersSent: false });
      const handler = guardRequestHandler(async () => { thrower(); }, (err) => unexpected.push(err));
      handler({ method: 'GET', url: '/x' } as IncomingMessage, response as unknown as ServerResponse);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return response;
    };

    expect((await run(() => { new URL('//[', 'http://127.0.0.1:1'); })).status).toBe(400);
    expect((await run(() => { decodeURIComponent('%E0'); })).status).toBe(400);
    expect(unexpected).toHaveLength(0);

    expect((await run(() => { throw new Error('boom'); })).status).toBe(500);
    expect(unexpected).toHaveLength(1);
  });
});
