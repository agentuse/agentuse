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
  onboarding: `# Project pulse

**Status:** On track

## Progress

- The new onboarding path is ready for review.
- The first-run experience now has one clear next action.
- Dashboard and session views passed their latest checks.

## Needs attention

- Confirm the final empty-state copy with one new user.
- Add an activation event for the first real agent run.

## Recommended next move

Ship the onboarding update, then watch how many new users create and run an agent in their first session.

> Simulated run — this report uses sample project data.

---

## Create your own agent

1. Select **Create my first agent…** below.
2. Describe one job you want to automate. Copy the generated prompt and paste it into your coding agent.
3. The coding agent checks whether AgentUse has a model provider. If not, it helps you connect one before creating anything.
4. Keep this dashboard open while it creates and validates the \`.agentuse\` file with a model from that provider. Your new agent appears automatically.
5. Open the new agent and select **Run**.`,

  hello: `# Create your first AgentUse agent

You just completed an AgentUse run with the demo model — no API key required.

## Create the real agent with your coding agent

If you are viewing this in the dashboard, choose **Create my first agent…** below. It prepares the handoff for you.

From a terminal, install the AgentUse skill first:

\`\`\`bash
npx skills add agentuse/agentuse
\`\`\`

Then paste this into Codex, Claude Code, Cursor, or another Agent Skills-compatible coding agent:

\`\`\`text
Help me create my first AgentUse agent.

Use the installed AgentUse skill and load the current core and creator guidance first. If I have not described the recurring job yet, interview me before creating anything. Ask concise questions one at a time until you understand the job, trigger, inputs, desired output, success criteria, and any consequential actions that require human approval.

Once the requirements are clear, run agentuse provider list. If no AgentUse runtime provider is configured, do not create the file yet; guide me through agentuse provider login and wait until it is ready. Then create one focused .agentuse file using only a model from a configured provider. Validate it with agentuse doctor and agentuse test, and fix any issues.

Do not start a real run automatically. If agentuse serve is already running, tell me when the new agent should appear in its dashboard. Otherwise, give me the exact command to start it. Then guide me through launching the first real run from the Web UI.
\`\`\`

Keep this dashboard open. AgentUse detects the new file automatically.`,

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
  // The first-run guide should feel immediate in the dashboard. It is longer
  // than the tiny test responses, so use a brisker type-on cadence.
  const streamDelayMs = modelId === 'hello' || modelId === 'onboarding' ? 5 : 20;

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
            await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
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
