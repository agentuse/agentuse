import { createModel } from './models';
import { generateText } from 'ai';
import { logger } from './utils/logger';

interface GeneratedAgent {
  name: string;
  model: string;
  instructions: string;
  mcpServers: Record<string, any> | undefined;
}

interface AgentAnalysis {
  primaryPurpose: string;
  suggestedName: string;
  requiredCapabilities: string[];
  suggestedTools: string[];
  complexityLevel: 'simple' | 'moderate' | 'complex';
  keyBehaviors: string[];
}

// Mapping of capabilities to MCP tools
const CAPABILITY_TO_TOOLS: Record<string, string[]> = {
  'read files': ['file_system'],
  'write files': ['file_system'],
  'modify files': ['file_system'],
  'search code': ['file_system'],
  'browse web': ['playwright'],
  'test web apps': ['playwright'],
  'search documentation': ['context7'],
  'find api docs': ['context7'],
  'search web': ['exa'],
  'research online': ['exa'],
  'run commands': [], // No MCP needed for basic bash
  'execute scripts': [],
  'analyze code': ['file_system'],
  'review code': ['file_system'],
  'debug errors': ['file_system'],
  'generate reports': ['file_system'],
  'process data': ['file_system'],
};

// MCP server configurations
const MCP_CONFIGS: Record<string, any> = {
  file_system: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {
      MCP_FILESYSTEM_ROOT: process.cwd()
    }
  },
  playwright: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-playwright']
  },
  context7: {
    command: 'npx',
    args: ['-y', '@context7/mcp']
  },
  exa: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-exa'],
    env: {
      EXA_API_KEY: '${EXA_API_KEY}'  // User needs to set this
    }
  }
};

export async function generateAgent(description: string, modelOverride?: string): Promise<GeneratedAgent> {
  // Analyze the description
  const analysis = await analyzeDescription(description);
  
  // Map capabilities to MCP tools
  const mcpTools = new Set<string>();
  for (const capability of analysis.requiredCapabilities) {
    const tools = CAPABILITY_TO_TOOLS[capability.toLowerCase()] || [];
    tools.forEach(tool => mcpTools.add(tool));
  }
  
  // Build MCP servers configuration
  const mcpServers: Record<string, any> = {};
  for (const tool of mcpTools) {
    if (MCP_CONFIGS[tool]) {
      mcpServers[tool] = MCP_CONFIGS[tool];
    }
  }
  
  // Select model based on complexity or use override
  const model = modelOverride || selectModel(analysis.complexityLevel);
  
  // Generate detailed instructions
  const instructions = await generateInstructions(
    analysis.primaryPurpose,
    analysis.keyBehaviors,
    analysis.requiredCapabilities
  );
  
  return {
    name: analysis.suggestedName,
    model,
    instructions,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined
  };
}

async function analyzeDescription(description: string): Promise<AgentAnalysis> {
  const prompt = `Analyze this agent description and extract key information.

Description: "${description}"

Provide a JSON response with:
1. primaryPurpose: One clear sentence describing what this agent does
2. suggestedName: A short, descriptive name for the agent (no spaces, use PascalCase)
3. requiredCapabilities: List of capabilities needed (from this exact list: "read files", "write files", "modify files", "search code", "browse web", "test web apps", "search documentation", "find api docs", "search web", "research online", "run commands", "execute scripts", "analyze code", "review code", "debug errors", "generate reports", "process data")
4. suggestedTools: Empty array (always [])
5. complexityLevel: "simple", "moderate", or "complex" based on the task
6. keyBehaviors: List of specific behaviors or guidelines the agent should follow

Important: Respond with ONLY valid JSON, no markdown code blocks or additional text.`;

  try {
    // Use OpenAI for generation since it's more reliable with API keys
    const model = await createModel('openai:gpt-4o');
    const { text } = await generateText({
      model,
      prompt,
      temperature: 0.3,
    });
    
    // Clean up the response to extract JSON
    let jsonText = text.trim();
    // Remove markdown code blocks if present
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.slice(7);
    }
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.slice(0, -3);
    }
    
    // Parse JSON response
    const analysis = JSON.parse(jsonText.trim());
    return analysis;
  } catch (error) {
    logger.error('Failed to analyze description', error as Error);
    
    // Fallback analysis
    return {
      primaryPurpose: description,
      suggestedName: 'CustomAgent',
      requiredCapabilities: ['read files', 'write files'],
      suggestedTools: [],
      complexityLevel: 'moderate',
      keyBehaviors: [description]
    };
  }
}

function selectModel(complexity: 'simple' | 'moderate' | 'complex'): string {
  switch (complexity) {
    case 'simple':
      return 'openai:gpt-4o-mini';
    case 'complex':
      return 'anthropic:claude-3-5-sonnet-20241022';
    case 'moderate':
    default:
      return 'openai:gpt-4o';
  }
}

async function generateInstructions(
  purpose: string,
  behaviors: string[],
  capabilities: string[]
): Promise<string> {
  const prompt = `Generate clear, actionable instructions for an AI agent.

Purpose: ${purpose}

Key Behaviors:
${behaviors.map(b => `- ${b}`).join('\n')}

Required Capabilities:
${capabilities.map(c => `- ${c}`).join('\n')}

Create well-structured markdown instructions that:
1. Start with a clear statement of the agent's purpose
2. List specific guidelines and approaches
3. Include any constraints or limitations
4. Be concise but comprehensive

Format as markdown with appropriate headers.`;

  try {
    // Use OpenAI for generation since it's more reliable with API keys
    const model = await createModel('openai:gpt-4o');
    const { text } = await generateText({
      model,
      prompt,
      temperature: 0.5,
    });
    
    return text;
  } catch (error) {
    logger.error('Failed to generate instructions', error as Error);
    
    // Fallback instructions
    return `## Purpose
${purpose}

## Guidelines
${behaviors.map(b => `- ${b}`).join('\n')}

## Capabilities
This agent can:
${capabilities.map(c => `- ${c}`).join('\n')}`;
  }
}