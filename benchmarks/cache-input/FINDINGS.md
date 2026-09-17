# Cached-input diagnostic findings

Date: 2026-09-17

The probes isolate three suspected local causes of cache misses while using the
same `openai:gpt-5.6-sol` model and `high` reasoning setting as the affected
production run.

## Result

AgentUse preserved an exact serialized-request prefix throughout every tested
session. Cache hits remained intermittent even when the prefix was unchanged.
The evidence rules out local history reordering in these runs. It does not
identify the provider-side reason for each miss.

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
its entire growing history is reported as uncached even though AgentUse sent
the previous request as an exact prefix with unchanged request settings. These
Codex subscription usage counts do not establish a separate API bill.

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

## Direct backend investigation: supported controls

Date: 2026-09-17. Endpoint: `https://chatgpt.com/backend-api/codex/responses`.
Requested and returned model: `gpt-5.6-sol`; returned service tier: `default`.
The probe bypasses AI SDK request serialization and uses AgentUse's existing
Codex OAuth login with entirely synthetic inputs.

| Probe | Observed response |
| --- | --- |
| Baseline, no cache options | HTTP 200 |
| `prompt_cache_options.mode: implicit` | HTTP 400: `Unsupported parameter: prompt_cache_options` |
| `prompt_cache_options.ttl: 30m` | Same HTTP 400 |
| `prompt_cache_options.comparison_response_id` with a fresh response ID | Same HTTP 400 |
| Combined mode, TTL, comparison ID | Same HTTP 400 |
| Explicit-only mode, no breakpoints | Same HTTP 400 |
| Invalid mode negative control | Same HTTP 400 |
| Explicit user-content breakpoint | HTTP 400: `prompt_cache_breakpoint is not supported on this model` |
| Explicit tool-result-content breakpoint | Same breakpoint HTTP 400 |
| `prompt_cache_retention: 24h` | HTTP 400: `Unsupported parameter: prompt_cache_retention` |
| `prompt_cache_retention: in_memory` | Same retention HTTP 400 |

Successful responses nevertheless return `prompt_cache_retention: 24h` and
explicit zero `cache_write_tokens`. The returned retention field does not imply
that clients can configure it. This endpoint does not expose the documented
public Responses API controls for this model/account at the time tested.

The [official caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
describes implicit/explicit mode and 30-minute TTL for GPT-5.6. The
[diagnostics guide](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)
requires `comparison_response_id` inside `prompt_cache_options`. Because that
parameter is rejected here, consecutive-response diagnostics and the proposed
explicit-breakpoint A/B cannot run on this route. `prompt_cache_diagnostics`
is an output field, not an additional request flag.

## Direct backend investigation: repeat and append-only reuse

Two rounds, six requests per arm per round, with arm order reversed in round 2.
Every arm starts with an independent random instruction prefix. The probe sends
at most one request every 4.5 seconds. Other account traffic and server routing
are not controlled. All 36 requests completed successfully.

| Arm | Requests | Requests with cache reads | Input tokens | Cached tokens | Token cache-hit rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Identical full request repeated | 12 | 1 | 34,572 | 2,816 | 8.1% |
| Append-only synthetic tool history, no key | 12 | 2 | 45,342 | 5,376 | 11.9% |
| Append-only synthetic tool history, stable key | 12 | 1 | 45,354 | 2,688 | 5.9% |

All 30 within-arm transitions preserved the exact prior prefix. Every response
returned `gpt-5.6-sol`, service tier `default`, and zero cache-write tokens.
No diagnostic type or reason was returned. These are synthetic low-output
requests, not representative estimates of production cache-hit rates. The small
sample and uncontrolled provider routing do not establish a causal key effect.

A particularly useful reproduction is round 1's repeated request: request 4
cached 2,816 tokens, then request 5 cached zero despite an identical entire
request hash (`3a5c7ed5401250f132235ab032830ad5904b8d610250a0da54451510616f81f2`).
The response IDs are:

- Hit: `resp_08a087481ff2a278016aac6b033e3487d0ad1dd9ed0a232da9`
- Miss: `resp_048f4e920ee30392016aac6b07de4487d0bcac7d78f4935304`

This reproduces intermittent reuse directly on the authenticated backend without
AgentUse history assembly or AI SDK request serialization. It rules out those
local components as necessary causes of this minimal reproduction. It cannot
identify which internal routing, cache availability, rendered hidden context,
or accounting behavior caused the miss; the comparison API is unavailable.

## Decision after these tests

Do not change production cache defaults or add breakpoints on this route:
the backend rejects those fields. Upgrading the AI SDK may be worthwhile for
other fixes, but cannot make a server accept the same rejected parameters.
The proposed mode/breakpoint A/B is blocked by measured backend incompatibility,
not by AgentUse's parser or SDK version. A newer public API feature should not
be assumed available through the Codex ChatGPT endpoint.

Keep the metadata instrumentation. The next useful escalation is to provide the
identical-request hit/miss pair to the backend provider for investigation, or
separately test the public Responses API if that route is desired and available.
No provider support message was sent. No public API billing or credentials were
used, no dependencies were upgraded, and no production cache settings changed.

Reproduction: `probe-backend.ts`. Sanitized results for all 48 compatibility and
reuse requests: `backend-evidence-2026-09-17.json`. The probe type-checks with the
repository's TypeScript installation and was executed against real OpenAI
responses; no mocked cache behavior was used.
