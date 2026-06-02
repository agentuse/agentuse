---
name: runner
description: Run and manage AgentUse agents from the CLI. Use when you need to list agents, run an agent, inspect sessions, start or inspect the AgentUse server, work with schedules, or understand runtime command behavior.
---

# AgentUse Runner

Use `agentuse` to run `.agentuse` files, inspect their execution state, and
operate the HTTP server used for webhooks, approvals, and schedules.

## Common Commands

```bash
agentuse agents
agentuse agents --verbose
agentuse agents --json

agentuse run <agent-file>
agentuse run <agent-file> "additional instructions"
agentuse run <agent-file> --model <provider:model>
agentuse run <agent-file> --timeout <seconds>
agentuse run <agent-file> --json
agentuse run <agent-file> --no-tty
agentuse run <agent-file> -C /path/to/project

agentuse sessions
agentuse sessions -n 20
agentuse sessions show <session-id> --full
agentuse sessions --json

agentuse serve
agentuse serve -p 8080
agentuse serve ps
agentuse serve agents
agentuse serve schedules
```

## Operating Guidance

- Use `agentuse agents` first when the user asks what can run in the current
  project.
- Use `agentuse run <agent-file>` when the user names a specific `.agentuse`
  file or path.
- Append a prompt after the file path for temporary instructions without
  editing the agent.
- Use `agentuse sessions` to inspect prior runs and debug failures.
- Use `agentuse serve` for webhooks, approval review pages, Slack channels,
  and scheduled agents.
- Use `agentuse serve agents` and `agentuse serve schedules` to see what a
  running daemon actually loaded (live data, not just the `serve ps` counts).
  Both also serve `/agents` and `/schedules` pages in the serve web UI.
- Use `agentuse skills installed` only when inspecting project or user-installed
  skills.

## Scheduled Agents

Agents with a `schedule:` field only run while `agentuse serve` is running for
a project watched by the daemon.

Before relying on a scheduled agent:

1. Confirm the project is registered in `~/.agentuse/config.json` under
   `serve.projects`.
2. Confirm the daemon is running with `agentuse serve ps`.
3. Use a process manager for long-running schedules.

Use one-shot scheduling outside YAML schedules. YAML `schedule:` is for
recurring jobs.

## References

- Quickstart: https://docs.agentuse.io/quickstart.md
- CLI commands: https://docs.agentuse.io/reference/cli-commands.md
- Agent syntax: https://docs.agentuse.io/reference/agent-syntax.md
- Model configuration: https://docs.agentuse.io/guides/model-configuration.md
- Scheduled agents: https://docs.agentuse.io/guides/schedule.md
- Session logs: https://docs.agentuse.io/guides/session-logs.md
