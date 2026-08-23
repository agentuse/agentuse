/**
 * Demo Provider - A mock language model provider for zero-config trials
 *
 * This provider streams hardcoded responses without requiring any API keys,
 * allowing users to try AgentUse immediately with:
 *   npx -y agentuse@latest run https://agentuse.io/hello.agentuse
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';

// Demo responses for different model variants
// Exported so tests can assert on the live copy instead of hardcoding phrases.
export const DEMO_RESPONSES: Record<string, string> = {
  hello: `# Create your first AgentUse agent

This guide uses a demo model, so you can complete these setup steps without an API key.

## 1. Give your coding agent AgentUse guidance

Run this in your project:

\`\`\`bash
npx skills add agentuse/agentuse
\`\`\`

This installs the AgentUse skill for coding agents such as Codex, Claude Code, Cursor, and other Agent Skills-compatible assistants.

## 2. Ask it to create your first agent

Copy and paste this prompt into your coding agent:

\`\`\`text
Help me create my first AgentUse agent.

Use the installed AgentUse skill and load the current core and creator guidance first. If I have not described the recurring job yet, interview me before creating anything. Ask concise questions one at a time until you understand the job, trigger, inputs, desired output, success criteria, and any consequential actions that require human approval.

Once the requirements are clear, create one focused .agentuse file in this repository. Validate it with agentuse doctor and agentuse test, and fix any issues.

Then give me step-by-step instructions for configuring the agent's chosen model provider, running the agent directly, and setting it up with agentuse serve. Include the exact commands for my agent file and explain any credentials or environment variables I need before running them.
\`\`\`

Your coding agent will create the file, validate it, test it safely, and give you the command for the first real run.`,

  welcome: `Welcome! This is a demo response from AgentUse.

AgentUse lets you build autonomous AI agents using simple Markdown files.

To get started with real AI models, run:
  agentuse auth login

For more information, visit: https://docs.agentuse.io/`,

  default: `This is a demo response from AgentUse.

The demo provider is used for testing and zero-config trials.
To use real AI models, run:
  agentuse auth login

Learn more: https://docs.agentuse.io/`,
};

/**
 * Creates a demo language model that streams hardcoded responses
 */
export function createDemoModel(modelId: string): LanguageModelV2 {
  // Suppress AI SDK compatibility warnings for demo provider
  (globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

  const responseKey = modelId in DEMO_RESPONSES ? modelId : 'default';
  const responseText = DEMO_RESPONSES[responseKey];

  return {
    specificationVersion: 'v2',
    provider: 'demo',
    modelId: `demo:${modelId}`,
    supportedUrls: {},

    async doGenerate(_options: LanguageModelV2CallOptions) {
      // Simulate a small delay for realism
      await new Promise((resolve) => setTimeout(resolve, 100));

      const outputTokens = responseText.split(/\s+/).length;
      const inputTokens = 10;

      return {
        content: [{ type: 'text' as const, text: responseText }],
        finishReason: 'stop' as const,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV2CallOptions) {
      const abortSignal = options.abortSignal;
      const words = responseText.split(/(\s+)/);
      const outputTokens = words.filter((w) => w.trim()).length;
      const inputTokens = 10;
      const textId = 'demo-text-0';

      // Create a ReadableStream that yields text chunks word by word
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          // Emit text-start
          controller.enqueue({
            type: 'text-start',
            id: textId,
          });

          for (const word of words) {
            // Check for abort
            if (abortSignal?.aborted) {
              controller.close();
              return;
            }

            // Yield each word/whitespace as a text delta
            controller.enqueue({
              type: 'text-delta',
              id: textId,
              delta: word,
            });

            // Small delay between words for streaming effect
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          // Emit text-end
          controller.enqueue({
            type: 'text-end',
            id: textId,
          });

          // Yield finish event
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            },
          });

          controller.close();
        },
      });

      return {
        stream,
      };
    },
  };
}
