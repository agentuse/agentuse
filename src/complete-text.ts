import { streamText } from 'ai';
import { createModel } from './models';
import { CodexAuth } from './auth/codex';
import { resolveModelProvider } from './utils/model-utils';
import {
  createStallWatchdog,
  estimateModelContextTokens,
  ModelStreamStallError,
  resolveModelStallPolicy,
} from './runner/model-stall';

export interface CompleteTextOptions {
  /** System prompt (v7 `instructions`). On the Codex backend this is also sent as the required provider-level `instructions`. */
  instructions: string;
  /**
   * A second system block, sent after `instructions`.
   *
   * Exists because Anthropic OAuth requires `instructions` to be exactly the
   * Claude Code identity line, leaving nowhere to say what job the call is
   * doing. See `helperSystemPrompt`, which is how callers should build the
   * pair rather than setting this by hand.
   */
  extraSystem?: string | undefined;
  /** User prompt. */
  prompt: string;
  /** Output cap. Omitted on the Codex backend, which rejects `max_output_tokens`. */
  maxOutputTokens?: number;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  /** Optional live text observer for UI surfaces that expose helper progress. */
  onTextDelta?: (text: string) => void;
  /**
   * Idle window before a silent stream is treated as stalled, in milliseconds.
   * Defaults to the adaptive model policy; `AGENTUSE_MODEL_IDLE_TIMEOUT`
   * overrides it in seconds and `0` disables it.
   * Exists for tests; production callers should use the env var.
   */
  idleTimeoutMs?: number;
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
  // Stop/timeout share this signal. Check around every setup await as well as
  // passing it to the provider so cancellation cannot arrive during model/auth
  // preparation and still start a new helper request afterward.
  options.abortSignal?.throwIfAborted();
  const model = await createModel(modelString);
  options.abortSignal?.throwIfAborted();
  // Mirror createModel's decision: a plain `openai:` model with Codex OAuth
  // available resolves to the Responses API against the ChatGPT backend.
  const usesCodexBackend = resolveModelProvider(modelString) === 'openai' && Boolean(await CodexAuth.access());
  options.abortSignal?.throwIfAborted();

  // Stall watchdog: a helper stream that opens and then never emits would
  // otherwise hang until the session timeout. Combined with (never replacing)
  // the caller's signal, so cancellation still works.
  const policy = options.idleTimeoutMs === undefined
    ? resolveModelStallPolicy({
        modelString,
        contextTokens: estimateModelContextTokens([options.instructions, options.extraSystem, options.prompt]),
        codexBackend: usesCodexBackend,
      })
    : options.idleTimeoutMs;
  const watchdog = createStallWatchdog(policy, options.abortSignal);

  const result = streamText({
    model,
    instructions: options.instructions,
    // A second system block has to travel in `messages`, which v7 rejects
    // unless told the system role is intentional — the same opt-in the agent
    // loop uses. Without `extraSystem` the plain `prompt` form is kept, so
    // every existing caller sends the identical request it sent before.
    ...(options.extraSystem
      ? {
          allowSystemInMessages: true,
          messages: [
            { role: 'system' as const, content: options.extraSystem },
            { role: 'user' as const, content: options.prompt },
          ],
        }
      : { prompt: options.prompt }),
    maxRetries: options.maxRetries ?? 2,
    // Codex rejects max_output_tokens; honor the cap on every other provider.
    ...(!usesCodexBackend && options.maxOutputTokens !== undefined && { maxOutputTokens: options.maxOutputTokens }),
    // Codex requires the top-level instructions field; the system message in
    // `messages` alone is not enough.
    ...(usesCodexBackend && { providerOptions: { openai: { instructions: options.instructions, store: false } } }),
    abortSignal: watchdog.signal,
    // Swallow the SDK's own error logging. Its default `onError` prints the raw
    // error object to the console, so a helper call that failed and was handled
    // — a tidy-up group that retries, an overloaded provider — still dumped a
    // stack trace into the middle of a run that went on to succeed. Nothing is
    // lost: the error chunk below throws, and the caller decides what to say.
    onError: () => {},
  });

  let text = '';
  try {
    for await (const chunk of result.stream) {
      // Reasoning is model progress too: a thinking model can reason past the
      // idle window before its first visible token, exactly as the agent loop
      // already allows.
      watchdog.notify(chunk.type === 'text-delta' || chunk.type === 'reasoning-delta');
      if (chunk.type === 'error') {
        if (watchdog.stalled) throw watchdog.failure ?? new ModelStreamStallError(0);
        throw (chunk as { error: unknown }).error;
      }
      if (chunk.type === 'text-delta') {
        const delta = (chunk as { text?: string }).text ?? '';
        text += delta;
        if (delta) options.onTextDelta?.(delta);
      }
    }
  } catch (error) {
    // A stall aborts our own controller, so the provider surfaces a generic
    // abort. Report the real cause instead.
    if (watchdog.stalled) throw watchdog.failure ?? new ModelStreamStallError(0);
    throw error;
  } finally {
    watchdog.dispose();
  }
  // Some provider streams end quietly on abort. Never turn their partial text
  // into a successful compaction or verification result.
  if (watchdog.stalled) throw watchdog.failure ?? new ModelStreamStallError(0);
  options.abortSignal?.throwIfAborted();
  return text;
}
