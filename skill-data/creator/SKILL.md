---
name: creator
description: Create, improve, and review AgentUse agent files. Use when authoring .agentuse agents, designing agent workflows, configuring frontmatter, adding MCP servers, subagents, schedules, approval gates, skills, or choosing project structure and automation patterns.
---

# AgentUse Creator

Use this skill when creating or improving `.agentuse` files. AgentUse agents are
markdown files with YAML frontmatter and plain English instructions.

## Basic Agent Shape

```markdown
---
model: anthropic:claude-sonnet-4-6
description: "Short action-oriented purpose"
---

You are a focused autonomous agent.

## Task
Describe exactly what the agent should accomplish.

## Output
Describe where results should go and what format they should use.
```

The filename provides the agent name. Keep descriptions concise because they
surface in CLI output, subagent tools, and plugin events.

## Authoring Checklist

- Pick a concrete job the agent can complete without interactive supervision.
- Set `model:` explicitly.
- Add a short `description:` when the agent may be listed or used as a
  subagent.
- Configure tools and MCP servers in frontmatter instead of assuming ambient
  access.
- Include expected inputs, outputs, destinations, and success criteria in the
  prompt body.
- For reusable workflows, write operational instructions instead of one-off
  chatty prompts.
- For multi-role workflows, use subagents with clear names and `maxSteps`
  limits.
- For recurring work, use YAML `schedule:` and document that `agentuse serve`
  must be running.

## Common Frontmatter

```yaml
model: anthropic:claude-sonnet-4-6
description: "Analyze daily metrics and send a concise summary"
timeout: 600
maxSteps: 100
schedule: "0 9 * * *"
subagents:
  - path: ./researcher.agentuse
    name: research
    maxSteps: 50
mcpServers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

## Skill-Aware Agents

When an agent should use reusable instructions, create skills under
`.agentuse/skills/<name>/SKILL.md` or install them with `agentuse add`.

Document tool needs in the skill with `allowed-tools`, then configure those
tools in the agent. Skills are instructions; they do not grant tools by
themselves.

## Design Guidance

AgentUse agents are non-interactive by design. They should be written like a
delegation brief for a trusted teammate:

- clear task boundaries
- clear input assumptions
- clear output destination
- enough context to finish unattended
- external status or delivery through tools when needed

## References

- Creating agents: https://docs.agentuse.io/guides/creating-agents.md
- Agent syntax: https://docs.agentuse.io/reference/agent-syntax.md
- Agent design patterns: https://docs.agentuse.io/guides/agent-design-patterns.md
- Subagents: https://docs.agentuse.io/guides/subagents.md
- Skills: https://docs.agentuse.io/guides/skills.md
- Approval gates: https://docs.agentuse.io/guides/approval-gates.md
- Schedule: https://docs.agentuse.io/guides/schedule.md
- Configuration files: https://docs.agentuse.io/reference/configuration-files.md
