---
name: onboarding
description: Guide a new AgentUse user from a confirmed project to one validated first agent and its first CLI or Web UI run. Use for terminal setup and Create my first agent handoffs.
---

# AgentUse First-Agent Onboarding

AgentUse setup has already created and registered the project. The prompt that
loaded this skill supplies its exact directory; treat that path as
authoritative. It should also identify the originating surface as terminal or
Web UI. Do not choose another repository or change global serve settings.

For a Web UI handoff, `agentuse serve` is already running; do not restart it.
For a terminal handoff, use the running server if the user started it as
instructed, but do not require them to open the dashboard.

## 1. Understand One Useful Job

If the user has not described the job, ask concise questions one at a time.
Learn the input, desired output, success criteria, recurrence (if any), and any
consequential action that needs human approval. Keep the first agent focused;
defer optional integrations and elaborate multi-agent architecture.

## 2. Create It in the Confirmed Project

Load the installed authoring and testing guidance before writing:

```bash
agentuse skills get core --full
agentuse skills get creator --full
agentuse skills get tester --full
```

Use the supplied project directory as the working directory. Write exactly one
agent under `agents/<descriptive-slug>.agentuse`. Pick a current model using the
creator guidance. Add only configuration required by this job.

## 3. Validate Without Real Effects

Run `agentuse doctor <agent-file>`, then a mock test following the tester skill.
Fix validation or test failures. Do not launch a real provider-backed run and
do not trigger consequential tools during onboarding.

## 4. Return to the Originating Surface

Keep the handoff short and action-oriented:

- **Web UI:** The running server hot-reloads the new file. Tell the user its
  name and that it should now appear on the Agents page. Guide them to configure
  the required provider credential, review the agent, and launch its first real
  run from the Web UI.
- **Terminal:** Tell the user the agent file path and provide the exact
  `agentuse run <agent-file>` command. Explain any required provider setup, but
  do not launch a real run. The dashboard is optional and should only be
  mentioned if the user asks for it.
