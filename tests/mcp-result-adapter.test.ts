import { describe, expect, mock, test } from 'bun:test';
import { getMCPTools, mcpResultToModelOutput, type MCPConnection } from '../src/mcp';

describe('MCP result model output', () => {
  test('preserves text and structured content', () => {
    expect(mcpResultToModelOutput({
      output: {
        content: [{ type: 'text', text: 'human-readable result' }],
        structuredContent: { count: 2, records: ['a', 'b'] },
      },
    })).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'human-readable result' },
        {
          type: 'text',
          text: '[MCP structured content]\n{"count":2,"records":["a","b"]}',
        },
      ],
    });
  });

  test('preserves image, audio, and file payloads', () => {
    expect(mcpResultToModelOutput({
      output: {
        content: [
          { type: 'image', data: 'image-bytes', mimeType: 'image/png' },
          { type: 'audio', data: 'audio-bytes', mimeType: 'audio/wav' },
          {
            type: 'file',
            data: 'file-bytes',
            mimeType: 'application/pdf',
            name: 'report.pdf',
          },
        ],
      },
    })).toEqual({
      type: 'content',
      value: [
        { type: 'image-data', data: 'image-bytes', mediaType: 'image/png' },
        { type: 'file-data', data: 'audio-bytes', mediaType: 'audio/wav' },
        {
          type: 'file-data',
          data: 'file-bytes',
          mediaType: 'application/pdf',
          filename: 'report.pdf',
        },
      ],
    });
  });

  test('preserves text and binary resources with their metadata', () => {
    const output = mcpResultToModelOutput({
      output: {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///notes.txt',
              mimeType: 'text/plain',
              text: 'important notes',
            },
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///archive.zip',
              name: 'archive.zip',
              mimeType: 'application/zip',
              blob: 'archive-bytes',
            },
          },
          {
            type: 'resource_link',
            uri: 'https://example.test/resource',
            name: 'remote resource',
          },
        ],
      },
    }) as any;

    expect(output.type).toBe('content');
    expect(output.value[0].text).toContain('important notes');
    expect(output.value[0].text).toContain('file:///notes.txt');
    expect(output.value[1].text).toContain('file:///archive.zip');
    expect(output.value[1].text).not.toContain('archive-bytes');
    expect(output.value[2]).toEqual({
      type: 'file-data',
      data: 'archive-bytes',
      mediaType: 'application/zip',
      filename: 'archive.zip',
    });
    expect(output.value[3].text).toContain('https://example.test/resource');
  });

  test('fails explicitly for unsupported MCP content', () => {
    expect(() => mcpResultToModelOutput({
      output: { content: [{ type: 'future-protocol-block', value: 42 }] },
    })).toThrow('Unsupported MCP content type "future-protocol-block"');
  });

  test('wrapped MCP tools return the raw result used by toModelOutput', async () => {
    const result = {
      content: [
        { type: 'text', text: 'preview' },
        { type: 'image', data: 'image-bytes', mimeType: 'image/png' },
      ],
      structuredContent: { id: 'record-1' },
    };
    const execute = mock(async () => result);
    const connection = {
      name: 'demo',
      client: {},
      preloadedTools: {
        inspect: {
          description: 'Inspect a record',
          inputSchema: {},
          execute,
        },
      },
    } as unknown as MCPConnection;

    const tools = await getMCPTools([connection]);
    const wrapped = tools.mcp__demo__inspect as any;
    const rawOutput = await wrapped.execute({}, {});

    expect(rawOutput).toBe(result);
    expect(wrapped.toModelOutput({ output: rawOutput })).toEqual(
      mcpResultToModelOutput({ output: result })
    );
  });
});
