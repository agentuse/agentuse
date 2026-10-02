/** Allowlisted response facts only. Never persist raw chunks, headers or output. */
export interface ResponseMetadata {
  responseId?: string;
  model?: string;
  serviceTier?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  uncachedInputTokens?: number;
  diagnosticType?: string;
  diagnosticReason?: string;
}

/**
 * `total` minus its parts, or undefined when any count is unknown or the parts
 * exceed the total. Missing counts are unknown, not zero.
 */
export function knownRemainder(total: number | undefined, ...parts: Array<number | undefined>): number | undefined {
  if (total === undefined || parts.some((part) => part === undefined)) return undefined;
  const rest = parts.reduce<number>((left, part) => left - (part as number), total);
  return rest >= 0 ? rest : undefined;
}

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export function readResponseMetadata(value: unknown): ResponseMetadata | undefined {
  const source = record(value);
  const result: Record<string, string | number> = {};
  for (const key of ['responseId', 'model', 'serviceTier', 'diagnosticType', 'diagnosticReason']) {
    if (typeof source[key] === 'string' && source[key].length > 0) result[key] = source[key];
  }
  for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'uncachedInputTokens']) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key];
  }
  return Object.keys(result).length ? result : undefined;
}

/** Read only terminal Responses events, before SDK schemas discard unknown fields. */
export function responseMetadataFromRaw(value: unknown): ResponseMetadata | undefined {
  const event = record(value);
  if (!['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) return undefined;
  const response = record(event.response);
  const usage = record(response.usage);
  const details = record(usage.input_tokens_details);
  const diagnostics = record(response.prompt_cache_diagnostics);
  const metadata = readResponseMetadata({
    responseId: response.id, model: response.model, serviceTier: response.service_tier,
    inputTokens: usage.input_tokens, cachedInputTokens: details.cached_tokens,
    cacheWriteTokens: details.cache_write_tokens,
    diagnosticType: diagnostics.type, diagnosticReason: diagnostics.reason,
  });
  const ordinary = knownRemainder(metadata?.inputTokens, metadata?.cachedInputTokens, metadata?.cacheWriteTokens);
  if (metadata && ordinary !== undefined) metadata.uncachedInputTokens = ordinary;
  return metadata;
}

export function responseMetadataFromStep(chunk: any, raw?: ResponseMetadata): ResponseMetadata | undefined {
  const provider = record(record(chunk.providerMetadata).openai);
  const usage = record(chunk.usage);
  const details = record(usage.inputTokenDetails);
  const rawUsage = record(usage.raw);
  const rawDetails = record(rawUsage.input_tokens_details);
  const hasRawOpenAIUsage = typeof rawUsage.input_tokens === 'number';
  return readResponseMetadata({
    responseId: provider.responseId ?? chunk.response?.id,
    model: chunk.response?.modelId,
    serviceTier: provider.serviceTier,
    inputTokens: usage.inputTokens,
    cachedInputTokens: hasRawOpenAIUsage ? rawDetails.cached_tokens : details.cacheReadTokens,
    cacheWriteTokens: hasRawOpenAIUsage ? rawDetails.cache_write_tokens : details.cacheWriteTokens,
    // OpenAI's SDK substitutes zero for missing cache counts. Do not propagate that inference.
    ...(!hasRawOpenAIUsage && { uncachedInputTokens: details.noCacheTokens }),
    ...raw,
  });
}
