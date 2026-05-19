---
name: core
description: Core AgentUse usage guide. Read this before running AgentUse commands. Covers the builtin skill catalog, installed skill inspection, agent discovery, running agents, creating agents, sessions, server usage, schedules, and when to load specialized AgentUse builtin skills.
---

# AgentUse Core

AgentUse runs AI agents from natural-language markdown files. Agents live in
`.agentuse` files and can use tools, skills, subagents, approval gates,
stores, sessions, schedules, and the AgentUse HTTP server.

## Start Here

Use builtin skills for official AgentUse instructions that match the installed
CLI version:

```bash
agentuse skills
agentuse skills list
agentuse skills get core
agentuse skills get core --full
```

Use installed skills only when you need to inspect project or user-provided
skills:

```bash
agentuse skills installed
agentuse skills installed list --json
agentuse skills installed get <name>
agentuse skills installed path <name>
```

## Common Workflows

```bash
agentuse agents
agentuse agents --verbose
agentuse agents --json

agentuse run <agent-file>
agentuse run <agent-file> "additional instructions"
agentuse run <agent-file> --json

agentuse sessions
agentuse sessions show <session-id> --full

agentuse serve
agentuse serve ps
```

## When To Load Another Builtin Skill

- Running, listing, serving, scheduling, or inspecting agents:
  `agentuse skills get runner`
- Creating, improving, or reviewing `.agentuse` files:
  `agentuse skills get creator`

Load specialized skills when the task needs more detail than this overview.

## Operating Guidance

- Use `agentuse agents` first when the user asks what agents are available in
  the current project.
- Use `agentuse run <agent-file>` when the user names a specific `.agentuse`
  file or path.
- Use `agentuse sessions` to inspect prior runs and debug what happened.
- Use `agentuse skills` for official AgentUse builtin skills.
- Use `agentuse skills installed` for local project/user skills discovered
  from `.agentuse/skills`, `~/.agentuse/skills`, `.claude/skills`, and
  `~/.claude/skills`.

## Schedules

Agents with a `schedule:` field only run while `agentuse serve` is running for
a project watched by the daemon. Before relying on a scheduled agent, confirm
the project is registered in `~/.agentuse/config.json` and that `agentuse serve`
is running.

Use one-shot scheduling outside YAML schedules. YAML `schedule:` is for
recurring jobs.

## References

- Introduction: https://docs.agentuse.io/index.md
- Quickstart: https://docs.agentuse.io/quickstart.md
- CLI commands: https://docs.agentuse.io/reference/cli-commands.md
- Creating agents: https://docs.agentuse.io/guides/creating-agents.md
- Agent syntax: https://docs.agentuse.io/reference/agent-syntax.md
- Skills: https://docs.agentuse.io/guides/skills.md
- Agent design patterns: https://docs.agentuse.io/guides/agent-design-patterns.md
