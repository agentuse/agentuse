---
name: core
description: Core AgentUse usage guide. Read this before running AgentUse commands. Covers the builtin skill catalog, installed skill inspection, agent discovery, running agents, creating agents, sessions, server usage, schedules, and when to load specialized AgentUse builtin skills.
---

# AgentUse Core

AgentUse runs AI agents from natural-language markdown files. Agents live in
`.agentuse` files and can use tools, skills, subagents, approval gates,
stores, sessions, schedules, and the AgentUse HTTP server.

## Skill Catalog

Builtin skills carry official instructions matched to the installed CLI
version. Installed skills are the project/user skills discovered from
`.agentuse/skills`, `~/.agentuse/skills`, `.claude/skills`, and
`~/.claude/skills`.

```bash
agentuse skills [list]                  # builtin catalog
agentuse skills get <name> [--full]     # builtin skill content
agentuse skills installed [list|get|path] <name>   # project/user skills
```

## Load A Specialized Builtin Skill

- `agentuse skills get runner` — running, listing, sessions, serve, schedules.
- `agentuse skills get creator` — authoring, improving, reviewing `.agentuse`.

## Entrypoints

```bash
agentuse agents          # what can run in this project
agentuse run <file>      # run an agent (append "text" for one-off instructions)
agentuse sessions        # inspect prior runs
agentuse serve           # daemon for webhooks, approvals, channels, schedules
```

See the `runner` skill for the full command set and flags.

## Schedules

A `schedule:` agent only runs while `agentuse serve` is running for a project
watched by the daemon. Before relying on one, confirm the project is registered
in `~/.agentuse/config.json` and the daemon is up (`agentuse serve ps`). YAML
`schedule:` is for recurring jobs; schedule one-off runs outside YAML.

## References

- Introduction: https://docs.agentuse.io/index.md
- Quickstart: https://docs.agentuse.io/quickstart.md
- CLI commands: https://docs.agentuse.io/reference/cli-commands.md
- Creating agents: https://docs.agentuse.io/guides/creating-agents.md
- Agent syntax: https://docs.agentuse.io/reference/agent-syntax.md
- Skills: https://docs.agentuse.io/guides/skills.md
- Agent design patterns: https://docs.agentuse.io/guides/agent-design-patterns.md
