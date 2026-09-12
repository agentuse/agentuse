---
name: tester
description: Test and validate AgentUse agents without real side effects. Use when verifying a new or changed .agentuse file, dry-running an agent, testing approval-gate flows unattended, mocking tool outputs, or iterating on an agent in a closed loop before letting it run for real.
---

# AgentUse Tester

Use `test workflow` to check steps or `test result` to compare a deliverable.
Test sessions are stored and inspectable like any other, and is visibly marked: `agentuse sessions` shows a `· mock` status
suffix, `sessions show` prints a `Mock:` line, and the JSON API carries
`mock: true`.

## Always Start With Doctor

```bash
agentuse doctor <file>   # ~1s static validation, no tokens
```

Catches frontmatter/config errors before any token-heavy run.

## Choose Workflow or Result

- `agentuse test workflow <file>` checks steps and approval branches with
  simulated tool responses. Completion alone is not a quality verdict.
- `agentuse test result <file> --session <id>` generates a fresh deliverable from
  a past real job's evidence, using current instructions and explicit read-only
  reference files. No workflow tools, Code Mode, approvals or publishing run.
  The first model-selected evidence pack is saved and reused on later tests.
  Inspect the selection audit: exact excerpts prevent fabrication but do not
  guarantee the selector chose the right evidence. Old drafts and feedback are
  withheld from the writer and judge.
- Result options: `--selector-model <model>` selects the extractor on first use
  (default: agent model); `--judge <local-agent>` evaluates the new result against
  criteria without tools; `--model` overrides the writer; `--json` gives a report.
  `generated` is not passed. `passed` is not proof of improvement. `failed`,
  `incomplete`, and `error` exit 1. Reports link evidence and reference hashes.
- Result sources need supported recorded tool evidence and must have finished
  or reached approval. These test sessions cannot resume as live runs.
- Advanced compatibility: `agentuse test <file> --replay <id>` strictly matches
  recorded tool calls and stops on missing input. Use it to debug tool behavior,
  not as the default result-improvement workflow.

## Run the Test

```bash
agentuse test workflow agent.agentuse --mock-model anthropic:claude-haiku-4-5
```

`test workflow` defaults to full mock. Explicit `--scope gated` fabricates only
matching gated bash commands; other tools run live. Legacy `test <file>` retains
adaptive scope (gated when the agent declares gated bash, otherwise all).

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

To evaluate Code Mode itself, keep the agent file unchanged and compare the
same fixture twice: default-on, then `--no-code-mode`. The switch applies to
the full run tree. Reset or clone mutable store fixtures between arms, and
compare completion, model turns, tokens, tool calls, duration, duplicate
claims, final store state, and session trace readability. Use
`AGENTUSE_CODE_MODE=0` when the test harness launches AgentUse indirectly.

## Approval Gates Under Test

`agentuse test workflow` resolves every gate deterministically (never an LLM playing
reviewer) and needs no `agentuse serve` daemon:

```bash
agentuse test workflow a.agentuse                      # approve (default): grants the
                                              # gated-command lease from the
                                              # gate's changes[], exactly like
                                              # a real reviewer approval; pick
                                              # gates auto-select the
                                              # recommended option -> `choice`
agentuse test workflow a.agentuse --approval reject    # terminal reject branch (gate
                                              # seals); tests the cleanup path
agentuse test workflow a.agentuse --approval comment:"tighten the summary"   # forces
                                              # the revise-and-re-gate branch
                                              # on gate 1, then approves the
                                              # re-gate so the run finishes
```

Gate enforcement stays production-faithful: a gated command issued WITHOUT an
approved gate is still denied pre-dispatch with the re-gate redirect.

## The Closed Loop

1. `agentuse doctor <file>`.
2. `agentuse test workflow <file> --no-tty` (with `--mock-model <cheap-model>` unless
   `AGENTUSE_MOCK_MODEL` is set globally).
3. Inspect: `agentuse sessions show <session-id> --full` (or the serve UI
   `/sessions/<id>`). Judge: did the agent gate the right commands, with the
   exact verbatim commands in `changes[]`? Did the flow complete? Is the final
   output right? Note: mock runs are hidden from the serve dashboards and
   sessions list by default (and never push-notify); use the sessions view's
   "mock runs" filter (`?mock=include|only`) or the direct `/sessions/<id>`
   link. The CLI lists them by default, marked `· mock`.
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
