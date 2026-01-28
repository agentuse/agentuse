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
const DEMO_RESPONSES: Record<string, string> = {
  hello: `# Welcome to AgentUse! 👋

AgentUse lets you build autonomous AI agents using simple Markdown files.

## What You Can Do

- **Write agents in Markdown** - No complex frameworks, just natural language instructions
- **Use any LLM provider** - OpenAI, Anthropic, or open-source models via OpenRouter
- **Trigger on events** - Run agents on schedules, webhooks, or CI/CD

## Getting Started

1. **Authenticate with your preferred provider:**
   \`\`\`bash
   agentuse auth login openai
   \`\`\`

2. **Create an autonomous agent** (e.g., \`domain-check.agentuse\`):
   \`\`\`yaml
   ---
   model: openai:gpt-5.2
   schedule: "0 9 * * 1"  # Every Monday at 9am
   tools:
     bash:
       commands: ["whois *"]
   ---
   Check when mysite.com expires.
   Alert me if it's within 30 days.
   \`\`\`

3. **Start the scheduler:**
   \`\`\`bash
   agentuse serve
   \`\`\`

## Learn More

- Documentation: https://docs.agentuse.io/
- GitHub: https://github.com/agentuse/agentuse

Happy building! 🚀`,

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
