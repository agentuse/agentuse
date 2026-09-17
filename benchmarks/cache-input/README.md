# Cached-input diagnostics

These agents isolate timing, parallel completion order, and tool-result volume
while keeping the model, reasoning level, tools, and prompt surface stable.

Run from the AgentUse repository root:

```bash
agentuse run benchmarks/cache-input/cache-timing.agentuse --no-tty
agentuse run benchmarks/cache-input/cache-parallel.agentuse --no-code-mode --no-tty
agentuse run benchmarks/cache-input/cache-volume.agentuse --no-tty
```

The parallel probe disables Code Mode so the four commands reach the provider
as sibling tool calls instead of one composed `code_exec` call.

Inspect a run without loading its tool payloads. Either the full session ID or
the unique short ID printed by `agentuse sessions list` is accepted:

```bash
node benchmarks/cache-input/analyze-session.mjs <session-id>
```

Interpretation:

- `prefix: true` proves the prior serialized request remained an exact prefix.
- `cached: 0` with `prefix: true` is a provider cache miss, not local reordering.
- Hits only after delayed calls suggest asynchronous cache materialization.
- Misses beginning only after larger results implicate provider cache limits or
  cacheability rules for tool history.
- A changed prefix in the parallel probe indicates a local ordering defect.

The analyzer also reports cumulative input, cached input, uncached input, and
output. For fixture calls it prints both call order and completion order, which
makes the parallel probe's deliberately out-of-order completion explicit.

## Persisted response metadata

Every completed model step now has a `step-finish` session part containing
`modelStepUsage`, including text-only turns. Tool parts retain the same usage
under `state.metadata.modelStepUsage` for existing session-log consumers.
The analyzer prefers the step records so parallel tool calls are counted once;
older sessions continue to work through the tool-part fallback.

`modelStepUsage.responseMetadata` stores only returned response ID, model,
service tier, input/cache-read/cache-write counts, and cache diagnostic type and
reason when available. Absent fields stay absent; an explicit zero stays zero.
Ordinary uncached input is derived for OpenAI only when total input, cache reads,
and cache writes are all known. The existing `uncachedInput` total means input
minus cache reads and can include cache writes. Unknown totals print as `null`.

Collection is always on for completed model responses. It does not request
additional diagnostics, add cache breakpoints, or change cache options. Raw
stream events are inspected transiently through the SDK; raw response bodies,
headers, and model output are not copied into the metadata records. The metadata
is also exposed in structured session-log details; the analyzer displays it.

## Direct Codex backend probes

Run the bounded synthetic probes using the existing AgentUse Codex OAuth login:

```bash
bun benchmarks/cache-input/probe-backend.ts capabilities /tmp/cache-capabilities.json
bun benchmarks/cache-input/probe-backend.ts retention /tmp/cache-retention.json
bun benchmarks/cache-input/probe-backend.ts reuse /tmp/cache-reuse.json
```

These make real model requests. `capabilities` checks the documented mode, TTL,
comparison ID, and user/tool-result breakpoint fields, including an invalid-mode
control. `retention` checks default and legacy retention values. `reuse` sends
36 requests in two rounds with reversed arm order: identical repeated requests,
append-only synthetic function-call history, and that history with a stable
cache key. Each arm starts with a unique instruction prefix. Requests start at
least 4.5 seconds apart to keep this probe below 15 requests/minute; other
account traffic is not controlled. No tool is executed, and generated replies
are not appended: the history is deterministic fixture data, not a full agent
behavior benchmark.

Results contain request fingerprints, response IDs, allowlisted usage and
cache diagnostics, and status/error information. They exclude credentials,
account IDs, prompt bodies, and model output. Each request has a 60-second
transport timeout. Production configuration and SDK versions are unchanged.
