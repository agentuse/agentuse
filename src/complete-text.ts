import { streamText } from 'ai';
import { createModel } from './models';
import { CodexAuth } from './auth/codex';

export interface CompleteTextOptions {
  /** System prompt. On the Codex backend this is also sent as the required `instructions`. */
  system: string;
  /** User prompt. */
  prompt: string;
  /** Output cap. Omitted on the Codex backend, which rejects `max_output_tokens`. */
  maxOutputTokens?: number;
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

/**
 * Single-shot text completion that works across providers, including the
 * ChatGPT Codex (OAuth) backend.
 *
 * `generateText()` cannot be used on Codex: that backend rejects non-streaming
 * requests ("Stream must be set to true"), requires a top-level `instructions`
 * field ("Instructions are required"), and rejects `max_output_tokens`
 * ("Unsupported parameter"). The main agent loop already streams and sets
 * `instructions`; helper LLM calls (compaction, summaries, judges) must do the
 * same instead of reaching for `generateText()`, or they 400 the moment a
 * Codex-authed user triggers them.
 *
 * No `temperature` is sent: frontier models reject a custom value outright
 * (Anthropic Opus 4.8/4.7 and Fable 5 400 with "Extra inputs are not permitted";
 * OpenAI GPT-5 / reasoning models reject it as deprecated), and the default
 * works everywhere. These are short helper calls where the consistency nudge of
 * a low temperature isn't worth the cross-provider breakage.
 */
export async function completeText(modelString: string, options: CompleteTextOptions): Promise<string> {
  const model = await createModel(modelString);
  // Mirror createModel's decision: a plain `openai:` model with Codex OAuth
  // available resolves to the Responses API against the ChatGPT backend.
  const usesCodexBackend = modelString.split(':')[0] === 'openai' && Boolean(await CodexAuth.access());

  const result = streamText({
    model,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.prompt },
    ],
    maxRetries: options.maxRetries ?? 2,
    // Codex rejects max_output_tokens; honor the cap on every other provider.
    ...(!usesCodexBackend && options.maxOutputTokens !== undefined && { maxOutputTokens: options.maxOutputTokens }),
    // Codex requires the top-level instructions field; the system message in
    // `messages` alone is not enough.
    ...(usesCodexBackend && { providerOptions: { openai: { instructions: options.system, store: false } } }),
    ...(options.abortSignal && { abortSignal: options.abortSignal }),
  });

  let text = '';
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      throw (chunk as { error: unknown }).error;
    }
    if (chunk.type === 'text-delta') {
      text += (chunk as { text?: string }).text ?? '';
    }
  }
  return text;
}
