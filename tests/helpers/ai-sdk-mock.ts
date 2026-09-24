type AiSdkRuntimeExports = Pick<
  typeof import('ai'),
  'APICallError' | 'InvalidToolInputError' | 'RetryError' | 'StreamProviderError' | 'asSchema' | 'jsonSchema'
>;

async function validationResult(schema: any, value: unknown): Promise<unknown> {
  const parsed = typeof schema.safeParseAsync === 'function'
    ? await schema.safeParseAsync(value)
    : schema.safeParse(value);
  return parsed.success
    ? { success: true, value: parsed.data }
    : { success: false, error: parsed.error };
}

/**
 * Runtime exports pulled in transitively by the runner.
 *
 * Keep these in one typed factory so isolated tests that replace the `ai`
 * module cannot drift behind new runner imports.
 */
export function aiSdkErrorMocks(): AiSdkRuntimeExports {
  const neverMatches = { isInstance: () => false };
  const jsonSchema = ((schema: unknown, options?: { validate?: (value: unknown) => unknown }) => ({
    jsonSchema: schema,
    ...(options?.validate && { validate: options.validate }),
  })) as AiSdkRuntimeExports['jsonSchema'];
  const asSchema = ((schema: any) => {
    if (schema == null) {
      return {
        jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      };
    }
    if (schema && typeof schema === 'object' && 'jsonSchema' in schema) return schema;
    if (schema && typeof schema.safeParse === 'function') {
      return {
        // These execution tests do not assert generated JSON Schema text. They
        // still need real Zod validation semantics for dispatcher paths.
        jsonSchema: {},
        validate: async (value: unknown) => validationResult(schema, value),
      };
    }
    return { jsonSchema: schema };
  }) as AiSdkRuntimeExports['asSchema'];
  return {
    APICallError: neverMatches,
    InvalidToolInputError: neverMatches,
    RetryError: neverMatches,
    StreamProviderError: neverMatches,
    asSchema,
    jsonSchema,
  } as unknown as AiSdkRuntimeExports;
}
