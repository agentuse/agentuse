---
name: runner
description: Run and manage AgentUse agents from the CLI. Use when you need to list agents, run an agent, inspect sessions, start or inspect the AgentUse server, work with schedules, or understand runtime command behavior.
---

# AgentUse Runner

Run `.agentuse` files, inspect their execution state, and operate the HTTP
server used for webhooks, approvals, channels, and schedules.

## Commands

```bash
agentuse setup                       # first-run Browser or Terminal setup
agentuse setup --web                 # open guided setup in the Web UI
agentuse setup --web -H 0.0.0.0 --no-auth  # trusted local VM/container port mapping
agentuse setup --terminal            # guided headless/SSH setup
agentuse setup --terminal --name my-agents --yes  # non-interactive

agentuse agents [--verbose|--json]

agentuse run <file>                  # append "text" for one-off instructions
agentuse run <file> --model <provider:model>
agentuse run <file> --timeout <seconds>
agentuse run <file> --json --no-tty -C /path/to/project

agentuse sessions [-n 20|--json]
agentuse sessions show <session-id> --full

agentuse serve [-p 8080]             # dashboard; create/load saved projects
agentuse serve -C /path/to/project   # explicitly serve an existing folder
agentuse serve ps                    # daemon status + counts
agentuse serve agents                # agents the daemon actually loaded (live)
agentuse serve schedules             # schedules the daemon actually loaded (live)

agentuse skills installed            # only when inspecting project/user skills

agentuse test <file> --mock-model <m>          # mock test run, adaptive scope
agentuse test <file> --approval reject         # force a gate branch
agentuse run <file> --mock --mock-model <m>    # plumbing: full mock, real gate
```

For testing workflow and mock-mode selection, load the `tester` builtin skill.

`serve agents` / `serve schedules` report live loaded data, not the cached
`serve ps` counts.

`serve ps` is the liveness check. Curling the base URL is not: there is no
root `/status` route, so a live daemon answers 404 there. `/status` is
session-scoped (`/sessions/<id>/status?logs=1` returns that run's JSON).

## Serve Web UI

`agentuse setup` is the recommended first-run command: Browser setup starts
the Web UI, while Terminal setup creates the same managed project without a
GUI. A bare `agentuse serve` never adopts the shell's current directory; with
no saved projects it opens in browser setup mode. Use `-C` when an existing
folder is intentionally the project, or save it
under `serve.projects` in `~/.agentuse/config.json`.

Binding setup to an exposed host requires server authentication. For a trusted
local VM or container whose port is published only to host localhost, pass
`--host 0.0.0.0 --no-auth`. Do not use `--no-auth` on a publicly reachable
interface.

- `/agents`, `/schedules`, what the daemon loaded.
- `/sessions`, every run; filter with `?agent=` / `?trigger=`.
- `/sessions/<id>`, run log, and the approve/reject/continue surface when a
  run is suspended on an approval gate.
- `/approvals`, sessions awaiting review.

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
