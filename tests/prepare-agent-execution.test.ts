import { describe, it, expect, beforeEach } from 'bun:test';
import { prepareAgentExecution, buildAutonomousAgentPrompt } from '../src/runner';
import type { ParsedAgent } from '../src/parser';
import type { MCPConnection } from '../src/mcp';

/**
 * Tests for prepareAgentExecution and buildAutonomousAgentPrompt from runner.ts
 *
 * These tests verify the shared setup logic extracted for both
 * runAgent and the HTTP serve command.
 */

// Create a mock agent for testing
function createMockAgent(overrides: Partial<ParsedAgent> = {}): ParsedAgent {
  return {
    name: 'test-agent',
    instructions: 'Test instructions for the agent',
    description: 'A test agent',
    config: {
      model: 'anthropic:claude-sonnet-4-0',
      ...overrides.config
    },
    ...overrides
  };
}

describe('buildAutonomousAgentPrompt', () => {
  it('should include the date in the prompt', () => {
    const date = 'Monday, January 1, 2025';
    const prompt = buildAutonomousAgentPrompt(date, false);

    expect(prompt).toContain('Today\'s date: Monday, January 1, 2025');
  });

  it('should include base instructions for main agent', () => {
    const prompt = buildAutonomousAgentPrompt('Monday, January 1, 2025', false);

    expect(prompt).toContain('autonomous AI agent');
    expect(prompt).toContain('Break it down into clear steps');
    expect(prompt).toContain('Execute each step thoroughly');
    expect(prompt).toContain('DO NOT narrate actions');
  });

  it('should add sub-agent specific instruction when isSubAgent is true', () => {
    const prompt = buildAutonomousAgentPrompt('Monday, January 1, 2025', true);

    expect(prompt).toContain('Provide only essential summary when complete');
  });

  it('should not include sub-agent instruction when isSubAgent is false', () => {
    const prompt = buildAutonomousAgentPrompt('Monday, January 1, 2025', false);

    expect(prompt).not.toContain('Provide only essential summary when complete');
  });

  it('should handle different date formats', () => {
    const date = 'Wednesday, December 25, 2024';
    const prompt = buildAutonomousAgentPrompt(date, false);

    expect(prompt).toContain(date);
  });
});

describe('prepareAgentExecution', () => {
  describe('system messages', () => {
    it('should include Claude Code message for Anthropic models', async () => {
      const agent = createMockAgent({
        config: { model: 'anthropic:claude-sonnet-4-0' }
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(result.systemMessages.length).toBeGreaterThanOrEqual(2);
      expect(result.systemMessages[0].content).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude."
      );
      expect(result.systemMessages[0].role).toBe('system');
    });

    it('should not include Claude Code message for non-Anthropic models', async () => {
      const agent = createMockAgent({
        config: { model: 'openai:gpt-4.1' }
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      // Should only have the autonomous agent prompt
      expect(result.systemMessages.length).toBe(1);
      expect(result.systemMessages[0].content).not.toContain("Claude Code");
    });

    it('should include autonomous agent prompt for all models', async () => {
      const agentAnthropic = createMockAgent({
        config: { model: 'anthropic:claude-sonnet-4-0' }
      });
      const agentOpenAI = createMockAgent({
        config: { model: 'openai:gpt-4.1' }
      });

      const resultAnthropic = await prepareAgentExecution({
        agent: agentAnthropic,
        mcpClients: []
      });
      const resultOpenAI = await prepareAgentExecution({
        agent: agentOpenAI,
        mcpClients: []
      });

      // Both should have the autonomous agent prompt
      const anthropicLastMessage = resultAnthropic.systemMessages[resultAnthropic.systemMessages.length - 1];
      const openAILastMessage = resultOpenAI.systemMessages[resultOpenAI.systemMessages.length - 1];

      expect(anthropicLastMessage.content).toContain('autonomous AI agent');
      expect(openAILastMessage.content).toContain('autonomous AI agent');
    });
  });

  describe('user message building', () => {
    it('should use agent instructions as user message', async () => {
      const agent = createMockAgent({
        instructions: 'Do this specific task'
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(result.userMessage).toBe('Do this specific task');
    });

    it('should concatenate instructions and user prompt when both provided', async () => {
      const agent = createMockAgent({
        instructions: 'Base task instructions'
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: [],
        userPrompt: 'Additional user input'
      });

      expect(result.userMessage).toBe('Base task instructions\n\nAdditional user input');
    });

    it('should handle empty instructions with user prompt', async () => {
      const agent = createMockAgent({
        instructions: ''
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: [],
        userPrompt: 'User input only'
      });

      expect(result.userMessage).toBe('\n\nUser input only');
    });
  });

  describe('maxSteps resolution', () => {
    it('should use CLI maxSteps when provided', async () => {
      const agent = createMockAgent({
        config: {
          model: 'anthropic:claude-sonnet-4-0',
          maxSteps: 50
        }
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: [],
        cliMaxSteps: 100
      });

      expect(result.maxSteps).toBe(100);
    });

    it('should use agent config maxSteps when CLI not provided', async () => {
      const agent = createMockAgent({
        config: {
          model: 'anthropic:claude-sonnet-4-0',
          maxSteps: 75
        }
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(result.maxSteps).toBe(75);
    });

    it('should use default maxSteps when neither CLI nor config provided', async () => {
      const agent = createMockAgent();

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      // Default is 100 based on DEFAULT_MAX_STEPS
      expect(result.maxSteps).toBe(100);
    });
  });

  describe('tools merging', () => {
    it('should return empty tools when no MCP clients and no configured tools', async () => {
      const agent = createMockAgent();

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(Object.keys(result.tools).length).toBe(0);
    });

    it('should include configured tools when project context is provided', async () => {
      const agent = createMockAgent({
        config: {
          model: 'anthropic:claude-sonnet-4-0',
          tools: {
            bash: { commands: ['ls', 'pwd'] }
          }
        }
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: [],
        projectContext: {
          projectRoot: '/tmp/test-project',
          cwd: '/tmp/test-project'
        }
      });

      // Should have bash tool
      expect(result.tools).toBeDefined();
      expect(Object.keys(result.tools).length).toBeGreaterThan(0);
    });
  });

  describe('subAgentNames tracking', () => {
    it('should return empty Set when no subagents configured', async () => {
      const agent = createMockAgent();

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(result.subAgentNames).toBeInstanceOf(Set);
      expect(result.subAgentNames.size).toBe(0);
    });
  });

  describe('doomLoopDetector', () => {
    it('should create doom loop detector', async () => {
      const agent = createMockAgent();

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(result.doomLoopDetector).toBeDefined();
    });
  });

  describe('session handling', () => {
    it('should not create session when sessionManager is not provided', async () => {
      const agent = createMockAgent();

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      expect(result.sessionID).toBeUndefined();
      expect(result.assistantMsgID).toBeUndefined();
    });

    it('should not create session when projectContext is not provided', async () => {
      const agent = createMockAgent();

      // Even with sessionManager, without projectContext, session won't be created
      const result = await prepareAgentExecution({
        agent,
        mcpClients: [],
        // sessionManager provided but no projectContext
      });

      expect(result.sessionID).toBeUndefined();
    });
  });

  describe('PreparedAgentExecution interface completeness', () => {
    it('should return all required fields', async () => {
      const agent = createMockAgent();

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      // Verify all required fields exist
      expect(result).toHaveProperty('tools');
      expect(result).toHaveProperty('systemMessages');
      expect(result).toHaveProperty('userMessage');
      expect(result).toHaveProperty('maxSteps');
      expect(result).toHaveProperty('subAgentNames');
      expect(result).toHaveProperty('doomLoopDetector');

      // Optional fields may be undefined but property should exist
      expect('sessionID' in result).toBe(true);
      expect('assistantMsgID' in result).toBe(true);
    });
  });

  describe('model detection', () => {
    it('should detect anthropic in model string with prefix', async () => {
      const agent = createMockAgent({
        config: { model: 'anthropic:claude-sonnet-4-0' }
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      // Should have Claude Code message for anthropic
      expect(result.systemMessages.some(m =>
        m.content.includes("Claude Code")
      )).toBe(true);
    });

    it('should detect anthropic in model string without prefix', async () => {
      const agent = createMockAgent({
        config: { model: 'claude-anthropic-model' } // anthropic in the string
      });

      const result = await prepareAgentExecution({
        agent,
        mcpClients: []
      });

      // Should have Claude Code message
      expect(result.systemMessages.some(m =>
        m.content.includes("Claude Code")
      )).toBe(true);
    });
  });
});

describe('prepareAgentExecution - Edge Cases', () => {
  it('should handle agent with minimal config', async () => {
    const minimalAgent: ParsedAgent = {
      name: 'minimal',
      instructions: 'Do something',
      config: {
        model: 'openai:gpt-4.1'
      }
    };

    const result = await prepareAgentExecution({
      agent: minimalAgent,
      mcpClients: []
    });

    expect(result.userMessage).toBe('Do something');
    expect(result.maxSteps).toBe(100); // default
  });

  it('should handle empty MCP clients array', async () => {
    const agent = createMockAgent();

    const result = await prepareAgentExecution({
      agent,
      mcpClients: []
    });

    expect(Object.keys(result.tools).length).toBe(0);
  });

  it('should handle special characters in instructions', async () => {
    const agent = createMockAgent({
      instructions: 'Task with "quotes" and \'apostrophes\' and <tags> and $variables'
    });

    const result = await prepareAgentExecution({
      agent,
      mcpClients: []
    });

    expect(result.userMessage).toContain('"quotes"');
    expect(result.userMessage).toContain("'apostrophes'");
    expect(result.userMessage).toContain('<tags>');
    expect(result.userMessage).toContain('$variables');
  });

  it('should handle multiline instructions', async () => {
    const agent = createMockAgent({
      instructions: `Line 1
Line 2
Line 3`
    });

    const result = await prepareAgentExecution({
      agent,
      mcpClients: []
    });

    expect(result.userMessage).toContain('Line 1');
    expect(result.userMessage).toContain('Line 2');
    expect(result.userMessage).toContain('Line 3');
  });

  it('should handle verbose mode without errors', async () => {
    const agent = createMockAgent();

    // Should not throw when verbose is true
    const result = await prepareAgentExecution({
      agent,
      mcpClients: [],
      verbose: true
    });

    expect(result).toBeDefined();
  });

  it('should handle abort signal parameter', async () => {
    const agent = createMockAgent();
    const abortController = new AbortController();

    const result = await prepareAgentExecution({
      agent,
      mcpClients: [],
      abortSignal: abortController.signal
    });

    // Should complete without issues
    expect(result).toBeDefined();
  });
});
