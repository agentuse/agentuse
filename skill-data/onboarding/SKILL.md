---
name: onboarding
description: Guide a new AgentUse user from a confirmed serve project to one validated first agent and its first Web UI run. Use for the Create my first agent handoff.
---

# AgentUse First-Agent Onboarding

The AgentUse Web UI has already created and registered the project. The prompt
that loaded this skill supplies its exact directory; treat that path as
authoritative. Do not choose another repository, change global serve settings,
or restart `agentuse serve`.

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

## 4. Return to the Web UI

The running server hot-reloads the new file. Tell the user its name and that it
should now appear in the Agents page. Then guide them to configure the required
provider credential, review the agent, and launch its first real run from the
Web UI. Keep the handoff short and action-oriented.
