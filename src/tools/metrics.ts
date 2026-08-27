/**
 * record_metric tool: agents record business-metric facts (counts and amounts)
 * about work they just completed into the reserved shared "metrics" store.
 *
 * Design rule: the LLM decides WHAT happened; this tool records the fact
 * deterministically; aggregation/rendering is plain code downstream (the serve
 * Home page, external dashboards over /api/stores/metrics). No LLM ever sits
 * in the math path of a displayed number.
 *
 * Idempotency is the reason this exists as a tool rather than a store-write
 * convention: records are upserted keyed on (sessionId, metric), so a retried
 * or resumed run overwrites its own record instead of double-counting - which
 * is what makes money numbers trustworthy enough to display.
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { Store } from '../store/store.js';
import { normalizeMetricValues } from '../shared/metric-values.js';

/** Reserved shared store every record_metric write lands in. */
export const METRICS_STORE_NAME = 'metrics';

/** Item `type` stamped on every metric record. */
export const METRIC_ITEM_TYPE = 'metric';

export interface MetricToolContext {
  projectRoot: string;
  /**
   * Current session id: the idempotency key. Absent (e.g. bare CLI runs without
   * a session) means no dedupe is possible and each call creates a record.
   *
   * Read at execute time, not at construction: a delegated sub-agent builds its
   * tools before its child session exists and binds the id afterwards, so the
   * caller may supply this as a live getter.
   */
  sessionId?: string | undefined;
  /** Stable agent id, recorded as provenance. */
  agentId?: string | undefined;
}

const RecordMetricInput = z.object({
  metric: z.string()
    .regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case, e.g. "invoices_chased"')
    .max(64)
    .describe('Stable snake_case metric name in verb_object form, e.g. "invoices_chased", "tickets_triaged". Keep the same name across runs: it is the grouping key.'),
  value: z.number().finite().optional()
    .describe('Numeric magnitude of the work, e.g. total amount in whole currency units. Pair with "unit".'),
  unit: z.string().max(16).optional()
    .describe('Unit of "value", e.g. "usd", "minutes". A metric name should always use the same unit.'),
  count: z.number().int().nonnegative().optional()
    .describe('Number of items handled, e.g. 4 invoices.'),
  note: z.string().max(200).optional()
    .describe('Short human context shown alongside the number, e.g. "2 promised payment".'),
}).refine(
  (input) => input.value !== undefined || input.count !== undefined,
  { message: 'Provide at least one of "value" or "count" - a metric with neither is not recordable.' }
);

type RecordMetricArgs = z.infer<typeof RecordMetricInput>;

function metricTitle({ metric, value, unit, count }: RecordMetricArgs): string {
  const normalized = normalizeMetricValues({ value, unit, count });
  const parts = [metric];
  if (normalized.count !== null) parts.push(String(normalized.count));
  if (normalized.value !== null) parts.push(normalized.unit ? `${normalized.value} ${normalized.unit}` : String(normalized.value));
  return parts.join(' · ');
}

/**
 * Create the record_metric tool bound to a project's reserved metrics store.
 * The Store takes its per-op lock only inside each write, so holding the
 * instance for the run has no lock-lifecycle cost.
 */
export function createRecordMetricTool(context: MetricToolContext): Tool {
  const { projectRoot, agentId } = context;
  const store = new Store(projectRoot, METRICS_STORE_NAME, agentId);

  return {
    description:
      `Record a business-metric fact about work you just completed (a count and/or an amount), ` +
      `e.g. {metric: "invoices_chased", count: 4, value: 11200, unit: "usd"}. ` +
      `For an item count, set count only; do not duplicate it into value/unit. ` +
      `Record once per metric, at the moment the work completes. ` +
      `Recording the same metric again in this run overwrites the earlier record (safe on retries). ` +
      `Only record facts you computed from your actual inputs - never estimates.`,
    inputSchema: RecordMetricInput,
    execute: async (args: RecordMetricArgs) => {
      const { metric, value, unit, count, note } = args;
      const normalized = normalizeMetricValues({ value, unit, count });
      // Resolved per call so a session bound after tool construction still keys
      // the upsert (see MetricToolContext.sessionId).
      const sessionId = context.sessionId;
      const data: Record<string, unknown> = {
        metric,
        ...(normalized.value !== null && { value: normalized.value }),
        ...(normalized.unit !== null && { unit: normalized.unit }),
        ...(normalized.count !== null && { count: normalized.count }),
        ...(note !== undefined && { note }),
        ...(sessionId !== undefined && { sessionId }),
        ...(agentId !== undefined && { agent: agentId }),
      };
      const options = {
        type: METRIC_ITEM_TYPE,
        title: metricTitle(args),
        tags: [metric],
        data,
      };

      try {
        // sessionId is the idempotency key; without one each call creates.
        const outcome = sessionId !== undefined
          // A retry is a full replacement of the agent-supplied payload. The
          // Store's default merge remains useful elsewhere, but here it would
          // retain stale value/unit/note fields omitted by the latest fact.
          ? await store.upsertWhere({ sessionId, metric }, options, { replaceData: true })
          : { item: await store.create(options), created: true };
        return {
          success: true,
          store: METRICS_STORE_NAME,
          id: outcome.item.id,
          metric,
          recorded: outcome.created ? 'created' : 'overwrote this run\'s earlier record',
        };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
  };
}
