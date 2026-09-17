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
