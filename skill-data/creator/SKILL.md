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

## Gotchas

Recurring mistakes to avoid when authoring or reviewing `.agentuse` files.

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
