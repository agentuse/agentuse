---
name: automate
description: Turn a workflow described or just completed in a coding agent or chat into one focused, validated AgentUse agent. Use for make-this-repeatable, scheduled-workflow, and first-automation handoffs from coding agents, and from chat apps connected to AgentUse over MCP.
---

# Automate with AgentUse

Convert the user's current work into a real AgentUse agent and leave it ready
for a supervised first run. Treat the originating conversation and repository
state as source context: do not make the user restate a workflow that is already
clear.

## Define the automation

Infer the narrowest repeatable job from the supplied context. Establish:

- the input source and how the agent discovers work without a per-run prompt;
- the outcome and completion criteria;
- the trigger: manual, scheduled, or HTTP;
- the output destination; and
- any consequential action that must require approval.

Ask one concise question only when a missing choice materially changes the
agent or its safety boundary. Do not expand a focused workflow into a general
automation system.

Default to an agent that runs without per-run user input. Infer its source and
scope from the conversation and repository, then make it discover actionable
work from that configured source each time it runs. A manual trigger means the
user starts the agent; it does not imply the user must supply URLs, files, or a
prompt on every run. Supplied input can be an optional override. Require per-run
input only when the user explicitly requests an input-driven agent or the job
inherently depends on an incoming event payload.

Resolve source configuration during authoring. When it cannot be inferred, ask
for the missing source or scope once rather than designing a recurring request
for work items. Reuse existing state or record progress to deduplicate processed
and in-flight items. Define a successful no-work outcome when discovery finds
nothing actionable; discovery failures are blocked work, not an empty result.

Identify the skills, reference files, and scripts used in the originating manual
workflow, including those documented in the repository. Preserve them using the
creator skill's "Reuse Existing Workflow Dependencies" guidance rather than
reconstructing the workflow from its outcome alone.

## Choose the execution mode

Pick exactly one mode and follow only its steps below. Never mix them, for
example by writing the agent file to disk and also saving a draft.

- **CLI-backed mode:** you can run commands on the user's computer (a coding
  agent with a terminal). The agent file lands in the repository, and the user
  reviews it there.
- **Chat mode:** you cannot run commands, but the AgentUse MCP tools are
  available (`list_projects`, `get_project`, `draft_agent`, `test_draft`). The
  agent is saved as a draft that the user reviews and applies on a page.
- **Artifact-only mode:** neither. You write a portable file for later
  validation.

For CLI-backed mode, choose the freshest available AgentUse command prefix:

- Prefer `npx -y agentuse@latest` when `npx` is available and the package can
  execute under the host's network and sandbox policy.
- Otherwise use `agentuse` when that command is installed.
- When neither command can execute and the AgentUse MCP tools are not
  available either, use artifact-only mode: the host bundle's
  `references/core.md` for general CLI and project semantics, then
  `references/creator.md` to author one portable `.agentuse` file. Do not try
  to install AgentUse silently. Skip provider discovery, model-catalog
  validation, doctor, mock testing, scheduling, and real execution because
  those require the runtime. The result is an artifact for later validation,
  not an activated automation.

In CLI-backed mode, replace `agentuse` at the start of every command below with
the selected command prefix. For example, the provider check becomes
`npx -y agentuse@latest provider list --json` when using npm. Use one prefix
consistently for skill loading, model discovery, validation, testing, session
inspection, and the handoff commands.

Choose the project deliberately:

- For work tied to the current repository, keep the agent in that repository
  under `agents/<descriptive-slug>.agentuse`.
- For new helpers used only by this agent, prefer
  `agents/scripts/<descriptive-slug>/`. Keep shared helpers in the project's
  existing scripts directory and preserve established agent layouts.
- For personal or cross-project work, reuse an already registered AgentUse
  project. If none exists, run `agentuse setup` and follow its onboarding
  handoff rather than inventing project configuration.
- Honor a project path supplied by the user. Never relocate an existing
  AgentUse project or change unrelated global serve settings.

In CLI-backed mode, before writing an agent, run using the selected prefix:

```sh
agentuse provider list --json
```

In chat mode, call `list_projects`. With one project, use it; with several,
pick from the conversation or ask which. Then call `get_project` for it. Use
only models in `models.available`, and only MCP servers and skills it lists. A
server nobody has added yet may still go in the agent: say so, and the review
flags its missing login. If no model is available, tell the user to run
`agentuse provider login` on their computer, and stop until they have.

A coding-agent login is not an AgentUse runtime credential.

- Continue only with a provider whose entry has `configured: true`.
- If none is configured, tell the user to run `agentuse provider login` in
  their own terminal. Do not operate the interactive login or request API keys,
  authorization codes, callback URLs, or other credentials in chat. Resume
  after the user confirms login is complete and check again.
- If several are configured, use the configured default when one exists;
  otherwise ask which provider to use.

## Create and validate the agent

In CLI-backed mode, load the current core, authoring, and testing guidance with
the selected prefix before writing:

```sh
agentuse skills get core --full
agentuse skills get creator --full
agentuse skills get tester --full
```

In chat mode, the core and creator guidance is attached below these
instructions. Where it mentions CLI commands, use the AgentUse tools instead.
Read a project file with `read_project_file` only when the agent must match it
(a template, a data header, a script's options).

In artifact-only mode, read the bundled `references/core.md` and
`references/creator.md` instead. Use a model family or role alias supported by
that guidance, but label it as unverified because the live catalog is
unavailable. Read `references/tester.md` only to understand what remains to be
validated later; do not claim its checks ran.

Create exactly one focused `.agentuse` file for the requested job. Use only
capabilities required by the workflow. Validate the selected model with
`agentuse models <provider>`. Put effectful shell commands under
`tools.bash.gated`; prompt wording alone is not an approval boundary.

Use the creator skill's script guidance to decide whether new helpers are
needed. Reuse existing commands first; write persistent scripts when project
libraries or raw file/network/process access, reuse outside this agent, or a
separately reviewed permission boundary warrants them. Do not generate a helper
for every workflow stage or merely to compose AgentUse tools; use direct tools
or `code_exec` for that composition. Make any helper reachable through an
allowlisted command and validate its behavior before handoff.

In CLI-backed mode, run the closed validation loop described by the installed
tester skill:

1. Run `agentuse doctor <agent-file>`.
2. Run a mock test without real side effects. For the default input contract,
   invoke it without a supplied prompt and verify that the agent discovers work
   from its configured source. Also exercise the no-work outcome and inspect
   that repeated runs do not duplicate processed or in-flight items.
3. Inspect the resulting session.
4. Correct failures and repeat until the agent validates or a real blocker is
   identified.

In chat mode, save and check the agent with the tools instead:

1. Call `draft_agent` with the files, the user's goal, a one-sentence summary,
   and the entry file. Do not put `schedule:` in the file: a new agent may not
   carry one before review. Pass the schedule as `schedule` instead (cron such
   as `0 8 * * 1-5`, or an interval such as `2h`). The review page shows it,
   and Apply turns it on.
2. If `draft_agent` rejects the files, fix them and call it again with the
   same `draft_id`.
3. Call `test_draft` for a practice run, then `get_session` until it ends.
   Every tool is faked there, so judge whether the steps and approvals make
   sense, not the made-up data. Fix and test again, at most three rounds. If
   `test_draft` refuses the draft, say why and leave the test to the user.

Do not perform the first real run, publish output, start a persistent daemon,
or configure an external integration unless the user explicitly asks for that
additional action.

## Handoff

Return a compact activation summary containing:

- the agent file path and purpose;
- provider and model;
- trigger and approval boundaries;
- doctor and mock-test results;
- the exact command for a supervised first run, without a prompt by default; and
- for scheduled or HTTP agents, the remaining `agentuse serve` requirement.

Distinguish clearly between what was completed and what still requires the
user.

In chat mode, the summary carries the `review_url` in place of a file path and
commands. Give what the agent does, when it runs, what it will ask approval
for, and what the practice run showed. Tell the user to open the link and press
Apply, which also turns on the schedule shown there. You cannot turn the agent
on, and must not say you did.

For artifact-only mode, explicitly say `Not runtime validated`, identify the
missing AgentUse CLI as the reason, and provide these activation steps:

```sh
npx -y agentuse@latest doctor <agent-file>
npx -y agentuse@latest test <agent-file> --mock-model <configured-cheap-model>
npx -y agentuse@latest run <agent-file>
```

Do not run or recommend `agentuse setup` as a hidden prerequisite to creating
the artifact. Provider login and any first real run remain human-owned follow-up
actions.
