---
name: creator
description: Create, improve, and review AgentUse agent files. Use when authoring .agentuse agents, designing agent workflows, configuring frontmatter, adding MCP servers, subagents, schedules, approval gates, skills, or choosing project structure and automation patterns.
---

# AgentUse Creator

Use this skill when creating or improving `.agentuse` files. AgentUse agents are
markdown files with YAML frontmatter and plain English instructions.

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

The filename provides the agent name. Keep descriptions concise because they
surface in CLI output, subagent tools, and plugin events.

## Authoring Checklist

- Pick a concrete job the agent can complete without interactive supervision.
- Set `model:` explicitly.
- Add a short `description:` when the agent may be listed or used as a
  subagent.
- Configure tools and MCP servers in frontmatter instead of assuming ambient
  access.
- Include expected inputs, outputs, destinations, and success criteria in the
  prompt body.
- For reusable workflows, write operational instructions instead of one-off
  chatty prompts.
- For multi-role workflows, use subagents with clear names and `maxSteps`
  limits.
- For recurring work, use YAML `schedule:` and document that `agentuse serve`
  must be running.

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

## Skill-Aware Agents

When an agent should use reusable instructions, create skills under
`.agentuse/skills/<name>/SKILL.md` or install them with `agentuse add`.

Document tool needs in the skill with `allowed-tools`, then configure those
tools in the agent. Skills are instructions; they do not grant tools by
themselves.

## Design Guidance

AgentUse agents are non-interactive by design. They should be written like a
delegation brief for a trusted teammate:

- clear task boundaries
- clear input assumptions
- clear output destination
- enough context to finish unattended
- external status or delivery through tools when needed

### Write lean: hard-code invariants, delegate judgment

The prompt is a brief, not a manual. It is re-sent on every step, so length
is a recurring token cost, and a long prompt buries the few rules that
actually matter. Pin down only what must be exact:

- safety boundaries (read-only, never call X, which store to write),
- exact commands, paths, and flags the model cannot guess,
- the output schema and where it goes,
- ordering that changes the result.

For everything else - how to investigate, how to phrase, how to handle the
long tail of edge cases - state the goal and the constraint, then let the
model decide. Spelling out every branch makes the agent brittle (it breaks on
the case you did not enumerate) and bloats the prompt.

Smell tests that you are over-specifying: the same rule restated in three
places, a paragraph justifying *why* a step exists, an enumerated decision
tree the model could derive from one sentence of intent. Cut them - aim for
what a competent teammate needs, not a spec.

## Gotchas

Recurring mistakes to avoid when authoring or reviewing `.agentuse` files.

### Reading large files burns context: there is no builtin grep or glob

AgentUse exposes only `filesystem_read` / `filesystem_write` /
`filesystem_edit` - there is **no builtin grep, glob, or content-search
tool**. The only way to search inside files is `bash` (`grep` / `rg`) or a
script (`python3` / `jq`). And `filesystem_read` returns the *whole* file
unless you pass `limit` / `offset`.

So an agent told "read `registry.yaml`" or "read the log" will slurp the
entire file into context, often re-reading it across steps - the fastest way
to blow the window on a big or repeatedly-scanned file. When the agent only
needs a few fields out of a large or structured file:

- grant a search/filter command (`grep '<pattern>' <path>/*`, `rg`, or a
  `python3` / `jq` one-liner that prints only the matching rows) and tell the
  agent to use it instead of reading the file whole;
- or read with `limit` / `offset`, and read a given file once.

Match the `bash` allowlist to this. A read-heavy agent granted only `cat` and
`ls` cannot search, so it falls back to whole-file reads - the exact pattern
that runs up context.

### Approval gates are async; do not pad `timeout:` for human review

`approval: true` and `await_human`-style gates suspend the run while waiting
for a human. The agent's `timeout:` clock does not tick during that wait.
Size `timeout:` for the active work between gates, not for the worst-case
human response time. Padding the timeout for "two approvals × N minutes" is
a misread of how the runtime schedules these waits.

### Agents cannot prompt the user mid-run

Never write workflow steps like "stop and ask the user to do X." There are
only three legitimate branches when the agent hits a blocker:

- exit with a clear error message,
- record the condition to the configured store and continue or stop,
- fire an approval / notification through the configured channel.

The approval gate is the only sanctioned human-in-the-loop path.

### Validate models against `agentuse models`, not assumptions

The model catalog moves. Before flagging a model name as invalid, check
`agentuse models` - it lists every model the installed CLI accepts. Naming
patterns from other tools (e.g. assuming "5.5" cannot exist because another
provider stops at "5.2") will mislead you.

### Defer to skills; do not hardcode their internals

When an agent uses a skill, reference the skill (`/linkedin`, `/agent-browser-w-cdp`)
and let the skill own its script paths and eval patterns. Copying the
skill's `cat .../scripts/foo.js | agent-browser eval ...` into the agent
body causes drift the moment the skill reorganises files. Treat the skill
as the source of truth.

The line to draw is *internals vs. knowledge*, not "never duplicate":

- **Always** mention how to invoke the skill by name (`/linkedin`).
- **Never** inline its drift-prone internals - exact script paths, eval
  invocations, file layout. Those break when the skill reorganises.
- **Sometimes do** repeat the durable context and instructions the skill
  carries, inline in the prompt, when it makes the agent more reliable.
  An agent that restates the few steps and rules it depends on still runs
  correctly if the skill is not loaded that turn; one that only names the
  skill stalls when it does not load. The cost is the usual prompt-length
  tradeoff, so repeat the stable guidance the run actually hinges on, not
  the whole skill.

Rule of thumb: reference the parts that change, repeat the parts that do not.

### Skill scripts read via bash need explicit filesystem + bash allowlist entries

Skills that ship scripts under `~/.claude/skills/<name>/scripts/` and expect
the agent to `cat` them must be granted:

- `tools.filesystem` read on the skill's directory (absolute path - `~`
  may not expand in every context),
- a narrow `bash.commands` entry like
  `cat /Users/<you>/.claude/skills/<name>/scripts/*`.

Avoid the lazy `cat *` blanket - it is far broader than the skill needs.

### Slack / notifications: match the body text to the actual frontmatter key

`channels.slack` is the configured key. Older drafts sometimes describe
Slack delivery as "configured through `notifications.routes`," which no
longer matches. When reviewing an agent, ensure the prose section names
the same key the frontmatter uses.

## References

Do not rely on a hardcoded list here - it goes stale. When you need a doc
page (anything about frontmatter, tools, channels, store, subagents,
approvals, scheduling, sandbox, learning, etc.), fetch the canonical
index first, then load the specific page(s) you need:

```
https://docs.agentuse.io/llms.txt
```

That file enumerates every current guide and reference page with a short
description. Pick the matching `.md` URLs from there and fetch them
directly. This keeps the skill aligned with whatever the docs site
publishes right now.
