# Cached-input diagnostic findings

Date: 2026-09-17

The probes isolate three suspected local causes of cache misses while using the
same `openai:gpt-5.6-sol` model and `high` reasoning setting as the affected
production run.

## Result

AgentUse preserved an exact serialized-request prefix throughout every tested
session. Cache hits remained intermittent even when the prefix was unchanged.
The evidence points to best-effort provider cache availability, not local
history reordering.

| Probe | Requests | Exact prefix transitions | Changed transitions | Observed cache behavior |
| --- | ---: | ---: | ---: | --- |
| Timing, cold run | 7 | 6/6 | 0 | Requests 1-6 missed; request 7 cached 9,600 tokens |
| Timing, immediate repeat | 7 | 6/6 | 0 | Requests 3-6 hit; request 7 missed despite the exact prefix |
| Parallel completion | 3 | 2/2 | 0 | Calls issued A-B-C-D and completed B-D-C-A without a prefix change |
| Result volume | 6 | 5/5 | 0 | One hit at request 3; later requests missed |
| Affected Reel session | 30 | 29/29 | 0 | Hits and zero-cache requests alternated across the run |

The affected 30-request Reel session accumulated 1,911,546 total input tokens.
Of those, 577,152 were cache reads and 1,334,394 were uncached input. All 29
request-to-request prefix comparisons remained exact.

The 24 KB and 60 KB fixture results crossed AgentUse's reusable-result
threshold and were stored outside model context. They did not enter later
requests at their raw sizes, so large inline tool payloads do not explain the
observed miss pattern.

## Conclusion

The cumulative uncached-input spike comes from full-history requests being
resent while OpenAI reports only best-effort cache hits. When a request misses,
its entire growing history is billed as uncached even though AgentUse sent the
previous request as an exact prefix with unchanged request settings.

Prompt caching should therefore be treated as an optimization, not a bound on
long-run input cost. Durable mitigation needs fewer model turns, smaller retained
history, deliberate compaction or stage boundaries, or a stateful continuation
transport. Reordering the local session history would not fix this result.

## Response metadata persistence verification

Live source run: `01M2RQKZN1K74JY71CZ08SRBMP` (2026-09-17), using the unchanged
`cache-timing.agentuse` against the Codex ChatGPT backend.

- All 7 responses persisted an ID, returned model `gpt-5.6-sol`, service tier
  `default`, and input/cache-read/cache-write counts.
- All 7 responses reported `cache_write_tokens: 0` explicitly.
- Total input: 85,860; cache reads: 25,856; ordinary uncached input: 60,004.
- Hits occurred on requests 1, 5, and 7; all 6 prefix transitions were exact.
- No cache diagnostic type or reason was returned. No diagnostic request
  options were enabled, so this does not establish support for those options.
- The updated analyzer also reproduced the earlier cold timing run's 7 requests
  and 9,600 cached tokens, with the new unavailable fields left unknown.

This verifies metadata collection and persistence, not a caching improvement.
The earlier attribution to best-effort cache availability is a hypothesis:
exact local prefixes rule out the observed local ordering issue, but cannot
identify provider breakpoint eligibility, availability, or another miss reason.
The returned model and service tier stayed constant in this run.
