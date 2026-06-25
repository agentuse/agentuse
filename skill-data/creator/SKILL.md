---
name: creator
description: Create, improve, and review AgentUse agent files. Use when authoring .agentuse agents, designing agent workflows, configuring frontmatter, adding MCP servers, subagents, schedules, approval gates, skills, or choosing project structure and automation patterns.
---

# AgentUse Creator

Use this skill when creating or improving `.agentuse` files: markdown with YAML
frontmatter and plain-English instructions. The filename is the agent name.

## Basic Agent Shape

```markdown
---
model: anthropic:claude-sonnet-4-6
description: "Short action-oriented purpose"
---

You are a focused autonomous agent.

## Task
Describe exactly what the agent should accomplish.

## Output
Describe where results should go and what format they should use.
```

## Common Frontmatter

```yaml
model: anthropic:claude-sonnet-4-6
description: "Analyze daily metrics and send a concise summary"
timeout: 600
maxSteps: 100
schedule: "0 9 * * *"
subagents:
  - path: ./researcher.agentuse
    name: research
    maxSteps: 50
mcpServers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

## Authoring Checklist

- A concrete job the agent can finish without interactive supervision.
- `model:` set explicitly; short `description:` if it may be listed or used as
  a subagent.
- Tools and MCP servers declared in frontmatter, not assumed ambient.
- Inputs, outputs, destinations, and success criteria stated in the body.
- Multi-role work: subagents with clear names and `maxSteps` limits.
- Recurring work: YAML `schedule:` + a note that `agentuse serve` must run.

## Write Lean: Hard-Code Invariants, Delegate Judgment

The prompt is a brief, not a manual. It is re-sent on every step, so length is
a recurring token cost and a long prompt buries the rules that matter. Pin down
only what must be exact:

- safety boundaries (read-only, never call X, which store to write),
- exact commands, paths, and flags the model cannot guess,
- the output schema and where it goes,
- ordering that changes the result.

For everything else — how to investigate, how to phrase, the long tail of edge
cases — state the goal and the constraint, then let the model decide. Spelling
out every branch makes the agent brittle on the case you did not enumerate.

Over-specification smells: the same rule in three places, a paragraph
justifying *why* a step exists, an enumerated decision tree derivable from one
sentence of intent. Write what a competent teammate needs, not a spec.

Skills are instructions, not tool grants: declare an agent's tools in
frontmatter even when a skill documents them with `allowed-tools`. Put reusable
instructions in `.agentuse/skills/<name>/SKILL.md` or install with `agentuse add`.

## Source Precedence: Skills Are Defaults, Learnings Override Them

The runtime composes one prompt from layered sources, in this precedence
(highest first): **agent instructions → Learned Guidelines → Skills → other
reference files.** The system prompt's operational/safety rules sit above all of
these. This shapes where a rule belongs:

- Put **soft defaults** in skills. Don't bake a hard "never do X" into a skill
  that a learning should be able to override — a captured correction outranks a
  skill default, so an absolute skill rule fights the feedback loop.
- State a rule **once**, at the right layer, and reference it. The same craft
  rule copied into both a skill and the agent drifts; the lower-precedence copy
  then silently wins (this is the "same rule in three places" smell above, seen
  from the runtime side).
- `learning: true` (sugar for `capture + apply`) injects the agent's stored
  learnings every run — for delegated subagents too, not just top-level runs. So
  a leaf's prior-run corrections actually reach it; rely on that instead of
  hand-restating past corrections in the prompt.

## Gotchas

- **No builtin grep/glob.** Only `filesystem_read|write|edit` exist, and
  `filesystem_read` returns the whole file unless you pass `limit`/`offset`. For
  big or structured files, grant `grep`/`rg`/`jq` via bash and tell the agent to
  search, not slurp. A read agent given only `cat`/`ls` falls back to whole-file
  reads — the exact context blowup to avoid.

- **Approval gates are async.** `approval: true` / `await_human` gates suspend
  the run; `timeout:` does not tick during the wait. Size `timeout:` for the
  active work between gates, not human response time.

- **Agents cannot prompt the user mid-run.** Never write "stop and ask the user
  to do X." The only branches at a blocker: exit with a clear error, record to
  the store and continue/stop, or fire an approval/notification. The approval
  gate is the only human-in-the-loop path.

- **Validate models against `agentuse models`.** The catalog moves; check it
  before calling a name invalid. Don't infer limits from other providers'
  naming (e.g. "5.5 can't exist because provider Y stops at 5.2").

- **Defer to skills; don't inline their internals.** Reference a skill by name
  (`/linkedin`) and never copy its drift-prone internals (script paths, eval
  invocations, file layout). Do repeat the durable steps/context the run hinges
  on inline, since the skill may not load that turn. Rule: reference what
  changes, repeat what doesn't.

- **Skill scripts read via bash need explicit allowlists.** Grant
  `tools.filesystem` read on the skill dir (absolute path — `~` may not expand)
  and a narrow `bash.commands` like `cat /Users/<you>/.claude/skills/<name>/scripts/*`.
  Not a blanket `cat *`.

- **Match channel prose to the frontmatter key.** `channels.slack` is the key.
  Don't describe Slack delivery as `notifications.routes`; the body must name
  the key the frontmatter uses.

## References

Don't hardcode a doc list here — it goes stale. Fetch the canonical index and
load the specific page(s) you need:

```
https://docs.agentuse.io/llms.txt
```

It enumerates every current guide and reference page with a short description.
Pick the matching `.md` URLs and fetch them directly.
