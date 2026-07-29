---
name: tester
description: Test and validate AgentUse agents without real side effects. Use when verifying a new or changed .agentuse file, dry-running an agent, testing approval-gate flows unattended, mocking tool outputs, or iterating on an agent in a closed loop before letting it run for real.
---

# AgentUse Tester

Validate a `.agentuse` agent end-to-end before a real run. All mock flags
belong to `agentuse run`; a mocked session is stored and inspectable like any
other, and is visibly marked: `agentuse sessions` shows a `· mock` status
suffix, `sessions show` prints a `Mock:` line, and the JSON API carries
`mock: true`.

## Always Start With Doctor

```bash
agentuse doctor <file>   # ~1s static validation, no tokens
```

Catches frontmatter/config errors before any token-heavy run.

## Run the Test

```bash
agentuse test agent.agentuse --mock-model anthropic:claude-haiku-4-5
```

Scope is adaptive: agents declaring `tools.bash.gated` get **gated scope**
(only those commands are fabricated; reads, non-gated bash, MCP, and skills
run for REAL, so the run grounds itself in real project state); agents without
gated patterns get **full mock** (every tool result fabricated, nothing
executes). Override with `--scope gated|all`.

- `--mock-model` is required (fabrication runs on it; use the cheapest
  reachable model, e.g. `anthropic:claude-haiku-4-5`). Set `AGENTUSE_MOCK_MODEL`
  once in `~/.agentuse/.env` to omit the flag.
- Stores are isolated automatically: reads seeded from the real store, writes
  land in `<projectRoot>/.agentuse/store-mock/<run-id>/` (kept for inspection),
  and the real store, including the reserved `metrics` store, is never touched.
- Under gated scope, an agent with no `tools.bash.gated` patterns mocks
  NOTHING (warning printed): everything runs real with gates auto-approved.
- Low-level plumbing: `agentuse run --mock --mock-model <m>` is full mock with
  a REAL suspending gate, useful to verify the agent actually pauses for
  approval. Env equivalents: `AGENTUSE_MOCK_MODE`, `AGENTUSE_MOCK_SCOPE`,
  `AGENTUSE_MOCK_APPROVAL`, `AGENTUSE_MOCK_MODEL`.

## Approval Gates Under Test

`agentuse test` resolves every gate deterministically (never an LLM playing
reviewer) and needs no `agentuse serve` daemon:

```bash
agentuse test a.agentuse                      # approve (default): grants the
                                              # gated-command lease from the
                                              # gate's changes[], exactly like
                                              # a real reviewer approval; pick
                                              # gates auto-select the
                                              # recommended option -> `choice`
agentuse test a.agentuse --approval reject    # terminal reject branch (gate
                                              # seals); tests the cleanup path
agentuse test a.agentuse --approval comment:"tighten the summary"   # forces
                                              # the revise-and-re-gate branch
```

Gate enforcement stays production-faithful: a gated command issued WITHOUT an
approved gate is still denied pre-dispatch with the re-gate redirect.

## The Closed Loop

1. `agentuse doctor <file>`.
2. `agentuse test <file> --no-tty` (with `--mock-model <cheap-model>` unless
   `AGENTUSE_MOCK_MODEL` is set globally).
3. Inspect: `agentuse sessions show <session-id> --full` (or the serve UI
   `/sessions/<id>`). Judge: did the agent gate the right commands, with the
   exact verbatim commands in `changes[]`? Did the flow complete? Is the final
   output right?
4. Audit what would have executed: the session's `effect-wal.jsonl`. A
   fabricated gated command shows `mock-gate-decision` + `lease-approved` but
   NO `bash-spawn`; that absence proves it never ran.
5. Fix the agent file, rerun. Re-test the reject/comment branches when the
   agent has cleanup or revision logic.

## Caveats

- Fabricated results are always plausible successes: mock validates gating,
  flow, and prompt logic, not real command behavior. Do one supervised real
  run before trusting an agent.
- A fabricated command changes nothing on disk, so a later REAL command that
  checks its effect (`git log` after a fabricated `git push`) sees unchanged
  state; agents that verify their own effects will notice and may retry.
- Under gated scope, effectful non-bash tools (MCP writes, channel posts)
  still run for real. Stores are the exception (isolated automatically); point
  the run at a scratch copy of the project when the agent writes through MCP
  or channels.
- Mock tool outputs are non-deterministic (LLM-fabricated); approval decisions
  are deterministic. Judge outcomes, not exact transcripts.

## References

- CLI flags: https://docs.agentuse.io/reference/cli-commands.md
- Env vars (`AGENTUSE_MOCK_*`): https://docs.agentuse.io/reference/environment-variables.md
- Approval gates and leases: https://docs.agentuse.io/guides/approval-gates.md
- Session logs: https://docs.agentuse.io/guides/session-logs.md
