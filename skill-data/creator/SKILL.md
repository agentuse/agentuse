---
name: creator
description: Create, improve, and review AgentUse agent files. Use when authoring .agentuse agents, designing agent workflows, configuring frontmatter, adding MCP servers, subagents, schedules, approval gates, skills, or choosing project structure and automation patterns.
---

# AgentUse Creator

Use this skill when creating or improving `.agentuse` files: markdown with YAML
frontmatter and plain-English instructions. The filename is the agent name.

## Basic Agent Shape

```markdown
---
model: anthropic:claude-sonnet-5
description: "Short action-oriented purpose"
---

You are a focused autonomous agent.

## Task
Describe exactly what the agent should accomplish.

## Output
Describe where results should go and what format they should use.
```

## Common Frontmatter

```yaml
model: anthropic:claude-sonnet-5
description: "Analyze daily metrics and send a concise summary"
timeout: 600
maxSteps: 100
anthropic:             # Claude extended thinking; opt-in, billed at OUTPUT rates.
  thinking:
    budgetTokens: 4096 # omit to disable (default). Must nest under `anthropic:` (see gotcha). OpenAI models: use `openai.reasoningEffort` instead.
schedule: "0 9 * * *"
metadata:            # free-form annotations; framework never interprets them
  draft: true
  owner: leon
subagents:
  - path: ./researcher.agentuse
    name: research
    maxSteps: 50
mcpServers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

## Choosing the Model and Thinking Budget

`model:` and thinking are the two knobs with the biggest effect on quality and
cost. Decide both on purpose, the defaults are rarely right. Validate every id
against `agentuse models` (the catalog moves).

**Model: pick by the hardest reasoning the agent actually does, not by how
important the agent feels.**

- **Top tier** (`anthropic:claude-opus-*`, full `openai:gpt-5.x`): the core is
  open-ended judgment, drafting under many competing constraints, multi-step
  planning, debugging, adversarial review, or orchestrating those. Wrong calls
  are expensive and the space is open, pay for it.
- **Mid tier** (`anthropic:claude-sonnet-*`): the sane default for most agents,
  strong reasoning at lower cost, well-specified multi-step work.
- **Small/fast tier** (`anthropic:claude-haiku-*`, `openai:gpt-5.x-mini`/`-nano`):
  mechanical or high-volume, classification, extraction, reformatting, running
  commands and collecting output, read-then-summarize.

Tier per role, not per project: a manager that only *selects* a move and
delegates can run a tier below the leaf that does the hard drafting. Don't
default everything to the biggest model, and don't starve the one agent doing
the real judgment.

**Thinking / reasoning effort: off by default, on for genuine judgment.**
Thinking tokens bill at **output rates**, so it is real cost, not free depth.
Turn it on where a single forward pass fumbles: a hard call under competing
constraints (honesty vs persuasion, voice vs brevity, choosing among imperfect
options), a build to plan, a bug to trace. Left off, such an agent tends to make
a defensible-but-wrong one-shot call and then oscillate once corrected.

- **Claude:** `anthropic.thinking.budgetTokens` (min 1024; nested under
  `anthropic:`, see gotcha). Rough bands: ~2-4k for a focused judgment call,
  ~6-8k for multi-constraint drafting or a build/plan, higher only if it still
  under-reasons. Streams into the session trace. Claude has NO effort *level* -
  `high`/`xhigh` are the OpenAI knob below, not a Claude setting.
- **OpenAI reasoning models:** `openai.reasoningEffort`
  (`minimal|low|medium|high|xhigh`; nested under `openai:`) instead of a token
  budget, `medium`/`high` for hard calls, `low`/`minimal` for mechanical.
  `xhigh` and `none` are OpenAI-only.
- Leave it off for mechanical, extraction, and read-only agents, budget there is
  cost for no lift.

Tell-tale it is off or too low: the agent makes defensible-but-wrong one-shot
calls and a human has to nudge it to the answer it should have reached. Too
high: latency and cost with no lift. Start moderate, tune on observed output.

## Authoring Checklist

- A concrete job the agent can finish without interactive supervision.
- `model:` set explicitly by role (see above); short `description:` if it may be
  listed or used as a subagent.
- Thinking budget decided, not defaulted: on for judgment/drafting/planning
  agents, off for mechanical/read-only ones.
- Tools and MCP servers declared in frontmatter, not assumed ambient.
- Inputs, outputs, destinations, and success criteria stated in the body.
- Multi-role work: subagents with clear names and `maxSteps` limits.
- Recurring work: YAML `schedule:` + a note that `agentuse serve` must run.
- Custom labels (draft, owner, team): put them under `metadata:`. It is the
  only place custom keys survive parsing; `agentuse agents` shows them as chips
  and `--json` exposes them under `.metadata` for filtering. Metadata is an
  annotation, not runtime input (it is not injected into the prompt).

## Write Lean: Hard-Code Invariants, Delegate Judgment

The prompt is a brief, not a manual. It is re-sent on every step, so length is
a recurring token cost and a long prompt buries the rules that matter. Pin down
only what must be exact:

- safety boundaries (read-only, never call X, which store to write),
- exact commands, paths, and flags the model cannot guess,
- the output schema and where it goes,
- ordering that changes the result.

For everything else, how to investigate, how to phrase, the long tail of edge
cases, state the goal and the constraint, then let the model decide. Spelling
out every branch makes the agent brittle on the case you did not enumerate.

Over-specification smells: the same rule in three places, a paragraph
justifying *why* a step exists, an enumerated decision tree derivable from one
sentence of intent. Write what a competent teammate needs, not a spec.

Skills are instructions, not tool grants: declare an agent's tools in
frontmatter even when a skill documents them with `allowed-tools`. Put reusable
instructions in `.agentuse/skills/<name>/SKILL.md` or install with `agentuse add`.

## Inline Charts in Agent Output

Agents that report numeric trends, comparisons, or funnels can embed charts by
emitting an `agentuse:chart` fenced block. The serve web session view renders
it as an inline SVG chart; every other surface (CLI, Slack, logs) sees the raw
JSON block, so only opt an agent in when its output is primarily viewed in the
web UI.

````markdown
```agentuse:chart
{
  "type": "bar",
  "title": "New subscribers by day",
  "categories": ["Jul 7", "Jul 8", "Jul 9"],
  "series": [{ "name": "Trials", "values": [12, 18, 9] }]
}
```
````

Rules: `type` is `bar` or `line`; `title` and `categories` (max 60) required;
1-6 `series`, each `values` array matching `categories` length, numbers only;
optional `yLabel` and `unit` (e.g. `"ms"`). Invalid payloads degrade to a plain
code block. Emit data, never styling; keep the most important series first; one
y-scale per chart (two measures of different scale → two blocks). Full spec:
`reference/chart-blocks` in the docs.

In the agent body, always pin the exact shape (the output schema is an
invariant, a bare "emit an agentuse:chart block" makes the model guess field
names like `data` instead of `values`):

> Include an agentuse:chart bar block for the funnel, exact shape:
> `{"type":"bar","title":"...","categories":["..."],"series":[{"name":"...","values":[1,2]}]}`

The runtime composes one prompt from layered sources, in this precedence
(highest first): **agent instructions → Learned Guidelines → Skills → other
reference files.** The system prompt's operational/safety rules sit above all of
these. This shapes where a rule belongs:

- Put **soft defaults** in skills. Don't bake a hard "never do X" into a skill
  that a learning should be able to override, a captured correction outranks a
  skill default, so an absolute skill rule fights the feedback loop.
- State a rule **once**, at the right layer, and reference it. The same craft
  rule copied into both a skill and the agent drifts; the lower-precedence copy
  then silently wins (this is the "same rule in three places" smell above, seen
  from the runtime side).
- `learning: true` (sugar for `capture + apply`) injects the agent's stored
  learnings every run, for delegated subagents too, not just top-level runs. So
  a leaf's prior-run corrections actually reach it; rely on that instead of
  hand-restating past corrections in the prompt.

## Gotchas

- **No builtin grep/glob.** Only `filesystem_read|write|edit` exist, and
  `filesystem_read` returns the whole file unless you pass `limit`/`offset`. For
  big or structured files, grant `grep`/`rg`/`jq` via bash and tell the agent to
  search, not slurp. A read agent given only `cat`/`ls` falls back to whole-file
  reads, the exact context blowup to avoid.
- **`filesystem_read` also reads images and PDFs.** PNG/JPEG/GIF/WebP and PDF
  files (detected by content, not extension) are returned to the model as the
  actual image/document, so an agent can read a chart, screenshot, or PDF
  directly. This only works on a model whose input modalities include
  `image`/`pdf` (Claude, GPT-4o, Gemini, etc.); on a text-only model the read
  returns an error instead. Size caps apply (images ~5MB, PDFs ~32MB); `limit`/
  `offset` are ignored for media.

- **Approval gates are async.** `approval: true` / `await_human` gates suspend
  the run; `timeout:` does not tick during the wait. Size `timeout:` for the
  active work between gates, not human response time.

- **Agents cannot prompt the user mid-run.** Never write "stop and ask the user
  to do X." The only branches at a blocker: exit with a clear error, record to
  the store and continue/stop, or fire an approval/notification. The approval
  gate is the only human-in-the-loop path.

- **Blocked runs declare themselves incomplete automatically.** The runtime
  system prompt already tells every agent to call the always-on
  `report_incomplete` tool at a blocker (dead login, missing precondition) and
  to open its final output with "✅ Complete:" / "⚠️ Incomplete:". Do NOT
  restate that mechanic in the agent body. Only add the domain judgment the
  runtime cannot know: which conditions count as blocked for THIS agent, and
  which empty results are an honest `completed` (e.g. "a sweep that scored
  notes but queued none is Complete; a sweep that never got to score because
  the session was logged out is Incomplete").

- **Validate models against `agentuse models`.** The catalog moves; check it
  before calling a name invalid. Don't infer limits from other providers'
  naming (e.g. "5.5 can't exist because provider Y stops at 5.2").

- **Provider tuning keys are nested, and a wrong-level key is silently dropped.**
  Claude thinking lives at `anthropic.thinking.budgetTokens`; OpenAI effort at
  `openai.reasoningEffort`. A **top-level** `thinking:` or `reasoningEffort:` is
  NOT a schema error, the root frontmatter strips unknown keys, so the agent
  parses fine and runs with the tuning **never applied** (no crash, no warning).
  If you set a thinking budget and see no change, check the nesting first. The
  nested provider blocks (`anthropic`/`openai`) are themselves strict, so a typo
  *inside* them does error, only the wrong *level* fails silently.

- **Defer to skills; don't inline their internals.** Reference a skill by name
  (`/linkedin`) and never copy its drift-prone internals (script paths, eval
  invocations, file layout). Do repeat the durable steps/context the run hinges
  on inline, since the skill may not load that turn. Rule: reference what
  changes, repeat what doesn't.

- **Skill scripts read via bash need explicit allowlists.** Grant
  `tools.filesystem` read on the skill dir (absolute path, `~` may not expand)
  and a narrow `bash.commands` like `cat /Users/<you>/.claude/skills/<name>/scripts/*`.
  Not a blanket `cat *`.

- **Match channel prose to the frontmatter key.** `channels.slack` is the key.
  Don't describe Slack delivery as `notifications.routes`; the body must name
  the key the frontmatter uses.

## References

Don't hardcode a doc list here, it goes stale. Fetch the canonical index and
load the specific page(s) you need:

```
https://docs.agentuse.io/llms.txt
```

It enumerates every current guide and reference page with a short description.
Pick the matching `.md` URLs and fetch them directly.
