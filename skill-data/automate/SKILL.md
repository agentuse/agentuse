---
name: automate
description: Turn a workflow described or just completed in a coding agent into one focused, validated AgentUse agent. Use for make-this-repeatable, scheduled-workflow, and first-automation handoffs from third-party coding agents.
---

# Automate with AgentUse

Convert the user's current work into a real AgentUse agent and leave it ready
for a supervised first run. Treat the originating conversation and repository
state as source context: do not make the user restate a workflow that is already
clear.

## Define the automation

Infer the narrowest repeatable job from the supplied context. Establish:

- the input and where it comes from;
- the outcome and completion criteria;
- the trigger: manual, scheduled, or HTTP;
- the output destination; and
- any consequential action that must require approval.

Ask one concise question only when a missing choice materially changes the
agent or its safety boundary. Do not expand a focused workflow into a general
automation system.

## Prepare AgentUse

The host adapter has already confirmed that the `agentuse` command is
available. Load the remaining version-matched guidance as the workflow reaches
those stages; do not rely on syntax remembered from another version.

Choose the project deliberately:

- For work tied to the current repository, keep the agent in that repository
  under `agents/<descriptive-slug>.agentuse`.
- For personal or cross-project work, reuse an already registered AgentUse
  project. If none exists, run `agentuse setup` and follow its onboarding
  handoff rather than inventing project configuration.
- Honor a project path supplied by the user. Never relocate an existing
  AgentUse project or change unrelated global serve settings.

Before writing an agent, run:

```sh
agentuse provider list --json
```

A coding-agent login is not an AgentUse runtime credential.

- Continue only with a provider whose entry has `configured: true`.
- If none is configured, tell the user to run `agentuse provider login` in
  their own terminal. Do not operate the interactive login or request API keys,
  authorization codes, callback URLs, or other credentials in chat. Resume
  after the user confirms login is complete and check again.
- If several are configured, use the configured default when one exists;
  otherwise ask which provider to use.

## Create and validate the agent

Load the current authoring and testing guidance before writing:

```sh
agentuse skills get creator --full
agentuse skills get tester --full
```

Create exactly one focused `.agentuse` file for the requested job. Use only
capabilities required by the workflow. Validate the selected model with
`agentuse models <provider>`. Put effectful shell commands under
`tools.bash.gated`; prompt wording alone is not an approval boundary.

Run the closed validation loop described by the installed tester skill:

1. Run `agentuse doctor <agent-file>`.
2. Run a mock test without real side effects.
3. Inspect the resulting session.
4. Correct failures and repeat until the agent validates or a real blocker is
   identified.

Do not perform the first real run, publish output, start a persistent daemon,
or configure an external integration unless the user explicitly asks for that
additional action.

## Handoff

Return a compact activation summary containing:

- the agent file path and purpose;
- provider and model;
- trigger and approval boundaries;
- doctor and mock-test results;
- the exact command for a supervised first run; and
- for scheduled or HTTP agents, the remaining `agentuse serve` requirement.

Distinguish clearly between what was completed and what still requires the
user.
