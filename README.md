<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./static/agentuse-logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="./static/agentuse-logo.png">
  <img alt="AgentUse" src="./static/agentuse-logo.png" width="100%">
</picture>

<p align="center"><strong>OPEN-SOURCE AI AGENT RUNTIME</strong></p>

<h1 align="center">AI agents for work your team does on repeat.</h1>

<p align="center">
  Build agents around your tools and processes.<br>
  Run them in the background, review their results, and approve important actions.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentuse"><img alt="NPM version" src="https://img.shields.io/npm/v/agentuse?style=flat-square&color=00DC82&label=version"></a>
  <a href="https://www.npmjs.com/package/agentuse"><img alt="NPM downloads" src="https://img.shields.io/npm/dm/agentuse?style=flat-square&color=00DC82"></a>
  <a href="https://github.com/agentuse/agentuse"><img alt="GitHub stars" src="https://img.shields.io/github/stars/agentuse/agentuse?style=flat-square&color=00DC82"></a>
  <a href="https://github.com/agentuse/agentuse/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/npm/l/agentuse?style=flat-square&color=00DC82"></a>
</p>

<p align="center">
  <strong><a href="https://github.com/agentuse/agentuse/releases/latest">Download for Mac</a></strong> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-agentuse">Why AgentUse</a> ·
  <a href="https://github.com/agentuse/agentuse/releases/latest">Release notes</a> ·
  <a href="https://agentuse.io">Website</a> ·
  <a href="https://docs.agentuse.io">Documentation</a>
</p>

AgentUse helps you build, run, and improve AI agents for recurring business
work. Agents follow instructions saved in Markdown, use your tools, and pause
at the approval points you define. Create an agent with Codex, Claude Code, or
guided setup, then review its deliverables, schedules, and decisions from the
dashboard.

Choose your model provider and how you run your agents: start with the Mac app,
use the CLI and web dashboard on Windows or Linux, or deploy on your own
infrastructure. The same readable agent files work across these environments.

Use it for recurring research, reports, content preparation, and operational
follow-ups. Start with one well-defined job, then add specialist agents and
shared state as the process grows.

## Why AgentUse?

- **Hand off the whole process.** Save the instructions, tools, model, and
  schedule together so you don't have to brief an assistant from scratch each
  time. Guided setup can suggest recurring work from an existing project.
- **Decide where human judgment belongs.** Let agents prepare the work, then
  review the proposed action, approve it, reject it, or request changes. Use
  gated shell commands when an action needs runtime-enforced approval.
- **See what actually happened.** Open the output, artifacts, tool calls,
  usage, and approval history in a durable session. Follow delegated work and
  identify incomplete runs from the same dashboard.
- **Improve from real runs.** Turn a session into a proposed agent revision,
  inspect the source and capability changes, and apply it when you're ready.
  Reviewer feedback can also become reusable guidance through learning.
- **Keep your process adaptable.** Agent files live in your repository, ready
  to review and change as your business evolves. Choose your model provider;
  AgentUse supplies the execution loop, scheduling, and review tools.

<p align="center">
  <img
    src="./static/readme/dashboard.webp"
    alt="AgentUse dashboard showing agent health, pending approvals, recent failures, and result metrics"
    width="900"
  >
</p>

## Quick start

Use the Mac app, run the CLI with its web dashboard on Windows, Linux, or
macOS, or host AgentUse on a server. Every option provides session history,
artifacts, approvals, and agent revisions.

### Choose how to run AgentUse

**Mac app.**

Get started with the bundled runtime, guided setup, and a dashboard available
from the menu bar. Launch at login, keep agents running with the window closed,
and receive native notifications for completed runs and pending approvals.
Assign a global shortcut for quick access and choose when to install updates.
No separate Node.js installation is required.

**CLI + web dashboard (Windows, Linux, macOS).**

Run AgentUse locally from the CLI and manage your agents in a browser. Guided
browser setup, schedules, results, approvals, and agent revisions are available
without the Mac app. Requires Node.js 22+.

**Server hosting.**

Run AgentUse on an always-on server for schedules and workflows that need to
continue when your laptop is offline. Use the CLI or Docker, serve multiple
projects from one daemon, and review runs and approvals through the web
dashboard. The same agent files also run in CI/CD or through HTTP triggers.
See the [self-hosting guide](https://docs.agentuse.io/guides/self-hosting).

Scheduled work requires the host machine to be awake and the Mac app or
AgentUse service to stay running.

### Download AgentUse for Mac

**Apple silicon. No separate Node.js or CLI installation required.**

1. Download the DMG from the [latest release](https://github.com/agentuse/agentuse/releases/latest),
   move **AgentUse** to Applications, and open it.
2. Follow guided setup to create or connect a project, try the sample, and
   connect your model provider.
3. Create your first agent, test it, and enable its schedule when you're ready.
4. Return to the app to review results and respond to approval requests.

Launch at login and the bundled CLI launcher are optional setup choices. See
[AgentUse for Mac](https://docs.agentuse.io/guides/macos-desktop) for shortcuts,
notifications, and app settings.

### Set up the CLI and web dashboard

Requires **Node.js 22+**. On macOS, Windows, Linux, or a server, start guided setup
without a global installation:

```bash
npx -y agentuse@latest setup
```

Choose Browser for guided visual setup or Terminal for a headless Linux/SSH
flow. Browser and Desktop can create a managed project under
`~/.agentuse/projects` or attach an existing project; Terminal creates and
registers the managed project.

Install the CLI globally if you want a persistent `agentuse` command in every
terminal, then connect a model provider before the first real run:

```bash
npm install -g agentuse
agentuse provider login
```

API keys also work through environment variables such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY`.

See the [macOS Desktop guide](https://docs.agentuse.io/guides/macos-desktop)
or the complete [Installation guide](https://docs.agentuse.io/installation).

## Define the agent in Markdown

An agent is a Markdown file with YAML configuration and plain-English
instructions. Save this example as `morning-repo-brief.agentuse` in your
repository. The filename is its default id.

```markdown
---
model: anthropic:claude-sonnet-5
description: Summarizes repository activity and flags work that needs attention
schedule: "0 8 * * 1-5"
tools:
  filesystem:
    - path: "${root}"
      permissions: [read]
  bash:
    commands:
      - "git status *"
      - "git log *"
      - "git show *"
      - "git diff *"
---

Create a concise repository brief for the last 24 hours.

1. Summarize meaningful changes.
2. Flag risky changes, failed work, and documentation drift.
3. Recommend the next actions in priority order.

Cite commit hashes and file paths for every finding.
If nothing meaningful changed, say so.
```

Run it directly:

```bash
agentuse run morning-repo-brief.agentuse
```

Start `agentuse serve` to open the dashboard and run enabled schedules:

```bash
agentuse serve -C .
```

The same file can run from a developer machine, a server, CI, or a container.
Keep the app or server running on an awake machine for scheduled work. Use an
always-on server for jobs that need to continue while your Mac is offline.

## Run it your way

| Trigger | How |
| --- | --- |
| [Command line](https://docs.agentuse.io/reference/cli-commands) | `agentuse run my-agent.agentuse` |
| [Schedule](https://docs.agentuse.io/guides/schedule) | Add `schedule` to frontmatter and keep `agentuse serve` running |
| [HTTP](https://docs.agentuse.io/guides/webhooks) | `POST /api/run` to an `agentuse serve` daemon |
| [CI/CD](https://docs.agentuse.io/guides/cicd) | Run the same CLI command inside your pipeline |
| [Docker](https://docs.agentuse.io/guides/self-hosting) | Mount or copy agent files into the AgentUse image |

Webhook example:

```bash
agentuse serve -C .

curl http://127.0.0.1:12233/api/run \
  -H "Content-Type: application/json" \
  -d '{"agent":"morning-repo-brief"}'
```

One daemon can serve several projects:

```bash
agentuse serve -C ./project-a -C ./project-b
```

`agentuse setup` is the recommended first-run entry point. Starting
`agentuse serve` without `-C` also opens the dashboard setup without adopting
your terminal's current directory. Existing folders stay opt-in via `-C` or
`serve.projects` in
`~/.agentuse/config.json`.

## Operate agents, not prompts

The Mac app opens the operations dashboard directly. For CLI and server
installations, `agentuse serve` makes it available at
`http://127.0.0.1:12233`. Both give you the same view of each run:

- running agents and recent output
- sessions waiting for approval
- failed and incomplete work that needs review
- completed results and recorded metrics
- upcoming schedules, agent relationships, and project health

Every run is a durable session. Inspect the result, tool calls, token usage,
artifacts, verification verdicts, and follow-up context without reconstructing
the run from terminal logs.

Turn the evidence from a completed or approval-paused run into a safe agent
improvement through a reviewable internal revision session. Apply a validated
source proposal, restore the previous source, or copy a prompt to a coding agent
when the fix belongs in project code. See [Agent Revisions](https://docs.agentuse.io/guides/agent-revisions).

Test runs stay out of these operational views by default, so validating an agent
never pollutes the picture of what production is doing.

## Put consequential actions behind approval

Agents can prepare work autonomously and pause before sending, publishing,
deploying, deleting, or changing external state.

Add `approval: true` and describe the review boundary for your workflow:

```markdown
---
model: anthropic:claude-sonnet-5
approval: true
---

Draft the customer announcement from the supplied release notes.

You may research, write, and revise the draft without approval.
Before sending or publishing it, ask for approval with the final text,
target audience, delivery channel, and any unresolved risks.
```

When the agent reaches that boundary, AgentUse suspends the session. A reviewer
can approve, reject, or comment from the session page, and the agent resumes
with that decision. Slack notifications are optional; AgentUse remains the
source of truth for the review and session state.

<p align="center">
  <img
    src="./static/readme/mobile-approval.webp"
    alt="AgentUse mobile approval screen with approve, reject, and comment actions"
    width="320"
  >
</p>

Approval requests are agent-driven. For shell actions that must be blocked
until approved, configure `tools.bash.gated`; `approval: true` alone is not a
universal tool-level enforcement rule. See
[Approval Gates](https://docs.agentuse.io/guides/approval-gates) for configuration
and enforcement details.

## Features for building and running AI agents

| Feature | What AgentUse provides |
| --- | --- |
| [Markdown agent files](https://docs.agentuse.io/guides/creating-agents) | Readable instructions and configuration that work with Git |
| [Model choice](https://docs.agentuse.io/guides/model-configuration) | Anthropic, OpenAI, OpenRouter, OpenCode Go, Amazon Bedrock, and compatible local endpoints |
| [Tools](https://docs.agentuse.io/reference/builtin-tools) | Allowlisted filesystem and shell access plus built-in runtime tools |
| [MCP](https://docs.agentuse.io/reference/agent-syntax#mcp-servers) | Connect databases, APIs, browsers, and external services through Model Context Protocol servers |
| [Skills](https://docs.agentuse.io/guides/skills) | Discover and load reusable `SKILL.md` instruction packages |
| [Sessions](https://docs.agentuse.io/guides/session-logs) | Persistent run history, usage, artifacts, resume, failure visibility, and reviewable internal agent revisions |
| [Subagents](https://docs.agentuse.io/guides/subagents) | Delegate bounded work to specialized child agents |
| [Stores](https://docs.agentuse.io/guides/store) | Persistent, structured state shared across runs and cooperating agents |
| [Learning](https://docs.agentuse.io/guides/learning) | Capture reviewer feedback as durable instructions and apply the best of them to later runs |
| [Verify (experimental)](https://docs.agentuse.io/guides/verify) | Have a judge assess drafts or outputs against your criteria and request bounded revisions |
| [Manager agents (experimental)](https://docs.agentuse.io/guides/manager-agents) | Coordinate specialists, track progress, and decide what to delegate next |
| [Notifications](https://docs.agentuse.io/guides/channels) | Deliver configured run events and approval notifications to Slack |

List the currently recommended models:

```bash
agentuse models
```

Run with a different supported model without editing the file:

```bash
agentuse run my-agent.agentuse --model openai:gpt-5.6
agentuse run my-agent.agentuse --model ollama:<local-model>
```

Leaving the version off (`anthropic:claude-sonnet`) tracks the newest model in
that line. `models.aliases` in the AgentUse config gives your own `@fast`-style
names, `models.default` makes `model:` optional in agent files, and
`agentuse models unpin` converts existing files to the alias form.

Provider support means AgentUse can execute its own agent files with those model
APIs. It does not claim that `.agentuse` files deploy directly into each
provider's managed-agent platform.

## Author with AI coding assistants

Install the AgentUse skill for Claude Code, Codex, Cursor, Gemini CLI, GitHub
Copilot, Goose, OpenCode, Windsurf, and other assistants that support Agent
Skills:

```bash
npx skills add agentuse/agentuse
```

The installed discovery skill loads version-matched guidance from the CLI:

```bash
agentuse skills get core
agentuse skills get creator
agentuse skills get tester
```

## Test before enabling a schedule

Check the agent's configuration, then exercise its workflow with all tool
results mocked:

```bash
agentuse doctor my-agent.agentuse
agentuse test my-agent.agentuse --scope all --mock-model anthropic:claude-haiku-4-5
```

Use a mock model available through your configured provider. Testing still
makes model calls; `--scope all` fabricates tool results, isolates stores, and
resolves approval gates automatically. You can also exercise rejection and
request-changes paths. Test runs stay out of production operational views by
default.

The explicit scope matters: agents with gated bash commands otherwise default
to mocking only those commands, while other tools run for real. See
[Testing Agents](https://docs.agentuse.io/guides/testing-agents) for scope and
approval options.

## Documentation

- [Quick start](https://docs.agentuse.io/quickstart)
- [Creating agents](https://docs.agentuse.io/guides/creating-agents)
- [Agent syntax](https://docs.agentuse.io/reference/agent-syntax)
- [Model configuration](https://docs.agentuse.io/guides/model-configuration)
- [Operations dashboard](https://docs.agentuse.io/guides/serve-dashboard)
- [Approval gates](https://docs.agentuse.io/guides/approval-gates)
- [Self-hosting](https://docs.agentuse.io/guides/self-hosting)

## Need help implementing AgentUse?

[AgentUse Studio](https://agentuse.io/studio) helps teams design and launch
workflows around their existing tools and processes.

## Contributing

- [Report bugs](https://github.com/agentuse/agentuse/issues)
- [Share ideas](https://github.com/agentuse/agentuse/discussions)
- [Development workflows](./DEVELOPMENT.md)

Local validation:

```bash
bun run test
bun run test:coverage
bun run test:e2e
bun run test:release
```

The dashboard smoke test creates a disposable project, daemon, browser session,
and XDG state directory. It never starts a scheduled agent or calls a model.

## License

[Apache 2.0](./LICENSE)
