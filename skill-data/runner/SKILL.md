---
name: runner
description: Run and manage AgentUse agents from the CLI. Use when you need to list agents, run an agent, inspect sessions, start or inspect the AgentUse server, work with schedules, or understand runtime command behavior.
---

# AgentUse Runner

Run `.agentuse` files, inspect their execution state, and operate the HTTP
server used for webhooks, approvals, channels, and schedules.

## Commands

```bash
agentuse agents [--verbose|--json]

agentuse run <file>                  # append "text" for one-off instructions
agentuse run <file> --model <provider:model>
agentuse run <file> --timeout <seconds>
agentuse run <file> --json --no-tty -C /path/to/project

agentuse sessions [-n 20|--json]
agentuse sessions show <session-id> --full

agentuse serve [-p 8080]
agentuse serve ps                    # daemon status + counts
agentuse serve agents                # agents the daemon actually loaded (live)
agentuse serve schedules             # schedules the daemon actually loaded (live)

agentuse skills installed            # only when inspecting project/user skills
```

`serve agents` / `serve schedules` report live loaded data, not the cached
`serve ps` counts.

## Serve Web UI

- `/agents`, `/schedules` — what the daemon loaded.
- `/sessions` — every run; filter with `?agent=` / `?trigger=`.
- `/sessions/<id>` — run log, and the approve/reject/continue surface when a
  run is suspended on an approval gate.
- `/approvals` — sessions awaiting review.

## Scheduled Agents

A `schedule:` agent only runs while `agentuse serve` is running for a watched
project. Before relying on one:

1. Confirm the project is in `~/.agentuse/config.json` under `serve.projects`.
2. Confirm the daemon is up (`agentuse serve ps`).
3. Use a process manager for long-running schedules.

YAML `schedule:` is for recurring jobs; schedule one-off runs outside YAML.

## References

- Quickstart: https://docs.agentuse.io/quickstart.md
- CLI commands: https://docs.agentuse.io/reference/cli-commands.md
- Agent syntax: https://docs.agentuse.io/reference/agent-syntax.md
- Model configuration: https://docs.agentuse.io/guides/model-configuration.md
- Scheduled agents: https://docs.agentuse.io/guides/schedule.md
- Session logs: https://docs.agentuse.io/guides/session-logs.md
