# Creator: command line

The authoring rules in `SKILL.md` name steps, not commands. On the command
line, they are:

| Step in the rules | Command |
| --- | --- |
| Current model catalog | `agentuse models` |
| Config check | `agentuse doctor <file>` |
| Practice run | `agentuse test <file>` (`--mock` fakes every tool); `agentuse skills get tester` has the workflow |
| Agent list, with metadata chips | `agentuse agents` (`--json` for `.metadata`) |
| Install a published skill | `agentuse add` |
| Schedules run | while `agentuse serve` is running |

## Agents run from a URL; state does not follow them

`agentuse run <url>`
executes a remote agent directly (`npx agentuse run <raw-gist-url> "args"`, no
clone). The first URL run shows a trust prompt (`[p]review / [y]es / [N]o`);
only `agentuse.io` URLs skip it, so a gist/raw URL always asks - fine
interactively, but pipe `y` (or otherwise answer it) in non-interactive tests
or the run hangs on stdin. But `store:` state lives at
`<projectRoot>/.agentuse/store/`, and for a
URL/copy-paste run `projectRoot = findProjectRoot(process.cwd())` (walks up for
`.agentuse`/`.git`/`package.json`, else cwd). So a portable agent that leans on
the store silently re-baselines when run from a different directory. Prefer
stateless; use `store:` only when cross-run memory is the actual point. For a
"what's new" feel without state, scope by data (items dated in the last N days),
not by remembered deltas. Pin the store with `-C <path>` when cron'ing a URL run.
