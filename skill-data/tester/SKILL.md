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

## Pick the Mock Mode

```bash
# Everything fabricated: no tool executes at all. Tests flow/prompt logic only.
agentuse run agent.agentuse --mock --mock-model anthropic:claude-haiku-4-5

# Closed loop (preferred for gated agents): ONLY tools.bash.gated commands are
# fabricated; reads, non-gated bash, MCP, skills, stores all run for REAL.
# Implies --mock-approval approve, so gated flows complete unattended.
agentuse run agent.agentuse --mock-gated --mock-model anthropic:claude-haiku-4-5
```

- `--mock-model` is required (fabrication runs on it; use the cheapest
  reachable model, e.g. `anthropic:claude-haiku-4-5`).
- `--mock` and `--mock-gated` are mutually exclusive.
- Under `--mock-gated`, an agent with no `tools.bash.gated` patterns mocks
  NOTHING (warning printed): everything runs real with gates auto-approved.
  Only use it on agents whose irreversible commands are actually gated.

## Approval Gates Under Mock

By default (`--mock` alone) `await_human` stays real and the run suspends, so
you can verify the agent gates at the right moment. For unattended runs,
resolve the gate deterministically (never an LLM playing reviewer):

```bash
--mock-approval            # approve (default): grants the gated-command lease
                           # from the gate's changes[], exactly like a real
                           # reviewer approval; pick gates auto-select the
                           # recommended option and return it as `choice`
--mock-approval reject     # forces the terminal reject branch (gate seals);
                           # tests the agent's cleanup path
--mock-approval comment:"tighten the summary"   # forces revise-and-re-gate
```

Mocked-approval runs need no `agentuse serve` daemon (nothing suspends).
Gate enforcement stays production-faithful: a gated command issued WITHOUT an
approved gate is still denied pre-dispatch with the re-gate redirect.

## The Closed Loop

1. `agentuse doctor <file>`.
2. `agentuse run <file> --mock-gated --mock-model <cheap-model> --no-tty`.
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
- Under `--mock-gated`, effectful non-bash tools (MCP writes, channel posts)
  still run for real. Point the run at a scratch copy of the project when the
  agent writes through those.
- Mock tool outputs are non-deterministic (LLM-fabricated); approval decisions
  are deterministic. Judge outcomes, not exact transcripts.

## References

- CLI flags: https://docs.agentuse.io/reference/cli-commands.md
- Env vars (`AGENTUSE_MOCK_*`): https://docs.agentuse.io/reference/environment-variables.md
- Approval gates and leases: https://docs.agentuse.io/guides/approval-gates.md
- Session logs: https://docs.agentuse.io/guides/session-logs.md
