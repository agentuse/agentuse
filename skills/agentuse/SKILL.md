---
name: agentuse
description: AgentUse CLI and agent workflow guide. Use when the user mentions "agentuse", ".agentuse", "agentuse skills", "run an agent", "list agents", "agent sessions", "agentuse serve", creating or managing AgentUse agents, or wants to inspect/run/schedule AgentUse workflows. Always load the current builtin core instructions from the installed CLI before non-trivial AgentUse work.
hidden: true
---

# AgentUse

This is a discovery stub, not the usage guide. The CLI serves builtin skill
content matched to the installed version, so load that before non-trivial work:

```bash
agentuse skills get core [--full]   # start here
```

`core` routes to the specialized builtin skills:

```bash
agentuse skills get runner          # run, list, sessions, serve, schedules
agentuse skills get creator         # author and improve .agentuse files
agentuse skills installed           # inspect project/user skills
```

Keep this stub small and stable; the authoritative instructions live in the CLI.
