import { describe, it, expect, beforeEach } from 'bun:test';
import { parseAgentContent } from '../src/parser';
import { logger } from '../src/utils/logger';

describe('parseAgentContent', () => {
  // Capture warnings during tests
  let warnings: string[] = [];
  const originalWarn = logger.warn.bind(logger);

  beforeEach(() => {
    warnings = [];
    logger.warn = (message: string) => {
      warnings.push(message);
      // Optionally call original for debugging: originalWarn(message);
    };
  });

  describe('MCP servers naming convention', () => {
    it('accepts mcpServers (camelCase) without warning', () => {
      const content = `---
model: anthropic:claude-sonnet-4-0
mcpServers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
---

Test agent`;

      const agent = parseAgentContent(content, 'test');

      expect(agent.config.mcpServers).toBeDefined();
      expect(agent.config.mcpServers?.filesystem).toBeDefined();
      expect(warnings).toHaveLength(0);
    });

    it('accepts mcp_servers (snake_case) with deprecation warning', () => {
      const content = `---
model: anthropic:claude-sonnet-4-0
mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
---

Test agent`;

      const agent = parseAgentContent(content, 'test');

      expect(agent.config.mcpServers).toBeDefined();
      expect(agent.config.mcpServers?.filesystem).toBeDefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('deprecated');
      expect(warnings[0]).toContain('mcpServers');
    });

    it('throws error when both mcp_servers and mcpServers are specified', () => {
      const content = `---
model: anthropic:claude-sonnet-4-0
mcp_servers:
  filesystem:
    command: npx
mcpServers:
  database:
    command: node
---

Test agent`;

      expect(() => parseAgentContent(content, 'test')).toThrow(
        /Cannot specify both "mcp_servers" and "mcpServers"/
      );
    });

    it('normalizes mcp_servers to mcpServers internally', () => {
      const content = `---
model: anthropic:claude-sonnet-4-0
mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
    requiredEnvVars:
      - TEST_VAR
---

Test agent`;

      const agent = parseAgentContent(content, 'test');

      // After transformation, mcpServers should be set
      expect(agent.config.mcpServers).toBeDefined();
      expect(agent.config.mcpServers?.filesystem.command).toBe('npx');
      expect(agent.config.mcpServers?.filesystem.requiredEnvVars).toEqual(['TEST_VAR']);
    });

    it('works with HTTP MCP server configuration', () => {
      const content = `---
model: anthropic:claude-sonnet-4-0
mcpServers:
  remote:
    url: https://api.example.com/mcp
    sessionId: test-session
    auth:
      type: bearer
      token: test-token
---

Test agent`;

      const agent = parseAgentContent(content, 'test');

      expect(agent.config.mcpServers?.remote).toBeDefined();
      expect(agent.config.mcpServers?.remote).toMatchObject({
        url: 'https://api.example.com/mcp',
        sessionId: 'test-session',
        auth: {
          type: 'bearer',
          token: 'test-token'
        }
      });
    });

    it('preserves all MCP server options with mcpServers', () => {
      const content = `---
model: anthropic:claude-sonnet-4-0
mcpServers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    requiredEnvVars:
      - GITHUB_TOKEN
    allowedEnvVars:
      - GITHUB_DEBUG
    disallowedTools:
      - delete_*
    toolTimeout: 120
---

Test agent`;

      const agent = parseAgentContent(content, 'test');

      expect(agent.config.mcpServers?.github).toMatchObject({
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        requiredEnvVars: ['GITHUB_TOKEN'],
        allowedEnvVars: ['GITHUB_DEBUG'],
        disallowedTools: ['delete_*'],
        toolTimeout: 120
      });
    });
  });

  describe('Other agent config fields', () => {
    it('parses complete agent configuration', () => {
      const content = `---
model: openai:gpt-5
description: Test agent for unit tests
timeout: 600
maxSteps: 150
openai:
  reasoningEffort: high
  textVerbosity: medium
mcpServers:
  filesystem:
    command: npx
subagents:
  - path: ./helper.agentuse
    name: helper
    maxSteps: 50
---

# Test Agent

This is a test agent.`;

      const agent = parseAgentContent(content, 'test');

      expect(agent.name).toBe('test');
      expect(agent.config.model).toBe('openai:gpt-5');
      expect(agent.config.description).toBe('Test agent for unit tests');
      expect(agent.config.timeout).toBe(600);
      expect(agent.config.maxSteps).toBe(150);
      expect(agent.config.openai).toMatchObject({
        reasoningEffort: 'high',
        textVerbosity: 'medium'
      });
      expect(agent.config.mcpServers).toBeDefined();
      expect(agent.config.subagents).toHaveLength(1);
      expect(agent.config.subagents?.[0]).toMatchObject({
        path: './helper.agentuse',
        name: 'helper',
        maxSteps: 50
      });
      expect(agent.instructions).toContain('This is a test agent');
    });
  });
});
