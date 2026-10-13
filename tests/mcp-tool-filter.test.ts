import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { getMCPTools, type MCPConnection } from '../src/mcp';
import { parseAgentContent } from '../src/parser';

function connectionWith(toolNames: string[], filters: Pick<MCPConnection, 'allowedTools' | 'disallowedTools'>) {
  const tool = {
    description: 'fixture',
    inputSchema: z.object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
  return {
    name: 'srv',
    config: { command: 'unused-fixture' },
    ...filters,
    client: {
      tools: async () => Object.fromEntries(toolNames.map((name) => [name, tool])),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
    },
  } as unknown as MCPConnection;
}

const loaded = async (connection: MCPConnection) =>
  Object.keys(await getMCPTools([connection])).map((name) => name.replace('mcp__srv__', '')).sort();

describe('MCP tool filters', () => {
  const tools = ['balance', 'buy_credits', 'generate_image', 'Upload', '3d_scene'];

  test('allowedTools loads only matching tools, including names a blocklist would miss', async () => {
    expect(await loaded(connectionWith(tools, { allowedTools: ['balance'] }))).toEqual(['balance']);
  });

  test('allowedTools supports wildcards', async () => {
    expect(await loaded(connectionWith(tools, { allowedTools: ['b*'] }))).toEqual(['balance', 'buy_credits']);
  });

  test('disallowedTools wins over allowedTools', async () => {
    expect(await loaded(connectionWith(tools, { allowedTools: ['b*'], disallowedTools: ['buy_*'] }))).toEqual(['balance']);
  });

  test('without allowedTools every tool not blocked loads', async () => {
    expect(await loaded(connectionWith(tools, { disallowedTools: ['generate_*'] })))
      .toEqual(['3d_scene', 'Upload', 'balance', 'buy_credits']);
  });

  test('parser keeps allowedTools on stdio and HTTP servers', () => {
    const agent = parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
mcpServers:
  local:
    command: npx
    allowedTools: ["read_*"]
  remote:
    url: https://example.com/mcp
    allowedTools: ["balance"]
---

Test agent`, 'test');
    expect(agent.config.mcpServers?.local).toMatchObject({ allowedTools: ['read_*'] });
    expect(agent.config.mcpServers?.remote).toMatchObject({ allowedTools: ['balance'] });
  });
});
