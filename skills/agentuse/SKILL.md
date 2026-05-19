---
name: agentuse
description: AgentUse CLI and agent workflow guide. Use when the user mentions "agentuse", ".agentuse", "agentuse skills", "run an agent", "list agents", "agent sessions", "agentuse serve", creating or managing AgentUse agents, or wants to inspect/run/schedule AgentUse workflows. Always load the current builtin core instructions from the installed CLI before non-trivial AgentUse work.
hidden: true
---

# AgentUse

AgentUse runs AI agents from natural-language markdown files and exposes a CLI
for agents, sessions, skills, auth, models, schedules, and the server daemon.

## Start here

This file is a discovery stub, not the full usage guide. Before running
non-trivial `agentuse` commands or explaining AgentUse workflows, load the
current builtin core instructions from the installed CLI:

```bash
agentuse skills get core
agentuse skills get core --full
```

The CLI serves builtin skill content that matches the installed AgentUse
version, so instructions stay current as AgentUse changes. This local stub
should stay small and stable.

## Builtin skills

Use the builtin catalog for official AgentUse instructions:

```bash
agentuse skills
agentuse skills list
agentuse skills get <name>
agentuse skills get <name> --full
agentuse skills path <name>
```

Load specialized builtin skills when needed:

```bash
agentuse skills get runner              # running, listing, sessions, serve, schedules
agentuse skills get creator             # authoring and improving .agentuse files
```

Use installed skills only when inspecting project or user-provided skills:

```bash
agentuse skills installed
agentuse skills installed list --json
agentuse skills installed get <name>
agentuse skills installed path <name>
```

## Common entrypoints

After loading `core`, typical commands include:

```bash
agentuse agents
agentuse run <agent-file>
agentuse sessions
agentuse serve
agentuse serve ps
```
