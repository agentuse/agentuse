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
timeout: 600         # run ceiling: bare number = SECONDS, or "10m"
maxSteps: 100
reasoning: high        # provider-agnostic thinking effort: none|minimal|low|medium|high|xhigh. Opt-in, billed at OUTPUT rates; omit for the model default. (Advanced, exact control: anthropic.thinking.budgetTokens / openai.reasoningEffort.)
schedule: "0 9 * * *"
verify: true         # judge the output before it ships; string = rubric shorthand, or { criteria | judge, at, maxRedos }. See the judge gotcha below.
metadata:            # free-form annotations; framework never interprets them
  draft: true
  owner: leon
tools:
  bash:
    commands:        # auto-run, no approval
      - "birdc read *"
    gated:           # runs only once a human approves the exact command
      - "birdc reply *"
skills:
  auto: false        # prefer a closed catalog when the required skills are known
  creator:           # preload this specific skill
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

- **Primary knob: top-level `reasoning`** (`none|minimal|low|medium|high|xhigh`),
  provider-agnostic. AgentUse hands it to the AI SDK, which maps one level to
  each provider's native control (Anthropic thinking budget ≈ a % of
  maxOutputTokens; OpenAI reasoningEffort). `medium`/`high` for hard calls,
  `low`/`minimal` for lighter ones, omit for the model default, `none` to force
  it off. Reach for this - it works for Claude and OpenAI and avoids the nesting
  trap below.
- **Advanced escape hatches** (skip unless you need exact control): Claude
  `anthropic.thinking.budgetTokens` (an exact token budget, min 1024) and OpenAI
  `openai.reasoningEffort`. Honored only when top-level `reasoning` is
  unset, so the two never double-apply.
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
- Irreversible bash commands (post, send, delete, deploy) listed under
  `tools.bash.gated`, not just fenced off in the prompt.
- Plain gated actions rely on the runtime's single-gate pattern: emit
  `await_human` and the exact gated command together, then re-issue the command
  only after approval. Pick-one-of-N gates list one exact command per
  `changes[]` entry with `optionId` bound to the matching `options[].id`. When
  the entry's `content` is a command, set `displayContent` to the exact
  human-facing post/message/body so reviewers see the business content first;
  the command remains visible inside that option as secondary audit detail.
- Known skills listed explicitly; prefer `auto: false` when the agent does not
  need to discover arbitrary skills at runtime.
- Inputs, outputs, destinations, and success criteria stated in the body.
- Every body rule placed on purpose: about this job, not about a tool or a past
  run (see Pick the Layer Before You Write the Rule).
- Multi-role work: subagents with clear names and `maxSteps` limits.
- Recurring work: YAML `schedule:` + a note that `agentuse serve` must run.
- Custom labels (draft, owner, team): put them under `metadata:`. It is the
  only place custom keys survive parsing; `agentuse agents` shows them as chips
  and `--json` exposes them under `.metadata` for filtering. Metadata is an
  annotation, not runtime input (it is not injected into the prompt).
- Validated before real use: `agentuse doctor <file>`, then `agentuse test
  <file>` and a session-log review. Load the `tester` builtin skill for the
  workflow.

## Goals for Judgment Agents, Procedures for Compliance Agents

The runtime treats agent instructions as authoritative (top of the guidance
precedence ladder), so the body's *shape* sets how much judgment the model
exercises. A numbered SOP laced with "MANDATORY / no exceptions / don't
improvise" gets literal step-following on any model tier: putting Opus behind
one buys top-tier reasoning and then forbids using it.

Pick the shape by where the agent's value lives:

- **Judgment-heavy** (drafting, planning, review, debugging): state the goal,
  the context to load, and the hard constraints, then explicitly hand over the
  open decisions ("angle, structure, and length are your call; deviate from
  the template when the content earns it"). Reserve MANDATORY/STOP wording for
  true invariants: save paths, output schema, irreversible actions,
  missing-precondition errors.
- **Compliance-heavy** (scanners, trackers, report generators): a strict
  procedure with a pinned output schema is correct; determinism is the point.

The same split applies to tools: the frontmatter allowlist is the real
capability ceiling, and no prompt wording can widen it. Scope a compliance
agent tightly; give a judgment agent the read surface and search commands it
needs to explore (see the grep gotcha below).

Prompt wording cannot *enforce* a boundary either. "Never post without
approval" in the body is guidance the model usually follows; listing the
posting command under `tools.bash.gated` makes it mechanically impossible,
blocked pre-dispatch until a human approves that exact command. Gate the
irreversible verbs (post, send, delete, deploy) and leave the reads auto-run.
Note that a wildcard tail grants what it does not name: `birdc *` grants
`birdc reply`, so gate the effectful subcommands explicitly (gated wins over
`commands`, so the broad entry cannot un-gate them). You do not restate the
approval protocol in the body; declaring `gated` injects it, and implies
`approval:`.

## Write Lean: Hard-Code Invariants, Delegate Judgment

Treat the body as a recurring prompt cost. Write compressed, not crammed.

Keep only:

- safety boundaries and irreversible-action gates,
- exact commands, paths, fields, and status values the model cannot infer,
- ordering that changes the result,
- inputs, output schema, destination, and success criteria.

Route everything else:

- reusable platform/tool mechanics -> a skill,
- dated failures and reviewer corrections -> learned guidelines,
- author rationale and operating notes -> `metadata:` or a companion `ABOUT.md`,
- examples -> keep only when they disambiguate a rule.

Use controlled shorthand:

- One invariant or branch per line.
- Prefer imperative fragments: `Read scoreboard first.`
- Prefer compact flow: `Draft -> approve -> post -> verify.`
- Drop articles, pronouns, transitions, and repeated rationale.
- Keep full grammar where negation, condition, order, or scope could blur.
- Never pack multiple policies and exceptions into one long paragraph.

Good:

```markdown
1. Read scoreboard unless the manager supplied `soft_bias`.
2. Select one fresh, in-lane target.
3. Draft 1-2 sentences; add one new insight.
4. Save as `awaiting_approval`.
5. Request approval; when the post command is bash-gated, emit that exact
   command alongside the plain gate for runtime attachment. Otherwise gate alone.
6. Explicit approval -> post, verify ID, mark `posted`.
7. Otherwise -> mark `rejected` or `needs_revision`; never post.
```

Run a compression pass after every substantive edit:

1. Remove duplicated rules, incident history, and derivable branches.
2. Move reusable mechanics and learnings to their proper layers.
3. Split dense lines; preserve unambiguous negation, conditions, order, scope.
4. Run `agentuse doctor <file>`.

Size guidance is advisory, not a parser limit:

- Over 1,500 body words: compress before handoff.
- Over 2,500: split/reference or record why the complexity must stay inline.
- Over 800 characters on one line: usually multiple rules; split it.

The agent body is not the whole per-request prompt. `agentuse doctor` also
prices the skill surface, which recurs on every model request:

- Preloaded skills ship their full text. Over ~2,000 tokens: preload only what
  every run needs. Over ~4,000: drop the situational ones and let the agent load
  them on demand.
- The visible catalog ships one name and description per discovered skill. Over
  ~1,500 tokens: close discovery. Over ~3,000: the catalog likely costs more than
  the agent body.

Over-specification smells: the same rule in several layers, history embedded in
an invariant, rationale longer than the rule, or a decision tree derivable from
one sentence of intent. Write what a competent teammate needs, not a manual.

## Pick the Layer Before You Write the Rule

The runtime composes one prompt from layered sources, in this precedence
(highest first): **agent instructions → Learned Guidelines → Skills → other
reference files.** The system prompt's operational/safety rules sit above all of
these.

Knowing that ladder does not place a rule. Ask three questions before typing one
into an agent body:

1. **Is it true of the job, or of the tool?** Of the job → the body. Of the tool
   → the skill. A correction from one specific run → learnings.
2. **Does the line only work by contradicting a lower layer?** Then it is not a
   rule, it is a patch over the wrong layer: fix the layer that says the
   opposite. (Body: "do not read the tool's docs." That tool's skill: "load the
   docs before doing anything.") A body line outranks a skill, so the patch
   appears to work and the shared cause stays broken.
3. **Would you write it again in the next agent that uses this tool?** Then it is
   not an agent rule. One body cannot fix what every caller pays.

Most wrong-layer rules come from fixing a symptom in whatever file is already
open: the symptom surfaces in one agent, the cause sits in the skill they all
share.

**When no layer can hold it: the runtime gap.** Sometimes the body is
compensating for a runtime limit, e.g. an allowlist that cannot express the
command shape a skill documents, or a knob that does not exist. The patch stays
in the body, because it has to live somewhere. What must not happen is that it
reads as a rule, because then it is copied into the next agent, mutates, and is
never removed when the limit is lifted. Two moves keep it honest:

- **Say what it works around, in `metadata:`.** Free-form, never interpreted,
  never injected into the prompt, still visible in the file, and queryable via
  `agentuse agents --json`. Not a body comment: the body IS the prompt, and the
  model obeys imperatives inside `<!-- -->`.
- **File the gap once**, at https://github.com/agentuse/agentuse/issues, so it
  can be closed and the patch deleted. If it is not worth filing, it is not a
  gap: the line is permanent behavior, and stop calling it a workaround.

The tell that you are looking at one: the line describes what the harness does
rather than what the job is. Ask whether it would be false or pointless if the
runtime changed.

- Put **soft defaults** in skills. Don't bake a hard "never do X" into a skill
  that a learning should be able to override, a captured correction outranks a
  skill default, so an absolute skill rule fights the feedback loop.
- State a rule **once**, at the right layer, and reference it. The same craft
  rule copied into both a skill and the agent drifts; the lower-precedence copy
  then silently wins (the "same rule in several layers" smell above, seen from
  the runtime side).
- `learning: true` (sugar for `capture + apply`) injects the agent's stored
  learnings every run, for delegated subagents too, not just top-level runs. So
  a leaf's prior-run corrections actually reach it; rely on that instead of
  hand-restating past corrections in the prompt.

## Scope Skills Deliberately

When an agent relies on known skills, list them explicitly and prefer a closed
catalog:

```yaml
skills:
  auto: false
  x-personal:
```

The named skills are preloaded. `auto: false` hides every unlisted discovered
skill, reducing the catalog repeated on each model request and making runtime
selection more deterministic. Leave discovery open only when the task genuinely
needs to choose among skills that were not known at authoring time:

```yaml
skills: [x-personal] # preloads x-personal; all discovered skills remain visible
```

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

- **The built-in verify judge has no tools and sees only the output text.** At
  `at: gate` (the default when the agent has an approval gate) that text is the
  rendered `await_human` payload, so any criterion about an artifact on disk is
  really judged against the author's *account* of it. A faithful payload passes
  and a paraphrasing one fails on an artifact that was correct all along; worse,
  a flattering payload passes a broken artifact silently. When the criteria
  describe a file, point `judge:` at a `.agentuse` file instead of writing
  `criteria:` (the two are mutually exclusive, and `model:` is invalid with
  `judge`). That judge gets its own model and tools per its frontmatter, so give
  it read-only filesystem access and let it open the artifact. Put its rubric in
  its body: the runtime passes it `Apply the evaluation standard defined in your
  own instructions.` as the criteria. The runtime also injects a `submit_verdict`
  tool and the instructions for calling it, so do NOT restate that protocol in
  the judge body (same rule as `report_incomplete` below) - write only the
  domain bar the runtime cannot know. A judge must not carry `approval:` (a
  suspended judge counts as a judge error).

- **Timeout units: bare numbers are seconds on every field EXCEPT
  `tools.bash.timeout`, where they are rejected entirely** (the field was
  historically milliseconds, so a bare number is ambiguous). Write duration
  strings, accepted on every timeout field: `timeout: "10m"`,
  `tools.bash.timeout: "30s"`, `approval: { timeout: "24h" }`,
  `toolTimeout: "2m"`. The bash tool's per-call `timeout` parameter still takes
  bare MILLISECONDS (or a duration string); bare per-call numbers under 1000
  are rejected with a corrective error.

- **Agents cannot prompt the user mid-run.** Never write "stop and ask the user
  to do X." The only branches at a blocker: exit with a clear error, record to
  the store and continue/stop, or fire an approval/notification. The approval
  gate is the only human-in-the-loop path. Corollary for runtime input: parse
  whatever the appended prompt gives (a bare arg, a comma-/space-separated list,
  a `key:` label) and proceed - one value is valid input. An agent that "asks to
  confirm" the input just stalls.

- **Frontmatter must be the first bytes of the file.** Any content above the
  opening `---` - a `#` heading OR an HTML `<!-- -->` comment - makes the parser
  (`gray-matter`) miss the frontmatter and fail with `Invalid agent
  configuration: model: Required`. `agentuse doctor <file>` catches this in ~1s
  for free; run it before any token-heavy `agentuse test` / `--mock` run.

- **The body IS the prompt; nothing strips comments.** `matter()` splits off
  only the frontmatter; everything after becomes the agent's `instructions`
  verbatim. A `<!-- ... -->` block after the frontmatter parses fine but is fed
  to the model, and the model will obey any imperative inside it (verified: a
  hidden marker in a body comment reached the model; a `metadata:` marker did
  not). So don't use `<!-- -->` for notes. Route by audience: author/tooling
  pointers (`about`, `docs`, `repo`) → `metadata:` frontmatter (free-form, never
  interpreted, never in the prompt, still visible in the file); longer
  human-facing docs for a published artifact (e.g. a gist) → a companion
  `README.md` published alongside (`gh gist create agent.agentuse README.md
  --public`), which GitHub renders and which never touches the prompt.

- **Agents run from a URL; state does not follow them.** `agentuse run <url>`
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

- **`reasoning` is top-level; the exact provider budgets are nested, and a
  wrong-level key is silently dropped.** Prefer top-level `reasoning` and
  you sidestep this. The escape-hatch controls are nested: Claude budget at
  `anthropic.thinking.budgetTokens`, OpenAI at `openai.reasoningEffort`. A
  top-level `thinking:` (or a provider key at the wrong level) is NOT a schema
  error, the root frontmatter strips unknown keys, so the agent parses fine and
  runs with the tuning **never applied** (no crash, no warning). If you set an
  exact budget and see no change, check the nesting first. The nested provider
  blocks (`anthropic`/`openai`) are themselves strict, so a typo *inside* them
  does error, only the wrong *level* fails silently.

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

## Patterns

- **Inline script vs persistent.** For a one-off (verify a deploy, audit a
  metric), have the agent write its script to `tmp/` at runtime and run it - one
  file, the spec lives in the agent body. Commit a persistent `agents/<name>.py`
  only when a caller other than this single agent will reuse it (a repeated
  workflow, CI, a scheduled job). Default to inline.

- **Config with runtime override.** To bake in a canonical value but allow
  per-run overrides, resolve the effective value in Steps as: (1) a runtime
  override from the appended prompt if present, else (2) the Configuration value,
  else (3) refuse on the placeholder and stop. Lets you commit the default
  without blocking ad-hoc runs.

- **Aggregating over a store: read the file via a script, don't slurp.** The
  store is a local JSON file (`.agentuse/store/<name>/items.json`). An agent that
  filters or aggregates over dozens of items must NOT do it via `store_list` +
  in-context reasoning: a field-projected list over ~20 wordy items can exceed
  the ~30KB tool-result limit and come back truncated, and re-deriving the filter
  in prose can hit the model's output-token cap mid-run. Grant the store file as
  a read-only filesystem path, have the agent write a stdlib script to `tmp/`
  that reads it and prints ONE compact JSON result (the queue, the aggregate, the
  exact `store_update` payload). All store WRITES still go through the store tools.

- **Discovery/harvest agents write keepers as they go.** An agent that sweeps
  many surfaces and only writes its store items at the end loses everything if it
  hits a step cap or the output-token cap mid-run. Persist each keeper
  (`store_create`) the moment it is classified, hard-cap the surface count per
  run, and keep responses terse (never restate harvested text; extraction evals
  return compact arrays). Put this in the agent body, not just learnings.

## References

Don't hardcode a doc list here, it goes stale. Fetch the canonical index and
load the specific page(s) you need:

```
https://docs.agentuse.io/llms.txt
```

It enumerates every current guide and reference page with a short description.
Pick the matching `.md` URLs and fetch them directly.
