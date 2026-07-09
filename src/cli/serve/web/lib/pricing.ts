import { getModelFromRegistry } from '../../../../generated/models';
import type { SessionTokenUsage } from '../../types';

/**
 * Client-side spend estimate from the generated models.dev registry. Registry
 * `cost` values are USD per MILLION tokens (models.dev convention; e.g. Haiku
 * 4.5 is input: 1, output: 5) despite the generated file's per-token comment.
 * Cached input reads are billed at roughly a tenth of the input rate across
 * providers; the registry doesn't carry a cache rate, so this uses input/10
 * and the UI labels the figure as an estimate. Returns undefined for models
 * missing from the registry rather than guessing a rate.
 */
export function estimateSessionCostUsd(
  model: string | undefined,
  usage: Pick<SessionTokenUsage, 'input' | 'cachedInput' | 'output'> | undefined
): number | undefined {
  if (!model || !usage) return undefined;
  const info = getModelFromRegistry(model);
  if (!info) return undefined;
  const cached = Math.max(0, usage.cachedInput);
  const newInput = Math.max(0, usage.input - cached);
  const output = Math.max(0, usage.output);
  if (newInput === 0 && cached === 0 && output === 0) return undefined;
  const perMillion = newInput * info.cost.input + cached * (info.cost.input / 10) + output * info.cost.output;
  return perMillion / 1_000_000;
}

export function formatUsd(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
