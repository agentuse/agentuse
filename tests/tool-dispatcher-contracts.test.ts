import { describe, expect, it, mock } from 'bun:test';
import * as aiSdk from 'ai';
import { z } from 'zod';
import { buildCodeModeToolContractsSync } from '../src/runner/code-mode-contracts';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';
import {
  isToolDispatchExecution,
  prevalidatedTrustedOutput,
  trustedOutputTool,
} from '../src/tools/tool-contract';

describe('dispatcher execution boundaries', () => {
  it('does not execute after a preflight wait is cancelled', async () => {
    const execute = mock(async () => ({ ok: true }));
    const controller = new AbortController();
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({}),
      execute,
    } }, {
      pluginEvents: {
        async toolCall() {
          await new Promise(resolve => setTimeout(resolve, 25));
          return {};
        },
      },
    });
    setTimeout(() => controller.abort(new Error('deadline')), 5);

    await expect(dispatcher.dispatch('write', {}, {
      toolCallId: 'late-effect',
      abortSignal: controller.signal,
    })).rejects.toThrow('deadline');
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases a call when a plugin preflight hook never settles', async () => {
    const execute = mock(async () => ({ ok: true }));
    const controller = new AbortController();
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({}),
      execute,
    } }, {
      pluginEvents: {
        async toolCall() {
          return await new Promise<never>(() => {});
        },
      },
    });
    setTimeout(() => controller.abort(new Error('deadline')), 5);

    await expect(dispatcher.dispatch('write', {}, {
      toolCallId: 'never-settling-preflight',
      abortSignal: controller.signal,
    })).rejects.toThrow('deadline');
    expect(execute).not.toHaveBeenCalled();
  });

  it('revalidates a plugin-mutated input before execution', async () => {
    const execute = mock(async () => ({ ok: true }));
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ id: z.string() }),
      execute,
    } }, {
      pluginEvents: {
        async toolCall(event) {
          event.input.id = 42;
          return {};
        },
      },
    });
    await expect(dispatcher.dispatch('write', { id: 'safe' }, { toolCallId: 'mutated-input' }))
      .rejects.toThrow(/Invalid input/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not validate or transform an unchanged nested input twice', async () => {
    let transforms = 0;
    const dispatcher = new ToolDispatcher({ once: {
      inputSchema: z.object({ value: z.number() })
        .transform(value => ({ ...value, value: value.value + (++transforms) })),
      execute: async input => input,
    } });
    await expect(dispatcher.dispatch('once', { value: 1 }, { toolCallId: 'nested-once' }))
      .resolves.toEqual({ value: 2 });
    expect(transforms).toBe(1);
  });

  it('normalizes a nested property exactly once after raw plugin preflight', async () => {
    let transforms = 0;
    const dispatcher = new ToolDispatcher({ once: {
      inputSchema: z.object({
        value: z.number().transform(value => value + (++transforms)),
        note: z.string().optional(),
      }),
      execute: async input => input,
    } }, {
      pluginEvents: { async toolCall(event) { event.input.note = 'plugin'; return {}; } },
    });
    await expect(dispatcher.dispatch('once', { value: 1 }, { toolCallId: 'nested-property-once' }))
      .resolves.toEqual({ value: 2, note: 'plugin' });
    expect(transforms).toBe(1);
  });

  it('uses a shape-changing standard validator exactly once for prepared direct calls', async () => {
    let validations = 0;
    const inputSchema = aiSdk.jsonSchema({}, {
      validate: async value => ({
        success: true as const,
        value: { normalized: (value as { raw: string }).raw, pass: ++validations },
      }),
    });
    const dispatcher = new ToolDispatcher({ shape: {
      inputSchema,
      execute: async input => input,
    } });
    await dispatcher.prepareDirectCall({ toolName: 'shape', toolCallId: 'shape-once', input: { raw: 'safe' } });
    await expect((dispatcher.modelTools().shape as any).execute({ raw: 'replacement' }, {
      toolCallId: 'shape-once', messages: [],
    })).resolves.toEqual({ normalized: 'safe', pass: 1 });
    expect(validations).toBe(1);
  });

  it('keeps SDK transport validation structural and normalizes only after approval', async () => {
    let transforms = 0;
    const inputSchema = z.object({ value: z.number() })
      .transform(value => ({ value: value.value + (++transforms) }));
    const dispatcher = new ToolDispatcher({ write: { inputSchema, execute: async input => input } });
    const transport = aiSdk.asSchema((dispatcher.modelTools().write as any).inputSchema);
    await expect(transport.validate!({ value: 1 })).resolves.toEqual({ success: true, value: { value: 1 } });
    expect(transforms).toBe(0);
    await expect(transport.validate!({ value: 'bad' })).resolves.toMatchObject({ success: false });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'transport-once', input: { value: 1 } });
    await expect((dispatcher.modelTools().write as any).execute({ value: 999 }, {
      toolCallId: 'transport-once', messages: [],
    })).resolves.toEqual({ value: 2 });
    expect(transforms).toBe(1);
  });

  it('flattens top-level provider unions while retaining canonical validation', async () => {
    const inputSchema = z.discriminatedUnion('action', [
      z.object({ action: z.literal('list'), limit: z.number().int().optional() }).strict(),
      z.object({ action: z.literal('read'), resultId: z.string() }).strict(),
    ]);
    const dispatcher = new ToolDispatcher({ results: {
      inputSchema,
      execute: async input => input,
    } });
    const transport = aiSdk.asSchema((dispatcher.modelTools().results as any).inputSchema);

    expect(transport.jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read'] },
        limit: { type: 'integer' },
        resultId: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    });
    expect((transport.jsonSchema as any).anyOf).toBeUndefined();
    expect((transport.jsonSchema as any).oneOf).toBeUndefined();
    expect((transport.jsonSchema as any).allOf).toBeUndefined();
    await expect(transport.validate!({ action: 'read', resultId: 'result-1' }))
      .resolves.toMatchObject({ success: true });
    // The provider surface is intentionally looser than the discriminated
    // runtime schema, which remains authoritative immediately before effect.
    await expect(transport.validate!({ action: 'read' }))
      .resolves.toMatchObject({ success: true });
    await expect(dispatcher.dispatch('results', { action: 'read' }, { toolCallId: 'invalid-read' }))
      .rejects.toThrow("Invalid input for tool 'results'");
  });

  it('keeps standard URI and UUID format validation on the SDK transport schema', async () => {
    const dispatcher = new ToolDispatcher({ formatCheck: {
      inputSchema: z.object({
        callbackUrl: z.string().url(),
        requestId: z.string().uuid(),
      }),
      execute: async input => input,
    } });
    const transport = aiSdk.asSchema((dispatcher.modelTools().formatCheck as any).inputSchema);

    await expect(transport.validate!({
      callbackUrl: 'not a URI',
      requestId: 'not-a-uuid',
    })).resolves.toMatchObject({ success: false });
    await expect(transport.validate!({
      callbackUrl: 'https://example.test/callback',
      requestId: '5d45a9b4-d366-4dc7-b329-e1fbd9d2d14f',
    })).resolves.toMatchObject({ success: true });
  });

  it('ignores provider-specific unknown formats on the SDK transport schema', async () => {
    const inputSchema = aiSdk.jsonSchema({
      type: 'object',
      properties: { token: { type: 'string', format: 'provider-token' } },
      required: ['token'],
      additionalProperties: false,
    });
    const dispatcher = new ToolDispatcher({ customFormat: {
      inputSchema,
      execute: async input => input,
    } });
    const transport = aiSdk.asSchema((dispatcher.modelTools().customFormat as any).inputSchema);
    await expect(transport.validate!({ token: 'opaque' })).resolves.toMatchObject({ success: true });
  });

  it('keeps non-executable schemas intact for SDK validation and repair', () => {
    const inputSchema = z.object({ id: z.string() });
    const dispatcher = new ToolDispatcher({ passive: { inputSchema } as any });
    expect((dispatcher.modelTools().passive as any).inputSchema).toBe(inputSchema);
  });

  it('propagates primitive plugin edits into the one canonical normalization', async () => {
    const dispatcher = new ToolDispatcher({ primitive: {
      inputSchema: z.number(),
      execute: async input => input,
    } }, {
      pluginEvents: { async toolCall(event) { event.input.value = 2; return {}; } },
    });
    await expect(dispatcher.dispatch('primitive', 1, { toolCallId: 'nested-primitive' }))
      .resolves.toBe(2);
    await dispatcher.prepareDirectCall({ toolName: 'primitive', toolCallId: 'direct-primitive', input: 1 });
    await expect((dispatcher.modelTools().primitive as any).execute(99, {
      toolCallId: 'direct-primitive', messages: [],
    })).resolves.toBe(2);
  });

  it('detects a preflight mutation JSON would discard and validates it again', async () => {
    const execute = mock(async () => ({ ok: true }));
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ id: z.string() }).strict(),
      execute,
    } }, {
      pluginEvents: {
        async toolCall(event) {
          event.input.transient = undefined;
          return {};
        },
      },
    });
    await expect(dispatcher.dispatch('write', { id: 'safe' }, { toolCallId: 'undefined-mutation' }))
      .rejects.toThrow(/Invalid input/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates a nested plugin edit without replaying transforms on unchanged fields', async () => {
    let transforms = 0;
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ value: z.number(), note: z.string().optional() })
        .transform(value => ({ ...value, value: value.value + (++transforms) })),
      execute: async input => input,
    } }, {
      pluginEvents: { async toolCall(event) { event.input.note = 'plugin'; return {}; } },
    });
    await expect(dispatcher.dispatch('write', { value: 1 }, { toolCallId: 'nested-preserve-transform' }))
      .resolves.toEqual({ value: 2, note: 'plugin' });
    expect(transforms).toBe(1);
  });

  it('tracks direct preflight mutation by call ID across a replacement input object', async () => {
    const execute = mock(async () => ({ ok: true }));
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ id: z.string() }),
      execute,
    } }, {
      pluginEvents: {
        async toolCall(event) {
          event.input.id = 42;
          return {};
        },
      },
    });
    const approvedInput = { id: 'safe' } as Record<string, unknown>;
    await expect(dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'replaced-direct-input', input: approvedInput }))
      .rejects.toThrow(/Invalid input/i);

    await expect((dispatcher.modelTools().write as any).execute({ ...approvedInput }, {
      toolCallId: 'replaced-direct-input',
      messages: [],
    })).rejects.toThrow(/Invalid input/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('queues duplicate direct preflights by call ID in execution order', async () => {
    let preflights = 0;
    let transforms = 0;
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ id: z.string() })
        .transform(value => ({ ...value, id: `${value.id}:${++transforms}` })),
      execute: async input => input,
    } }, {
      pluginEvents: {
        async toolCall(event) {
          if (++preflights === 1) event.input.extra = undefined;
          return {};
        },
      },
    });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'duplicate', input: { id: 'first' } });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'duplicate', input: { id: 'second' } });
    const direct = dispatcher.modelTools().write as any;
    await expect(direct.execute({ id: 'first' }, { toolCallId: 'duplicate', messages: [] }))
      .resolves.toEqual({ id: 'first:1' });
    await expect(direct.execute({ id: 'second' }, { toolCallId: 'duplicate', messages: [] }))
      .resolves.toEqual({ id: 'second:2' });
    expect(transforms).toBe(2);
  });

  it('removes the latest non-executing duplicate preflight without shifting an earlier call', async () => {
    let preflights = 0;
    let transforms = 0;
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ id: z.string() })
        .transform(value => ({ ...value, id: `${value.id}:${++transforms}` })),
      execute: async input => input,
    } }, {
      pluginEvents: {
        async toolCall(event) {
          if (++preflights === 1) event.input.extra = undefined;
          return {};
        },
      },
    });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'duplicate-denied', input: { id: 'first' } });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'duplicate-denied', input: { id: 'second' } });
    dispatcher.discardPreparedDirectCall('duplicate-denied');
    await expect((dispatcher.modelTools().write as any).execute({ id: 'first' }, {
      toolCallId: 'duplicate-denied', messages: [],
    })).resolves.toEqual({ id: 'first:1' });
    expect(transforms).toBe(2);
  });

  it('does not retain denied preflight mutation state', async () => {
    let transforms = 0;
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({ id: z.string() })
        .transform(value => ({ ...value, id: `${value.id}:${++transforms}` })),
      execute: async input => input,
    } }, {
      pluginEvents: { async toolCall() { return { block: true }; } },
    });
    await expect(dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'denied', input: { id: 'first' } }))
      .rejects.toThrow(/blocked/i);
    await expect((dispatcher.modelTools().write as any).execute({ id: 'second' }, {
      toolCallId: 'denied', messages: [],
    })).resolves.toEqual({ id: 'second:1' });
    expect(transforms).toBe(1);
  });

  it('preserves direct normalized fields while validating a plugin edit', async () => {
    let transforms = 0;
    const inputSchema = z.object({ value: z.number(), note: z.string().optional() })
      .transform(value => ({ ...value, value: value.value + (++transforms) }));
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema,
      execute: async input => input,
    } }, {
      pluginEvents: { async toolCall(event) { event.input.note = 'plugin'; return {}; } },
    });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'direct-preserve-transform', input: { value: 1 } });
    await expect((dispatcher.modelTools().write as any).execute({ value: 999 }, {
      toolCallId: 'direct-preserve-transform', messages: [],
    })).resolves.toEqual({ value: 2, note: 'plugin' });
    expect(transforms).toBe(1);
  });

  it('consumes direct preflight state before an early trusted-schema failure', async () => {
    let transforms = 0;
    const tool: any = trustedOutputTool({
      inputSchema: z.object({ id: z.string() })
        .transform(value => ({ ...value, id: `${value.id}:${++transforms}` })),
      outputSchema: aiSdk.jsonSchema(Promise.reject(new Error('broken schema')) as any),
      execute: async input => input,
    });
    const dispatcher = new ToolDispatcher({ write: tool }, {
      pluginEvents: { async toolCall(event) { event.input.extra = undefined; return {}; } },
    });
    await dispatcher.prepareDirectCall({ toolName: 'write', toolCallId: 'early-failure', input: { id: 'first' } });
    await expect((dispatcher.modelTools().write as any).execute({ id: 'first' }, {
      toolCallId: 'early-failure', messages: [],
    })).rejects.toThrow('broken schema');
    tool.outputSchema = z.object({ id: z.string() });
    await expect((dispatcher.modelTools().write as any).execute({ id: 'second' }, {
      toolCallId: 'early-failure', messages: [],
    })).resolves.toEqual({ id: 'second:2' });
    expect(transforms).toBe(2);
  });

  it('preserves AI SDK messages and experimental context for direct calls', async () => {
    const execute = mock(async (_input: unknown, options: any) => options);
    const dispatcher = new ToolDispatcher({ contextual: {
      inputSchema: z.object({}),
      execute,
    } });
    const options = {
      toolCallId: 'contextual-call',
      messages: [{ role: 'user' as const, content: 'hello' }],
      experimental_context: { tenant: 'acme' },
    };
    const output = await (dispatcher.modelTools().contextual as any).execute({}, options);
    expect(output.messages).toEqual(options.messages);
    expect(output.experimental_context).toEqual({ tenant: 'acme' });
    expect(output.toolCallId).toBe('contextual-call');
  });

  it('returns the schema-normalized trusted output', async () => {
    const dispatcher = new ToolDispatcher({ coerce: trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: z.object({ count: z.coerce.number() }),
      execute: async () => ({ count: '1' }),
    }) });
    await expect(dispatcher.dispatch('coerce', {}, { toolCallId: 'coerce' }))
      .resolves.toEqual({ count: 1 });
  });

  it('marks a completed effect when output validation is cancelled', async () => {
    const execute = mock(async () => ({ ok: true }));
    const never = new Promise<never>(() => {});
    const controller = new AbortController();
    const dispatcher = new ToolDispatcher({ value: trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: aiSdk.jsonSchema({}, { validate: async () => await never }),
      execute,
    }) });
    setTimeout(() => controller.abort(new Error('output deadline')), 5);
    await expect(dispatcher.dispatch('value', {}, {
      toolCallId: 'cancel-output', abortSignal: controller.signal,
    })).rejects.toMatchObject({
      name: 'ToolDispatchPostEffectError',
      cause: expect.objectContaining({ message: 'output deadline' }),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not retain a large plugin-marked error result after an effect completes', async () => {
    const rawPayload = `data:application/octet-stream;base64,${'A'.repeat(32_000)}`;
    const dispatcher = new ToolDispatcher({ write: {
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    } }, {
      pluginEvents: {
        async toolResult(event) {
          return { ...event, output: { rawPayload }, isError: true };
        },
      },
    });

    const error = await dispatcher.dispatch('write', {}, { toolCallId: 'large-plugin-error' })
      .then(() => undefined, error => error) as Error & { output: unknown; cause: Error };
    expect(error).toMatchObject({
      name: 'ToolDispatchPostEffectError',
      output: '[tool output omitted after post-effect failure]',
      cause: { name: 'ToolDispatchPostEffectCauseError' },
    });
    expect(error.message).not.toContain(rawPayload);
    expect(error.cause.message).not.toContain(rawPayload);
    expect(JSON.stringify(error.cause)).not.toContain(rawPayload);
    expect(JSON.stringify(error.output)).not.toContain(rawPayload);
  });

  it('revalidates a prevalidated result replaced by a result hook', async () => {
    const schema = z.object({ value: z.number() });
    const tool = trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: schema,
      execute: async (_input: unknown, options: unknown) => {
        if (!isToolDispatchExecution(options)) throw new Error('expected dispatcher execution');
        return prevalidatedTrustedOutput({ value: 1 }, { value: 1 }, schema);
      },
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: {
        async toolResult(event) { return { ...event, output: { value: 'invalid' }, isError: false }; },
      },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'replace-prevalidated' }))
      .rejects.toThrow(/output schema/i);
  });

  it('passes raw prevalidated output to hooks and keeps cached normalization only for a no-op hook', async () => {
    const schema = z.object({ value: z.coerce.number() });
    const tool = trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: schema,
      execute: async () => prevalidatedTrustedOutput({ value: '1' }, { value: 1 }, schema),
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: {
        async toolResult(event) {
          expect(event.output).toEqual({ value: '1' });
          return event;
        },
      },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'raw-prevalidated' }))
      .resolves.toEqual({ value: 1 });
  });

  it('keeps cached normalization for an ordinary transformed array through a no-op hook', async () => {
    let transforms = 0;
    const schema = z.array(z.number()).transform(values => values.map(value => value + (++transforms)));
    const tool = trustedOutputTool({
      inputSchema: z.object({}), outputSchema: schema,
      execute: async () => prevalidatedTrustedOutput([1], [2], schema),
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: { async toolResult(event) { return event; } },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'array-noop' })).resolves.toEqual([2]);
    expect(transforms).toBe(0);
  });

  it('revalidates a prevalidated result hook that mutates its output in place', async () => {
    const schema = z.object({ value: z.number() });
    const tool = trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: schema,
      execute: async () => prevalidatedTrustedOutput({ value: 1 }, { value: 1 }, schema),
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: {
        async toolResult(event) {
          (event.output as { value: unknown }).value = 'invalid';
          return event;
        },
      },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'mutate-prevalidated' }))
      .rejects.toThrow(/output schema/i);
  });

  it('revalidates a prevalidated result when a hook changes 0 to negative zero', async () => {
    const schema = z.object({ value: z.number() }).transform(value => ({ negative: Object.is(value.value, -0) }));
    const tool = trustedOutputTool({
      inputSchema: z.object({}), outputSchema: schema,
      execute: async () => prevalidatedTrustedOutput({ value: 0 }, { negative: false }, schema),
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: { async toolResult(event) { (event.output as any).value = -0; return event; } },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'negative-zero' })).resolves.toEqual({ negative: true });
  });

  it('revalidates a prevalidated result when a hook adds a hidden property', async () => {
    const schema = z.any().refine(value => !Object.prototype.hasOwnProperty.call(value as object, 'hidden'));
    const tool = trustedOutputTool({
      inputSchema: z.object({}), outputSchema: schema,
      execute: async () => prevalidatedTrustedOutput({ value: 1 }, { value: 1 }, schema),
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: { async toolResult(event) {
        Object.defineProperty(event.output, 'hidden', { value: 'invalid', enumerable: false });
        return event;
      } },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'hidden-prevalidated' }))
      .rejects.toThrow(/output schema/i);
  });

  it('revalidates a prevalidated result when a hook changes a property descriptor', async () => {
    const schema = z.any().refine(value => Object.getOwnPropertyDescriptor(value as object, 'value')?.writable === true);
    const raw = { value: 1 };
    const tool = trustedOutputTool({
      inputSchema: z.object({}), outputSchema: schema,
      execute: async () => prevalidatedTrustedOutput(raw, raw, schema),
    });
    const dispatcher = new ToolDispatcher({ value: tool }, {
      pluginEvents: { async toolResult(event) {
        Object.defineProperty(event.output, 'value', { value: 1, writable: false, enumerable: true, configurable: true });
        return event;
      } },
    });
    await expect(dispatcher.dispatch('value', {}, { toolCallId: 'descriptor-prevalidated' }))
      .rejects.toThrow(/output schema/i);
  });

  it('rejects a selected overload without a runtime validator before execution', async () => {
    const execute = mock(async () => ({ ok: true }));
    const dispatcher = new ToolDispatcher({ write: trustedOutputTool({
      inputSchema: z.object({ mode: z.literal('raw') }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    }, {
      overloads: [{
        inputSchema: z.object({ mode: z.literal('raw') }),
        outputSchema: aiSdk.jsonSchema({ type: 'object' }),
      }],
    }) });
    await expect(dispatcher.dispatch('write', { mode: 'raw' }, { toolCallId: 'raw-overload' }))
      .rejects.toThrow(/overload.*runtime validator/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('abandons a deferred trusted schema when the caller is cancelled', async () => {
    const execute = mock(async () => ({ ok: true }));
    const controller = new AbortController();
    const never = new Promise<never>(() => {});
    const dispatcher = new ToolDispatcher({ deferred: trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: aiSdk.jsonSchema(never as any),
      execute,
    }) });
    setTimeout(() => controller.abort(new Error('schema deadline')), 5);
    await expect(dispatcher.dispatch('deferred', {}, {
      toolCallId: 'deferred-schema', abortSignal: controller.signal,
    })).rejects.toThrow('schema deadline');
    expect(execute).not.toHaveBeenCalled();
  });

  it('abandons delayed post-plugin input validation with the caller abort reason', async () => {
    const execute = mock(async () => ({ ok: true }));
    const never = new Promise<never>(() => {});
    const controller = new AbortController();
    const schema = aiSdk.jsonSchema({}, { validate: async () => await never });
    const dispatcher = new ToolDispatcher({ write: { inputSchema: schema, execute } }, {
      pluginEvents: { async toolCall(event) { event.input.changed = true; return {}; } },
    });
    setTimeout(() => controller.abort(new Error('post-plugin deadline')), 5);
    await expect(dispatcher.prepareDirectCall({
      toolName: 'write', toolCallId: 'abort-post-plugin', input: {}, abortSignal: controller.signal,
    })).rejects.toThrow('post-plugin deadline');
    expect(execute).not.toHaveBeenCalled();
  });

  it('abandons delayed overload-input validation with the caller abort reason', async () => {
    const execute = mock(async () => ({ ok: true }));
    const never = new Promise<never>(() => {});
    const controller = new AbortController();
    const dispatcher = new ToolDispatcher({ write: trustedOutputTool({
      inputSchema: z.object({ mode: z.literal('slow') }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    }, {
      overloads: [{
        inputSchema: aiSdk.jsonSchema({}, { validate: async () => await never }),
        outputSchema: z.object({ ok: z.boolean() }),
      }],
    }) });
    setTimeout(() => controller.abort(new Error('overload deadline')), 5);
    await expect(dispatcher.dispatch('write', { mode: 'slow' }, {
      toolCallId: 'abort-overload', abortSignal: controller.signal,
    })).rejects.toThrow('overload deadline');
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates overloads against raw output and returns full-schema normalization', async () => {
    const fullOutput = z.object({ kind: z.literal('count'), total: z.number() })
      .transform(value => ({ ...value, total: value.total + 1 }));
    const overloadOutput = z.object({ kind: z.literal('count'), total: z.number() })
      .transform(value => ({ ...value, total: value.total + 100 }));
    const dispatcher = new ToolDispatcher({ list: trustedOutputTool({
      inputSchema: z.object({ countOnly: z.boolean() }),
      outputSchema: z.union([fullOutput, z.object({ kind: z.literal('rows') })]),
      execute: async () => ({ kind: 'count' as const, total: 1 }),
    }, {
      overloads: [{ inputSchema: z.object({ countOnly: z.literal(true) }), outputSchema: overloadOutput }],
    }) });
    await expect(dispatcher.dispatch('list', { countOnly: true }, { toolCallId: 'one-transform' }))
      .resolves.toEqual({ kind: 'count', total: 2 });
  });

  it('enforces the full trusted output contract even when an overload is broader', async () => {
    const dispatcher = new ToolDispatcher({ value: trustedOutputTool({
      inputSchema: z.object({ mode: z.literal('any') }),
      outputSchema: z.object({ value: z.number() }),
      execute: async () => ({ value: 'invalid' }),
    }, {
      overloads: [{ inputSchema: z.object({ mode: z.literal('any') }), outputSchema: z.any() }],
    }) });
    await expect(dispatcher.dispatch('value', { mode: 'any' }, { toolCallId: 'broad-overload' }))
      .rejects.toThrow(/output schema/i);
  });

  it('enforces the overload selected by the post-preflight input', async () => {
    const rows = z.object({ kind: z.literal('rows'), items: z.array(z.string()) });
    const count = z.object({ kind: z.literal('count'), total: z.number() });
    const execute = mock(async () => ({ kind: 'rows' as const, items: [] }));
    const tool = trustedOutputTool({
      inputSchema: z.object({ countOnly: z.boolean().optional() }),
      outputSchema: z.union([rows, count]),
      execute,
    }, {
      overloads: [
        { inputSchema: z.object({ countOnly: z.literal(true) }), outputSchema: count },
        { inputSchema: z.object({ countOnly: z.literal(false).optional() }), outputSchema: rows },
      ],
    });
    const events: Array<Record<string, unknown>> = [];
    const dispatcher = new ToolDispatcher({ list: tool }, {
      effectWal: { append: (event: Record<string, unknown>) => events.push(event) } as any,
      pluginEvents: {
        async toolCall(event) {
          event.input.countOnly = true;
          return {};
        },
      },
    });
    await expect(dispatcher.dispatch('list', { countOnly: false }, { toolCallId: 'overload' }))
      .rejects.toThrow(/output selected by its input/i);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'tool-contract-error', callId: 'overload', tool: 'list',
    }));
  });
});

describe('synchronous Code Mode contract index', () => {
  it('observes rejecting deferred schemas instead of leaking an unhandled rejection', async () => {
    const deferred = Promise.reject(new Error('deferred schema rejected'));
    const contracts = buildCodeModeToolContractsSync({ deferred: {
      inputSchema: aiSdk.jsonSchema(deferred as any),
      execute: async () => null,
    } }, ['deferred']);
    expect(contracts[0].input).toBe('unknown');
    // Give the rejection observer attached by the synchronous builder a turn.
    await Promise.resolve();
  });

  it('does not emit overloads that lack runtime validators', () => {
    const contracts = buildCodeModeToolContractsSync({ raw: trustedOutputTool({
      inputSchema: z.object({ mode: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    }, {
      overloads: [{
        inputSchema: { type: 'object', properties: { mode: { const: 'x' } } } as any,
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } } as any,
      }],
    }) }, ['raw']);
    expect(contracts[0].overloads).toBeUndefined();
  });
});

describe('direct reusable results', () => {
  it('returns a larger results query inline without creating another handle', async () => {
    const previousInline = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    const previousQuery = process.env.AGENTUSE_RESULT_QUERY_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '512';
    process.env.AGENTUSE_RESULT_QUERY_BYTES = '2048';
    const output = { values: ['x'.repeat(1_000)], truncated: false };
    const writeReusableResult = mock(async () => {
      throw new Error('results queries must not create recursive handles');
    });
    const dispatcher = new ToolDispatcher({
      results: { inputSchema: z.object({}), execute: async () => output },
    }, { writeReusableResult });

    try {
      await expect(dispatcher.dispatch('results', {}, {
        toolCallId: 'direct-result-query',
        origin: 'direct',
        modelFacing: true,
      })).resolves.toEqual(output);
      expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeGreaterThan(512);
      expect(writeReusableResult).not.toHaveBeenCalled();
    } finally {
      if (previousInline === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previousInline;
      if (previousQuery === undefined) delete process.env.AGENTUSE_RESULT_QUERY_BYTES;
      else process.env.AGENTUSE_RESULT_QUERY_BYTES = previousQuery;
    }
  });

  it('returns a compact handle for output above the inline limit', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '512';
    const fullOutput = { items: Array.from({ length: 20 }, (_, index) => ({ id: index, text: 'x'.repeat(20) })) };
    const writeReusableResult = mock(async () => ({
      resultId: 'result_01J00000000000000000000000_01J00000000000000000000001',
      tool: 'load',
      inputHash: 'abc123',
      inputPreview: '{"scope":"all"}',
      bytes: JSON.stringify(fullOutput).length,
      kind: 'json' as const,
      capabilities: { read: false, grep: false, jq: true },
      completedAt: Date.now(),
    }));
    const dispatcher = new ToolDispatcher({
      load: {
        inputSchema: z.object({ scope: z.string() }),
        execute: async () => fullOutput,
      },
    }, { writeReusableResult });

    try {
      const result = await dispatcher.dispatch('load', { scope: 'all' }, {
        toolCallId: 'direct-large',
        origin: 'direct',
        modelFacing: true,
      }) as Record<string, unknown>;

      expect(writeReusableResult).toHaveBeenCalledTimes(1);
      expect(writeReusableResult.mock.calls[0]?.slice(0, 3)).toEqual([
        'load',
        { scope: 'all' },
        fullOutput,
      ]);
      expect(result).toMatchObject({
        resultId: 'result_01J00000000000000000000000_01J00000000000000000000001',
        kind: 'json',
        truncated: true,
        capabilities: { read: true, grep: false, jq: true },
      });
      expect(result).not.toHaveProperty('hint');
      expect(result.preview).toEqual({
        items: [{ id: 0, text: 'x'.repeat(20) }],
      });
      expect(result.omitted).toEqual({ '.items': '19 items' });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(512);
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });

  it('does not create a reusable handle from an incomplete captured result', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '512';
    const output = {
      output: 'x'.repeat(2_000),
      metadata: {
        truncated: true,
        fullOutputArtifact: {
          kind: 'tool-output',
          path: 'session/message/artifact/tool-output-tools-bash.txt',
          bytes: 4_000,
          originalChars: 3_000,
        },
      },
    };
    const writeReusableResult = mock(async () => {
      throw new Error('an incomplete capture must not receive a result ID');
    });
    const writeToolOutputArtifact = mock(async () => {
      throw new Error('the complete artifact already exists');
    });
    const dispatcher = new ToolDispatcher({
      tools__bash: { inputSchema: z.object({}), execute: async () => output },
    }, { writeReusableResult, writeToolOutputArtifact });

    try {
      const result = await dispatcher.dispatch('tools__bash', {}, {
        toolCallId: 'direct-incomplete-capture',
        origin: 'direct',
        modelFacing: true,
      }) as any;

      expect(writeReusableResult).not.toHaveBeenCalled();
      expect(writeToolOutputArtifact).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('resultId');
      expect(result.metadata).toMatchObject({
        truncated: true,
        fullOutputArtifact: { path: 'session/message/artifact/tool-output-tools-bash.txt' },
      });
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });

  it('uses the available inline budget for the beginning of a text result', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '512';
    const fullOutput = `first-line\n${'x'.repeat(1_000)}\nlast-line`;
    const writeReusableResult = mock(async () => ({
      resultId: 'result_01J00000000000000000000000_01J00000000000000000000001',
      tool: 'load',
      inputHash: 'abc123',
      inputPreview: '{}',
      bytes: Buffer.byteLength(JSON.stringify(fullOutput), 'utf8'),
      kind: 'text' as const,
      capabilities: { read: false, grep: true, jq: false },
      completedAt: Date.now(),
    }));
    const dispatcher = new ToolDispatcher({
      load: { inputSchema: z.object({}), execute: async () => fullOutput },
    }, { writeReusableResult });

    try {
      const result = await dispatcher.dispatch('load', {}, {
        toolCallId: 'direct-large-text',
        origin: 'direct',
        modelFacing: true,
      }) as Record<string, unknown>;

      expect(result.truncated).toBe(true);
      expect(result.preview).toBeTypeOf('string');
      expect(result.preview as string).toStartWith('first-line\n');
      expect(result.preview as string).toEndWith('…');
      expect(result.preview as string).not.toContain('last-line');
      expect((result.preview as string).length).toBeGreaterThan(200);
      expect(result.omitted).toEqual({
        '.': `${Buffer.byteLength(fullOutput, 'utf8') - Buffer.byteLength((result.preview as string).slice(0, -1), 'utf8')} bytes`,
      });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(512);
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });

  it('keeps output at the inline limit unchanged', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    const output = '1234567890';
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = String(Buffer.byteLength(JSON.stringify(output), 'utf8'));
    const writeReusableResult = mock(async () => undefined);
    const dispatcher = new ToolDispatcher({
      load: { inputSchema: z.object({}), execute: async () => output },
    }, { writeReusableResult });

    try {
      await expect(dispatcher.dispatch('load', {}, {
        toolCallId: 'direct-boundary',
        origin: 'direct',
        modelFacing: true,
      })).resolves.toBe(output);
      expect(writeReusableResult).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });

  it('leaves provider-native output on its direct delivery path', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '64';
    const fullOutput = { content: 'x'.repeat(1_000) };
    const writeReusableResult = mock(async () => undefined);
    const dispatcher = new ToolDispatcher({
      image: {
        inputSchema: z.object({}),
        execute: async () => fullOutput,
        toModelOutput: () => ({ type: 'content', value: [] }),
      } as any,
    }, { writeReusableResult });

    try {
      await expect(dispatcher.dispatch('image', {}, {
        toolCallId: 'direct-native',
        origin: 'direct',
        modelFacing: true,
      })).resolves.toBe(fullOutput);
      expect(writeReusableResult).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });

  it('guides structured output text to a bounded grep', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '7168';
    const fullOutput = {
      output: `header\n${'x'.repeat(8_000)}\nTotal cost: $1.14`,
      metadata: { exitCode: 0 },
    };
    const writeReusableResult = mock(async () => ({
      resultId: 'result_01J00000000000000000000000_01J00000000000000000000001',
      tool: 'tools__bash',
      inputHash: 'abc123',
      inputPreview: '{"command":"check-cost"}',
      bytes: JSON.stringify(fullOutput).length,
      kind: 'json' as const,
      capabilities: { read: false, grep: true, jq: true },
      completedAt: Date.now(),
    }));
    const dispatcher = new ToolDispatcher({
      tools__bash: { inputSchema: z.object({ command: z.string() }), execute: async () => fullOutput },
    }, { writeReusableResult });

    try {
      const result = await dispatcher.dispatch('tools__bash', { command: 'check-cost' }, {
        toolCallId: 'direct-output-wrapper',
        origin: 'direct',
        modelFacing: true,
      }) as Record<string, unknown>;
      expect(result.capabilities).toEqual({ read: true, grep: true, jq: true });
      expect(result).not.toHaveProperty('hint');
      expect(result.preview).toMatchObject({
        metadata: {
          exitCode: 0,
        },
      });
      const outputHead = (result.preview as any).output as string;
      expect(outputHead).toStartWith('header\n');
      expect(outputHead).not.toContain('Total cost: $1.14');
      expect(outputHead.length).toBeGreaterThan(6_000);
      expect(result.omitted).toEqual({
        '.output': `${Buffer.byteLength(fullOutput.output, 'utf8') - Buffer.byteLength(outputHead.slice(0, -1), 'utf8')} bytes`,
      });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(7_168);
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });
});
