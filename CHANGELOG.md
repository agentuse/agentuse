# Changelog

## [Unreleased]

### Added

- **`agentuse test`: closed-loop agent validation in one command.** `agentuse test <file>` runs an agent in mock mode with side effects fabricated, approval gates auto-resolved (deterministic approve by default; `--approval reject` / `comment:<text>` exercise the other branches), and stores isolated. Scope is adaptive: agents declaring `tools.bash.gated` get **gated scope**, where only those fenced-off commands are fabricated and every other tool (reads, non-gated bash, MCP, skills) runs for real, so the run grounds itself in real project state while completing end-to-end, unattended, with zero irreversible side effects; agents without gated patterns get full mock. Override with `--scope gated|all`. The session log shows the full gate flow for review (the `await_human` call with its `changes[]`, the deterministic approval, the fabricated command result, identifiable in the effect WAL by a `lease-approved` entry with no `bash-spawn`), and gate enforcement fidelity is preserved: a gated command issued without an approved gate is still denied pre-dispatch with the re-gate redirect. Requires a mock model (`--mock-model` or `AGENTUSE_MOCK_MODEL`); `run --mock` remains as low-level plumbing. Env: `AGENTUSE_MOCK_SCOPE=gated`.
- **Mock runs stay out of the operational views.** Mock/test sessions are excluded by default from every list-backed serve surface (home latest-results and failure-triage panels, agent health/sparklines, the sessions list and its SSE stream) so dashboards reflect only real runs, and terminal-state push notifications are suppressed for them (a test loop no longer buzzes the phone once per iteration). They remain fully stored and inspectable: the sessions view gains a "mock runs" filter (`hidden`/`shown`/`only mock`, API `?mock=include|only`), session detail pages stay reachable by id, and the CLI keeps listing them marked `· mock` (hide with `sessions list --no-mock`).
- **Stores are isolated under mock runs.** A mock/test run never touches the real store (cross-run agent memory: dedup keys, baselines, and the reserved `metrics` store behind dashboards): every store is re-rooted at `<projectRoot>/.agentuse/store-mock/<run-id>/`, seeded by copying the real store on first use, so reads see real state, writes read back consistently, and nothing persists into production state. The scratch dir is kept for post-run inspection and old ones are swept after 7 days.

- **Mock runs are visibly marked in the sessions CLI**: `agentuse sessions` appends a `· mock` suffix to the status column and `sessions show` prints a `Mock:` warning line, so a fabricated test run can never be mistaken for a real one when reviewing history (the flag was previously stored and exposed via the JSON API but invisible in the text views).
- **`agentuse doctor` prices the whole per-request prompt, not just the agent body.** Preloaded skills are appended to the instructions in full at run time, so their cost was invisible: doctor now reports each preloaded skill's token cost (heaviest first) and a total across agent body + preloaded skills + visible catalog. Warnings match the existing body-size advice: preloaded skills over ~2k tokens (~4k for the stronger warning), or a visible catalog over ~1.5k (~3k), with the fix pointed at `auto: false` for open discovery or a shorter list for a closed one. An agent with open discovery on a machine with 100 skills installed pays ~11k tokens per model request for the catalog alone, and nothing surfaced that before.
- **`tester` builtin skill**: version-matched instructions for validating agents without real side effects (`agentuse skills get tester`), covering mock-mode selection, unattended approval-gate testing, the closed edit-run-inspect loop, and its fidelity caveats. The `core` catalog, `runner` command reference, and `creator` authoring checklist point to it, so coding agents working on `.agentuse` files discover the workflow from the CLI itself.

### Changed

- **`--mock-approval` is now deterministic and completes gated flows end-to-end.** Instead of letting the mock LLM improvise a reviewer reply, the `await_human` gate resolves inline with a scripted decision. `--mock-approval` (or `--mock-approval approve`) auto-approves and grants the gated-command lease derived from the gate's `changes[]` exactly like a real reviewer approval, so `tools.bash.gated` flows now run to completion under `--mock` (previously the fabricated approval granted no lease, leaving gated commands denied with no reviewer to ever satisfy). `--mock-approval reject` seals the gate terminally to exercise the agent's cleanup path, and `--mock-approval comment:<text>` forces the revise-and-re-gate branch on the first gate then approves the re-gate, so the run exercises the revision path and still finishes (repeating the comment on every gate looped an obedient agent through identical re-gates until it gave up). Pick gates auto-select the recommended option (else the first) and return it as `choice`. Decisions are journaled to the effect WAL as `mock-gate-decision`, mocked-approval runs no longer require a running `serve` daemon (nothing ever suspends), and sub-agent gates resolve the same way (previously the sub-agent rebuild silently restored a real suspending gate).

### Fixed

- **A skill's `metadata` no longer has to be flat strings.** Skill frontmatter `metadata` now accepts nested values (`Record<string, unknown>`), matching what `AgentSchema` has always allowed for agent frontmatter. This is deliberately laxer than the Agent Skills spec, which defines `metadata` as "a map from string keys to string values": because we also discover `.claude/skills/` and `~/.claude/skills/` for Claude-ecosystem compatibility, we inherit skills that park another tool's nested config there (e.g. `metadata.openclaw`) and that Claude Code itself loads without complaint. Since rejection was all-or-nothing, holding an opaque annotation we never read to the strict shape made the **whole skill invisible to every agent**, with nothing but a `[WARN] Invalid skill` line to explain the absence. Being liberal in what we accept for a field the runtime never interprets costs nothing.

## [0.16.0] - 2026-07-28

This release turns `serve` into a live operations dashboard: installable and push-capable on mobile, centered on outcomes and recorded business metrics, with failed-run triage, agent relationship graphs, richer approval review, and an experimental verification loop that can critique and redo work before delivery. Under the hood, the model registry now carries real context and output limits for every provider (fixing premature compaction and silently truncated responses), `filesystem_read` gains image/PDF input, and a failed compaction no longer silently ends a run. Timeout units are unified: every timeout field accepts duration strings (`"30s"`, `"10m"`, `"24h"`), and the one milliseconds-based config field, `tools.bash.timeout`, no longer accepts bare numbers (**breaking**; one-line migration, see Changed). Approval gates, verify, the session/approval web UI, the JSON API, channels/Slack, and web push remain **experimental**: configuration, route shapes, UI details, and API response formats may still evolve based on production feedback.

### Added

- **Web push notifications for approvals and session completions**: the `serve` daemon now implements Web Push with no new dependencies (RFC 8291 `aes128gcm` payload encryption and RFC 8292 VAPID auth on `node:crypto`, verified against the RFC test vector). VAPID keys and per-device subscriptions persist under the XDG data dir, and dead subscriptions are pruned on 404/410. A root-scope service worker (`/sw.js`) and gated `/api/push/*` subscription routes back per-category notification bells on the Approvals and Sessions headers; the first tap chains worker registration, the permission prompt, subscription, and server registration inside the single user gesture. Pushes fire on new approval requests (deduped alongside the approval log) and on session terminal states via a new best-effort runner poke (`POST /sessions/:id/finished`, validated against storage and the session-view token). iOS Safari tabs get an install-to-home-screen explainer, and a denied permission gets a how-to-unblock dialog.
- **Declarative Web Push and reliable deep links on iOS**: there is no service-worker workaround for the killed-app case on iOS (`notificationclick` logic does not take effect when a terminated home-screen app is launched from a notification), so payloads now use the Declarative Web Push envelope (`web_push: 8030` with `title`/`body`/`tag` and an absolute `navigate` URL) and iOS 18.4+ performs the tap navigation at the OS level without running the worker; browsers without declarative support fire the regular `push` event and render the same fields. Cold launches also deep-link correctly: iOS opens a home-screen app at `start_url` and ignores the URL passed to `clients.openWindow`, so the tap handler parks the target URL in the Cache API and the app consumes it at boot (with a 2-minute freshness window and a brief retry to beat the cold-launch cache-write race), while warm windows are focused and told to navigate via `postMessage`, matched by session path so an open session tab is reused instead of duplicated. Service-worker updates now activate on next open (`skipWaiting` + `clients.claim`) instead of after a full swipe-away.
- **Pending-approvals badge on the installed app icon**: approval pushes carry `app_badge` with the total pending count; iOS 18.4+ applies it from the declarative payload at the OS level, and the service worker mirrors it via `setAppBadge` on imperative platforms. On-device testing showed iOS 18.7 ignores `app_badge` nested inside the `notification` member but honors it at the top level of the envelope, so it is emitted in both placements. The badge is floored at 1 on approval pushes (the pending-count query can race the runner's announcement and report 0, and an approval push means at least one approval is pending by definition), and the app corrects the count whenever it learns the truth: the approvals list syncs and clears the badge from live data, and deciding an approval on the session page resyncs it best-effort.
- **Web app install support**: a web app manifest, PNG home-screen icons (180/192/512), and install meta tags enable Add to Home Screen on iOS Safari and install on Android. Icons and the manifest are served pre-auth (like the favicon) so install works from token-only session links. Pre-compressed assets, module preloads, subsetted fonts, and a cache-first service worker make repeat loads fast and offline-capable; history-aware back navigation, stale-cache recovery, responsive tables, touch feedback, and automatic foreground reconnects make the installed UI behave more like a native app.
- **Image and PDF input via `filesystem_read`**: reads of PNG/JPEG/GIF/WebP images and PDFs now reach the model as real media parts instead of utf-8 mojibake, so vision and document tasks work headlessly. File type is detected by magic bytes (not extension); text reads stay byte-for-byte unchanged. Media is emitted only when the model's registry modalities accept the kind AND its wire can deliver it in a tool result (native OpenAI now uses the Responses API so tool-result media works; custom base URLs stay on Chat Completions; otherwise a clear text error, so OpenAI-chat/OpenRouter never get base64-as-text and Bedrock never crashes on a PDF). Size caps apply (~5MB image, ~32MB PDF, with an actionable error), the session store never inlines multi-MB base64 (a session-owned media cache externalizes bytes on context-snapshot write and rehydrates on resume), and context accounting redacts base64 before token estimation and the compaction summarizer, so an image counts as ~1.6k tokens rather than its base64 length.
- **Free-form `metadata` frontmatter**: `AgentSchema` accepts an optional `metadata:` record (opaque, never interpreted), the sanctioned home for custom keys that were previously stripped. `agentuse agents` renders top-level keys as chips (bare key for `true`, `key=value` for scalars, falsey omitted) and passes the full object through `--json` for filtering.
- **Configurable agent-list columns in the `serve` web UI**: agent metadata flows through the agents API, and the agents view manages its own columns: Schedule, Run, and one column per metadata key are addable/removable via pills, with the active ordered set persisted to localStorage and synced across tabs. Full metadata also shows in the agent kebab popover and the detail page; narrow screens collapse to the Run column with the rest in the overflow menu.
- **`maxOutputTokens` frontmatter field**: an explicit per-response output-token override (clamped to the model's real limit) for agents that must emit a large single response.
- **`tools.bash.gated`: mechanically-enforced approval for irreversible commands**. A new bash config key names command patterns that are *allowed but must clear an approval gate first*. The effective allowlist is `commands ∪ gated`, and `gated` wins on overlap, so a broad family like `birdc *` (listed or trust-granted) can auto-run while `gated: ["birdc reply *"]` holds `birdc reply` behind approval. Enforcement is a **lease, not a prompt**: a gated command runs only when its exact complete shell command is present in the latest approved `await_human` `changes[]`; approving payload text alone does not authorize another target or command family. A model therefore cannot stream `await_human` + `bash("birdc reply …")` in a single step and slip the post through before the human answers (the pre-approval "ghost-post" class). An uncovered gated match is auto-denied with a redirect to re-request via `await_human`, and any tool call streamed as a sibling of `await_human` in the same step is denied so the gate rides alone. Declaring `gated` implies `approval: true` (derived at parse time unless `approval`/`tools.await_human` is already set). `agentuse doctor` and the `serve` agent view surface the gated patterns, and doctor's `looksEffectful` heuristic *advises* (never enforces) when a plain `commands` entry looks irreversible enough to consider gating. Replaces the never-released `effects:` key.
- **Experimental output verification and critique-informed redo**: `verify` can use a built-in rubric or a dedicated `.agentuse` judge to inspect the final output, record a pass/fail verdict in the session, and feed actionable critique back into the same run for up to `maxRedos` revisions before delivery. Approval agents default to verifying the gate payload before it reaches the human (`at: gate`), while other agents verify the final output; `at: both` enables both placements. Dedicated judges run as inspectable child sessions and submit a typed verdict through `submit_verdict`, so commentary cannot be mistaken for the decision. Verdicts appear in the web session log and `agentuse sessions show`; exhausted failures ship with a visible needs-attention marker, while judge errors fail open instead of deadlocking delivery.
- **Richer, immutable approval review**: `await_human` gains structured `changes`, `reference`, `options`, and `artifact_paths` fields. Agents can ask the reviewer to choose among labeled alternatives (including a recommended option) and receive the selected id as `toolResult.choice`, while change/reference cards keep the exact proposed action and target legible. Local files mentioned anywhere in the gate payload are detected automatically, and referenced media is content-addressed and snapshotted into the session at gate time so the reviewer approves the exact bytes that will be used even if the working file later changes. Images render inline; MP4/WebM/MOV/M4V video and MP3/M4A/WAV/OGG audio use native players with HTTP Range streaming and a 512MB media cap.
- **Outcome-first operations dashboard**: the `serve` home page now streams running agents, pending approvals, recent failures, latest results, upcoming schedules, and recorded metrics instead of presenting static navigation cards. Viewers can hide and reorder sections and metric tiles, choose result windows and chart displays, and opt into the raw activity feed; preferences stay local to the browser. Session and agent views add live output tickers, health/sparklines, feed and card layouts, search/filter/group controls, friendly names, run-new-session actions, consistent loading states, and summary-first ended-run pages. Failed runs have a separate **Needs a look** triage axis with dismiss/review state rather than being mixed into the execution-status filter.
- **Deterministic business metrics**: `tools.metrics: true` adds `record_metric`, which writes count/value/unit facts to the reserved `metrics` store with runtime-stamped agent and session provenance. Records upsert on `(sessionId, metric)`, so resume and retry paths cannot double-count a run. The home dashboard rolls these records into configurable result tiles and charts, and session result cards show the metrics produced by that run.
- **Agent relationship graph and advisory ordering**: agents can declare `dependsOn` frontmatter for cross-run ordering guidance. The agents API exposes dependency, subagent, shared-store, and lint relationships, and the web UI renders them as an interactive graph with clustered entry paths, health/run state, manager badges, shared-store labels, and warnings. The declaration is advisory, it documents and visualizes orchestration but does not serialize schedules.
- **Explicit incomplete outcomes**: every agent receives `report_incomplete(reason)` for cases where execution succeeded technically but the objective could not be delivered, such as an expired login or unavailable dependency. The run finishes its bookkeeping and report, then persists as `INCOMPLETE`, emits failure rather than completion notifications, and shows a distinct incomplete status and reason in CLI and web views instead of a misleading green success.
- **Manual learning rules with provenance**: approval comments and ended-session controls can turn reviewer instructions into durable agent learnings without requiring automatic `learning.apply`. Manual rules are distilled against the run context, carry their originating session and source, and appear in a dedicated session/agent Learnings UI rather than as noisy log rows. `--remember` uses the accompanying comment by default, and agent detail pages separate History, Learnings, and Source.
- **Provider-independent reasoning control**: top-level `reasoning: none|minimal|low|medium|high|xhigh` maps to the selected provider's native reasoning control, giving OpenAI and Anthropic agents one common setting while preserving provider-specific escape hatches for exact tuning. The resolved configuration is logged at debug level, and Anthropic cache breakpoints are bounded so reasoning does not accumulate a new breakpoint on every step.
- **Per-tool token attribution and skill overhead diagnostics**: tool steps persist their input/output token usage and surface it on web session logs, making expensive calls identifiable inside a run. `agentuse doctor` also reports the prompt-token cost of the discoverable skill catalog.
- **Configurable deployment identity and disclosure**: an `ABOUT.md` can label and describe a project or directory, `serve.brand.name` and `serve.terms` customize dashboard identity and project/folder nouns, and `hideAgentSource` removes raw `.agentuse` source from both the dashboard and API for demos or client-facing deployments. A dedicated Settings page centralizes appearance, push controls, cache recovery, and their failure feedback.
- **Tool-call intent phrases**: every tool schema now carries an optional `intent` parameter, injected as the schema's *first* property, where the model states in one short phrase what each specific call is trying to achieve ("Running runner tests to verify the resume fix"). The phrase becomes the call's activity label everywhere: the CLI renders `badge · intent · args`, and the serve session view promotes it to the tool row's primary text with the tool chip demoted to trailing metadata, so a session log reads as a narrative of goals instead of a list of tool names, and a mismatch between a declared intent and the actual call args is visible at a glance. First-property placement means the phrase streams in before the (possibly large) real arguments, so a running call is labeled while it executes. The parameter is presentation-only: it is stripped before dispatch (the real tool, bash or MCP server, never sees it), recorded in the session's tool input (surviving suspend/resume), excluded from the doom-loop detector's identical-call comparison (varied wording cannot mask a loop), and excluded from the input dump in the session view (no duplication). Injection covers Zod and JSON-Schema (MCP) tool schemas, preserves strict/required semantics, and skips tools that carry their own story (`await_human`, `report_incomplete`, subagent calls) plus any tool that already declares its own `intent` parameter. On by default; `intent: false` frontmatter opts an agent out.
- **Live tool output in the session view**: a long-running `bash` call no longer shows only a spinner and its input. Its stdout and stderr are teed as they arrive (interleaved in terminal order) and the newest few KB are written onto the running tool part on a throttle, so the web session log tails a build, deploy, or test suite while it executes instead of going silent for fifteen minutes. The tail is human-only: it lives in the tool state's metadata rather than the model-facing output, so it costs no tokens and cannot reach rehydrated history; it is bounded (~4k chars, since a part file is rewritten whole on every update) and starts only once a call has run past ~2s, so ordinary fast commands publish nothing. It is dropped the moment the call settles (replaced by the real output, never stranded on a finished row), and a write already queued when the call ends cannot flip a settled part back to running. Running rows open themselves to show the tail, but that is now a default rather than a lock: a reviewer can collapse a running row (the Hide control on one was previously a no-op), an explicitly opened row stays open after the call finishes, and an untouched row closes itself so a completed command's output is not left wedged in the stream. The tail block is height-capped with its own scroller pinned to the newest line, so a command that prints for ten minutes never grows the page.
- **Push-probe diagnostic script**: a dev helper that captures and decrypts what a live daemon fans out (mock device using the RFC 8291 test keypair) and sends crafted payload variants directly to a real device subscription using the daemon's VAPID keys; its header documents the on-device iOS findings behind the fixes above.

### Changed

- **BREAKING: `tools.bash.timeout` no longer accepts bare numbers - write a duration string** (`timeout: 120000` → `timeout: "2m"`). This was the one config field measured in milliseconds while every sibling timeout uses seconds, so a bare number was ambiguous by construction: keeping the ms reading meant `timeout: 30` killed every command at 30ms, and flipping the unit later would have turned an existing `120000` into a silent 33-hour timeout. The ambiguous form is now simply invalid. The rejection is a hard failure via a new `ToolConfigError` class: the run STOPS with a corrective error naming both readings (`"120s" if 120000 was milliseconds, or "120000s" if it was seconds`) instead of the previous behavior where a tool-load failure was downgraded to a warning and the agent silently ran without its bash tool. Other (transient) tool-load failures keep the warning path. Migration is one line per agent; each rejection also emits an anonymous `timeout_unit_error` telemetry event (surface: config vs tool_call, plus the rejected value) so the real-world migration cost of this break is measurable.
- **Every timeout field accepts suffixed duration strings** (unit unification). All user-facing timeout fields (`timeout`, `sandbox.timeout`, `mcpServers.*.toolTimeout`, `tools.bash.timeout`, `approval.timeout`) accept duration strings like `"30s"`, `"10m"`, `"24h"`, `"500ms"` via one shared parser; bare numbers keep their seconds unit on every field that allows them. Invalid durations fail at parse time instead of silently producing a near-zero timeout. The bash tool's model-facing per-call `timeout` parameter also accepts duration strings; it keeps bare-milliseconds for model familiarity, but a bare per-call number under 1000 is rejected with a corrective error instead of killing the command at N milliseconds - the seconds-vs-ms guess that used to waste a whole run now self-heals on the model's next call (a real sub-second timeout is still expressible as `"500ms"`).
- **Skill trust now grants a skill's declared commands, and listing a skill preloads it without hiding the rest** (breaking). Two changes to the `skills` config, both reversing 0.15.0 behavior. (1) **Trust is real**: `skills: trusted` (or per-skill `linkedin: trusted`) now *grants* the `Bash(x:*)` commands a skill declares in its `allowed-tools` as runnable `x *` allowlist patterns, so a trusted skill's commands run without re-listing them in `tools.bash.commands`. In 0.15.0 trust granted nothing new (it only let a skill use tools already configured on the agent). Trust only grants; gating stays your explicit call via `tools.bash.gated`, which wins over a trust-granted family (trust grants `birdc *`, but `gated: ["birdc reply *"]` still routes reply through approval), and `agentuse doctor` flags granted commands that look irreversible so you know what to consider gating. (2) **Listing preloads, it no longer hides**: `skills: [linkedin]` now preloads the listed skills while keeping discovery on, so unlisted skills stay loadable on demand ("these are the skills I use," not "forbid all others"). Restricting to a closed set is now an explicit `auto: false` in the map form (`skills: { linkedin:, auto: false }`) instead of a bare list silently hiding every other skill. The map form likewise defaults to open, so trusting one skill no longer secretly disables discovery of the others.
- **Model registry rebuilt as the full models.dev catalog with real limits for every provider** (major reliability fix). The registry was a 26-model curated list that doubled as the context-limit source: per-line dedup could collapse a pinned model out of the list entirely, and any model missing from it fell back to a 32k window, so runs compacted prematurely at approval gates (the root cause of a production incident). `MODELS` is now the full models.dev catalog (limits + validity) while `SUGGESTED_MODEL_IDS` remains the curated flagship lineup used only for fuzzy suggestions and docs. Provider coverage is dynamic via a single canonical `REGISTRY_PROVIDER_SOURCES` map (anthropic, openai, openrouter, opencode-go, bedrock; adding a provider is one line), Bedrock region prefixes (`us.`/`eu.`/`apac.`/`global.`) resolve to their base model, and non-generative endpoints (embeddings, moderation, rerank, whisper/tts, image/audio/video) are filtered out of the selectable set. The unknown-model fallback rises from 32k to 200k (overshoot is recoverable; premature compaction was the bug), overridable via `AGENTUSE_FALLBACK_CONTEXT_LIMIT`. `agentuse models` stays curated by default and gains `--all` to list every registry provider (bedrock and opencode-go included). New canonical `BUILTIN_PROVIDERS`/`AUTH_PROVIDERS` replace the provider-name arrays previously duplicated across modules.
- **AI SDK upgraded to v7 (`ai` 7.0.30), and approval enforcement rebuilt on v7's `toolApproval` as a machine-checked lease** (breaking). The runtime moved off the AI SDK v6 line to v7 (node `>=22` now required; internal renames `fullStream`→`stream`, `stepCountIs`→`isStepCount`, `system`→`instructions`, and the agent loop opts into `allowSystemInMessages` because our pipeline carries system-role messages inside `messages` and resumed sessions rehydrate them). Suspension is hardened for v7's eager stepping: a `stopOnSuspend` `stopWhen` predicate ends the step loop synchronously inside the SDK when a step carries a `SuspendSignal`, closing a race where v7 launched step N+1 before the consumer-side abort landed (the pre-approval "ghost-post" window). On top of that, approvals are enforced as a **lease, not a prompt**: approving an `await_human` gate derives a machine-readable lease from the gate's `changes[]` (the exact actions to execute, verbatim) into `approval-lease.json` in the session dir, so it survives suspend/resume and process boundaries. v7's `toolApproval` is consulted *before* execute dispatch, so a `tools.bash.gated` command that is lease-covered runs straight through (an approved multi-command plan needs zero micro-approvals) while an uncovered one is auto-denied with a redirect to re-request. Matching is normalized-exact or verbatim containment for grants ≥16 chars, so a *revised* draft is not covered and forces a fresh gate (the incident-B trim case); reject/comment revoke the lease, a new gate supersedes it, and both CLI (`status: 'approve'`) and Slack/serve (`'approved'`) decision shapes grant.

### Fixed

- **`approval.timeout` bare numbers now mean seconds, not milliseconds**: a bare-number timeout (`approval: { timeout: 3600 }`) previously parsed as milliseconds, expiring the gate near-instantly - no one could have depended on a millisecond approval window on purpose. Bare numbers (and suffix-less numeric strings) now mean seconds, matching every other timeout field; suffixed forms (`"30m"`, `"24h"`, `"7d"`) are unchanged, and invalid values are rejected at parse time instead of silently creating a never-expiring gate.
- **Per-response output limits resolve from AgentUse's registry, not the SDK's stale model table**: `@ai-sdk/anthropic` hardcodes `max_tokens` per model id and defaults any id it doesn't recognize to 4096, so a model newer than the SDK (e.g. `claude-sonnet-5`) silently truncated normal-length outputs and tool-call arguments, and since a `length` finish ends the agentic loop, one oversized step killed the whole run (observed: a run truncated its final write-up at step 61/150 and persisted nothing). A new `resolveMaxOutputTokens()` resolves the cap with precedence explicit `maxOutputTokens` override (clamped to the real limit; with extended thinking on, raised to the thinking floor of budget + answer reserve) > extended-thinking budget > custom-gateway cap (16384) > first-class Anthropic default of min(registry output limit, 32k) > the SDK's own default for other providers, so reasoning-heavy OpenAI responses are not newly capped.
- **Text artifacts preview in the browser instead of downloading, decided by content, not extension**: the session-view artifact endpoint only previewed a short hardcoded extension list, so anything else (`.agentuse`, `.toml`, `.sql`, ...) was served as an `octet-stream` attachment and downloaded. Previewability is now sniffed from the bytes (git-style NUL check plus strict UTF-8 decode): any text file renders as a themed preview regardless of extension, markdown-family files (`.md`, `.markdown`, `.agentuse`) get the full markdown renderer with frontmatter as a metadata table, and only true binaries (or non-UTF-8 encodings) download. The sniff never routes into the script-capable HTML/SVG branches, which stay extension-gated behind their CSPs.
- **Compaction failure is non-fatal on proactive paths**: a between-segment compaction that threw was swallowed into a debug log and the run finalized as "completed" before the agent finished its work (the second half of the same incident: the manager stopped before ever delegating to its subagent). The proactive compaction paths (pre-stream and between-segment) now record a compaction-error marker in the session log (with the provider's response detail) and continue with the un-compacted context; the reactive path after a genuine provider context-length rejection stays fatal and yields an error status.
- **Approval and resume failures stay actionable**: sessions orphaned by a worker restart are reconciled, duplicate suspended gates are healed before resume, and approval pushes route to the actionable cascade root. A failed approval decision or resume now restores the pending gate and renders the failure on that gate instead of leaving the reviewer with a no-op or a generic toast. Resume tolerates tools removed since the session snapshot was written, while a decision write that cannot find its approval part fails loudly rather than pretending it succeeded. Stop/Discard at a pending gate delivers a reject decision so the suspended run can unwind cleanly.
- **Retrying a resolved approval gate replays from the gate, not from the abandoned attempt**: the session-page Retry action rewound the gate part but left everything the failed attempt had recorded after it (its tool calls and its closing report) in the model-facing history, while the persisted context snapshot was still the pre-gate one. The retry therefore replayed the abandoned tail and ended the request on the assistant's own sign-off, which Anthropic rejects outright as an assistant prefill on models that disallow it (HTTP 400, "the conversation must end with a user message") and which, on models that allow it, asks the model to continue its own final report instead of taking a new turn. Reopening a gate now marks that tail superseded: it stays visible in the session log for the human, but the model resumes from the approval decision. As a backstop, any resumed history that would still end on an assistant turn gets a neutral continuation user turn appended rather than failing the run.
- **Session lists reflect the real live system**: out-of-process CLI runs and runs launched under `-C` directories that share a Git root are attributed to their owning project and appear promptly in dashboard streams. Live sessions sort before historical ones, pagination cursors no longer expire after a minute, stream caches include their requested limit, and Load more owns and deduplicates its cursor. Per-project scheduler locks and jitter cancellation prevent duplicate scheduled execution, while process identity includes the start time so reused PIDs cannot protect stale locks or workers.
- **Tool snapshots and malformed calls recover safely**: suspension unwraps AI SDK `jsonSchema()` wrappers, serializes refined/effected Zod schemas, and validates the complete tool snapshot before committing the gate. Resume and MCP execution no longer crash on v7 result adapters, and leaked XML tool-call markup is repaired or rejected with a corrective tool result instead of being persisted as an approval request. Tool failure and announcement logs are deduplicated so one call produces one diagnostic trail.
- **`store_create` rejects double-wrapped item envelopes**: a full item mistakenly nested inside `data` previously produced a metadata-less row that type/status-filtered `store_list` calls could never find, despite reporting success. Likely wrapped envelopes now fail before writing with an actionable top-level shape, while deliberately untyped items remain valid and return a visibility warning.
- **Daemon and persistence hardening**: store writes are crash-safe and transient read failures no longer look like an empty store; dead-holder session-index locks are reclaimed without stealing from a live external run. Failed MCP connects close their clients and timers, scheduler-lock stale sweeps close a TOCTOU window and fail closed on ambiguous filesystem state, socket restarts detach old listeners and deduplicate decisions, and keyless-daemon CORS/body parsing plus request-dedup maps are bounded. An orphaned scheduler reclaim guard now produces an actionable warning naming `.agentuse/scheduler.lock.reclaim`. Artifact serving and verification apply their secrets denylist after symlink resolution, and compiled TypeScript plugins use isolated temporary directories so current Bun releases can load multiple plugins reliably. Bash output truncation stays UTF-8 safe, file reads enforce their size guard, and `/dev` stream sinks can be used without broadening the configured filesystem allowlist.
- **Live web views remain consistent through navigation and deploys**: stale chunk 404s trigger one controlled reload, system theme changes propagate on every route, foregrounded mobile tabs reconnect their streams, and fetches discard data from obsolete keys. Session rows update in place across status transitions, wide Markdown and nested lists render without breaking the log layout, and running/approval state is derived from a shared definition across Home, Agents, Sessions, and detail views.

### Documentation

- Documented the `metadata:` frontmatter field and the `maxOutputTokens` override in the agent-syntax reference, and media (image/PDF) reads in the builtin-tools reference; the bundled creator skill picked up the metadata and media-read notes.
- Documented `mcpServers.*.toolTimeout` (per-tool-call timeout, default 60s) and its `MCP_TOOL_TIMEOUT` env fallback for the first time; duration-string support and the timeout unit rules are documented across agent-syntax, builtin-tools, approval-gates, and environment-variables, and the bundled creator skill gained a timeout-units gotcha.
- Added the Verify guide and reference coverage for reasoning, tool intent, metrics, explicit incomplete outcomes, structured approval fields/options, artifact previews, and schedule timezone behavior; the bundled creator skill now includes the corresponding model, thinking-budget, timeout, frontmatter, and run-from-URL authoring gotchas.

## [0.15.0] - 2026-06-30

This release centers on context-compaction reliability, accurate token accounting across approval gates, and making an agent run observable from the `serve` web UI. Approval gates, the session/approval web UI, the JSON API, and channels/Slack remain **experimental**: route shapes, UI details, and API response formats may still evolve based on production feedback.

### Added

- **Operational logs in the session view**: the CLI's `debug`/`info`/`warn`/`error`/`system` stream is captured during a run (via an `AsyncLocalStorage`-scoped sink) and persisted as `log` session parts, so the operational log now shows in the `serve` web session view and `agentuse sessions`, not just the launching terminal. Concurrent sub-agents route to their own session. Parts are capped per session (default 300, `AGENTUSE_SESSION_LOG_LIMIT`) with a truncation marker, and the session view renders level markers/colors behind a **debug toggle** (debug entries hidden by default).
- **Compaction visibility**: compaction events surface as session markers (with a reason: window-pressure `limit` vs. `approval` gate) in the `serve` web view, SSE stream, and `agentuse sessions`, alongside live context-usage accounting, so a fold of the conversation is no longer silent.
- **Agent detail hub + "Send to Coding Agent" dialog**: clicking an agent in the `serve` web UI now opens a deep-linkable hub at `/agents/:project/:agent` (name, capabilities, recent runs, rendered source, and a Run button) backed by a new `GET /api/agents/detail` (capabilities summary + raw source, behind the operator header gate, scoped to loaded agent files). The source panel defaults to a rendered view with highlighted YAML frontmatter, Markdown body rendering, heading hierarchy, a raw/rendered toggle, and page-level scrolling for long `.agentuse` files. A shared **Send to Coding Agent** dialog produces a ready-to-paste, terminal-styled prompt with live optional-detail toggles and copy; it is reachable from the hub's source section (to *implement* against the agent) and from the session view (to *debug* a run, replacing the earlier one-click "Copy debug prompt" button), and carries the `/agentuse` skill reference, session id, and replay command.
- **Faster agent and run navigation in `serve`**: agent rows and detail hubs can start a detached run and jump straight to its live session; Cmd/Ctrl+K (or the topbar search button on touch devices) fuzzy-jumps to an agent by name; and the sessions page now has a searchable agent picker with a 30-day default window when agent/approval filters are active.
- **Token-efficient store queries**: `store_list` now returns metadata-only summary rows by default (no `data` payload) so an agent can scan many items cheaply, then `store_get` the one it needs. Adds `q` (substring search across title/type/tags/data with a match snippet), `where` (exact-match on `data.*` keys with string/number/bool coercion), `ids` (batch fetch), and `includeData`/`fields` projection; responses include `total` alongside `count` for pagination. New `Store.query()` returns `{ items, total }`.
- **Model-facing tool-output clamping with full-output offload**: large tool results are capped before they reach the model (new `AGENTUSE_TOOL_*` byte/line caps), and when session storage is available the full, untruncated output is saved as a session-local tool-output artifact and referenced from the bounded preview, so an oversized diff/log/file no longer inflates input tokens for the rest of the run.
- **Session-linked artifact tools**: `tools: { artifacts: true }` enables `artifact_save` for writing viewable deliverables under `.agentuse/artifacts/` without granting broad filesystem write access, plus `artifact_list` for manifest-backed discovery by session/group. Saved artifacts are listed in the session view and render as compact viewable tiles in the tool log instead of dumping raw file content.
- **OpenCode Go provider**: built-in support and auth for the OpenCode Go (`opencode.ai/zen`) gateway via `OPENCODE_GO_API_KEY` (and optional `OPENCODE_GO_BASE_URL`), covering the GLM, Kimi, DeepSeek, MiMo, MiniMax, and Qwen model lines and auto-selecting the Anthropic vs OpenAI-compatible protocol per model.
- **Learning provenance and human-comment capture**: learnings now carry a `source` (`auto` | `approval`); human approval comments that read as agent-wide rules are promoted into durable learnings (via a generalizability filter) and rank first when injected so they survive the per-run cap. Capture now runs once after lifecycle completion, grounded in tool outputs and reviewer comments, and learning/error outcomes (`captured`/`none`/`failed`) are persisted as session markers so a silent capture failure is visible. Delegated subagents with `learning.apply` now receive their own learnings, and runtime guidance declares the precedence order: agent instructions, then Learned Guidelines, then Skills.
- **API error detail on failures**: run failures now extract and surface the provider's API error detail instead of a generic message.
- **Isolated `serve` sandbox script**: a dev helper to run a second `agentuse serve` alongside the live daemon without stealing its Slack socket or arming real schedules (isolated state via `XDG_DATA_HOME`, a separate port, Slack socket off, empty scratch `-C`).
- **LLM-mocked tool runs**: `agentuse run --mock --mock-model <model>` can exercise an agent end-to-end while replacing configured tool execution with LLM-generated mock results, avoiding bash/filesystem/MCP/store side effects. Approval gates remain real unless `--mock-approval` is set, and mock sessions are badged in the `serve` session view and sessions list.
- **Global config `env` defaults**: the global `config.json` can now define non-secret environment defaults such as `AGENTUSE_MOCK_MODEL`; precedence stays command flag > shell env > `.env` > global config env.
- **Dual-mode subagent approval cascade**: a leaf agent's `approval: true` gate now behaves identically whether the leaf is run directly or delegated by a `type: manager` agent, reversing the 0.14.0 load-time rejection of gates in delegated subagents. The human approves once at the manager root (the leaf's own session page is view-only); the child suspends with a new `subagent_wait` resume kind that bubbles up to the parent, the root surfaces the leaf's full gate content (prompt/summary/draft/risk + resume token) plus approve/reject/comment actions, and on approval the cascade resolves the leaf, runs it, and resumes each ancestor up to the root (re-parking if any level re-suspends). The approvals list shows one entry per cascade. v1 scope is one gate at a time with a human relay; concurrent multi-gate fan-out, LLM auto-approval, and an in-process CLI cascade are deferred.
- **Manual Retry for errored approval resumes**: an errored session whose latest approval gate was already resolved can be explicitly reopened from the session page. The Retry action warns about possible duplicate side effects, rolls the gate back to suspended using the persisted resume payload, preserves the original token, and refreshes the approval panel without a manual reload.
- **Model reasoning surfaced inline in the session trace**: reasoning stream chunks (previously dropped as unknown-chunk noise) are now captured end-to-end and persisted as streamed `reasoning` session parts, rendered in the `serve` session view with a `✻` marker and a dimmed, left-ruled "inner monologue" treatment distinct from the answer (and counted toward time-to-first-token). New per-provider opt-ins make reasoning actually emit: `openai.reasoningSummary` (defaults to `auto` on reasoning-capable models, registry-gated so e.g. gpt-4o is never sent the unsupported option) and `anthropic.thinking.budgetTokens` (off by default; bills output tokens and auto-raises `max_tokens` above the budget to satisfy Anthropic's constraint).
- **Filesystem permission model: write implies edit, plus batched edits**: the permission encoding is now ordered `read < edit < write`, so a `[read, write]` grant exposes the targeted `filesystem_edit` tool (not just the full-rewrite `filesystem_write`), sparing agents from burning output tokens rewriting large files wholesale. `filesystem_edit` also accepts an optional `edits[]` array applied sequentially and all-or-nothing, alongside the single `old_string`/`new_string` form.
- **Pin agents and run with a custom instruction**: the `serve` agents view collapses the Name/Model columns into a per-row ⋯ menu and adds **Pin to top** (localStorage-backed, surfaced in a Pinned section above the project trees and synced across tabs) and **Run with Custom Instruction** (a modal whose text is appended to the agent's prompt for that one run, then redirects to the live session).
- **Sub-agent session view**: a delegated child's session page now has a compact, sticky session bar with a tokenized back-to-parent link, and a paused view-only child's pending gate shows an **Approve on parent run** CTA at the end of the log so the reviewer lands on the actionable manager run. Its sub-agent card also moved out of the collapsible region so the child status and child-session link stay visible when the log row is collapsed.
- **`serve` web UI polish**: a theme-aware AgentUse brand wordmark logo replaces the text wordmark in the header (black/white SVG toggled by theme, flash-free); the agents page gains a filter box (with an iOS focus-zoom fix); schedule rows deep-link to the agent detail hub via a stretched-link overlay (the last-run session link stays independently clickable); and a persistent "Agent is running" heartbeat row pins to the end of the live session log to signal progress through tool execution and model-latency gaps.

### Changed

- **Context compaction reworked to run between `streamText` calls** (major reliability fix). Compaction previously ran inside the AI SDK `prepareStep` callback, where the messages it returned only affected a single request: the SDK rebuilt the full history from its own accumulated messages each step, so compaction never shrank the real conversation, re-fired every step past threshold, and on a smaller window (e.g. 200k) could march into a hard `context_length_exceeded`. `executeAgentCore` is now a segment loop: `prepareStep` only measures and annotates the cache, a `stopWhen` predicate ends a segment when real per-step usage crosses the window-relative threshold, and between segments the full conversation is reconstructed from `response.messages`, compacted (and **persisted**), and restarted from the compacted history. Continuation is gated on compaction actually reducing context (a no-op can't spin the loop), and the per-segment step budget is reduced by steps already used so restarts don't multiply `MAX_STEPS`.
- **Compaction preserves the system prompt and original task verbatim**: the head (leading system messages + the original user task) is kept intact instead of being summarized away, the summary is placed as a provider-safe user message between the head and the recent tail (matching Codex, never a mid-conversation system message), and a forward-progress guarantee folds the whole body when no safe tool-pair split exists rather than no-opping into an overflow. Re-summarizing an unchanged transcript is guarded against, and the char/4 token estimate is calibrated against the provider's real per-step `inputTokens` (including tool-schema overhead) for accurate active-context decisions.
- **Approval-gate compaction is now reason-aware**, and the absolute boundary-compaction floor is disabled by default (it was folding ~90% of context on near-empty large windows). The obsolete `step` compaction boundary and its `STEP_COMPACTION_MIN_TOKENS` no-op were removed; `shouldCompactAtBoundary` is approval-only.
- **Token/usage accounting reframed Codex-style**: the dashboard and CLI lead with **tokens spent** (non-cached input + output, the real full-rate cost) and show cache reads as a `+N cached` bonus rather than an inflated headline; the context cell reads just `N% left` with absolute tokens/limit on hover. Cumulative usage is now accumulated across compaction segments and across resumes so totals are monotonic and cross-run correct.
- **Approvals and sessions lists stream over SSE**: both the approvals list and the sessions list update live from a single shared worker poll instead of per-client polling (idle SSE CPU reduced). The pending approvals bucket sorts newest-first (by `suspendedAt`/`createdAt` DESC), and the Completed and Expired/Errored sections were removed from the approvals page.
- **`store_list` no longer returns `data` unless `includeData: true`** (behavior change); `store_create`/`store_update` responses are trimmed to drop the redundant full-item echo, and `store_get` gains the same `fields` projection.
- **Learning config collapsed to a single switch**: `learning: true` => `{ capture: true, apply: true }`; the object form exposes `capture`/`apply`/`criteria`/`file`. The legacy `evaluate` shape migrates behind a single deprecation-compat marker for easy removal.
- **Session-view UX**: the resume composer is gated behind a collapsible "Resume session" toggle (renamed from "Continue session", auto-focus on open), per-run additional instructions render above the log, the narrow-screen log stacks the timestamp/marker above full-width content instead of wasting a fixed left gutter, session pages keep a sticky status/agent identity bar with a scroll-to-top control, and session-log Markdown rendering was improved.
- **Soft tool-error warnings are now contextual**: successful tool results that appear to report an error are matched on the first meaningful output line, emitted once, and nested under the corresponding tool entry with a collapsed-visible badge instead of floating as duplicate standalone "failed" rows.
- **Session stop control moved into the action row and made state-aware**: the Stop control left its standalone red panel and now sits in the session-actions row next to "Send to Coding Agent". It reads **Stop session** (square icon) for a running session and **Discard** (× icon) at an approval gate, where the run is already paused and the action just abandons the pending request without running the agent (distinct from Reject, as the tooltip spells out).
- **Child-session lookup now trusts nested subagent storage**: live session polling reads only the parent's `{session}/subagent` directory instead of compatibility-scanning every top-level session for legacy orphaned children, removing an O(project) scan from every session-detail refresh. The tradeoff is deliberate: a handful of pre-2026-06-05 orphaned child sessions written by a fixed resume bug are no longer surfaced as children.

### Fixed

- **Session token totals no longer drop then climb across an approval gate**: a resumed run reused the primary message and overwrote its tokens with that invocation's own (initially small) usage instead of adding to the suspended total; the prior cumulative total is now carried forward through preparation → run → stream/persist and folded into every usage write, so the count is monotonic across one or many gates.
- **Session token usage stays scoped to the current session**: parent/manager token totals no longer include nested subagent message records when aggregating usage.
- **Corrupt session data surfaces instead of a generic 500**: a new `CorruptStorageError` is raised when a stored JSON file exists but can't be parsed; a cross-session list scan skips the one corrupt session rather than failing the whole list, and the requested session itself returns a distinct `SESSION_CORRUPTED` code (422, terminal) so the web view renders a clear error instead of polling a 500 forever.
- **Session pages paint from the API before waiting on SSE**: session detail views fetch `/status?logs=1` immediately on mount, then let SSE carry live deltas, so remote or buffered streams no longer leave the page stuck on "Loading session…".
- **Resume tolerates malformed context snapshots**: already-written snapshots with duplicate tool results or bare-string tool outputs are normalized and deduped on read, and the in-stream duplicate writer was removed so future approval resumes receive AI SDK-compatible message history.
- **Delegated subagents honor their own step budget**: a manager-delegated leaf now resolves `maxSteps` with standalone precedence (parent override, then the leaf's own `maxSteps`, then the 100-step default) instead of silently falling back to 50.
- **Runtime/provider failures preserve useful object-shaped messages**: remaining `String(error)` call sites now flow through `toErrorMessage`, so plain-object rejections no longer become `[object Object]` in session errors, parent-manager failures, context-limit handling, or API responses.
- **Helper LLM calls no longer send custom temperature**: learning extraction, approval learning, compaction, benchmark judging, and mocked tool helper calls use provider defaults so frontier models that reject `temperature` keep working.
- **Rejected approvals resume agent cleanup** instead of leaving the run hanging.
- **Orphaned `serve` workers are prevented** so a crashed or superseded worker no longer lingers.
- **Reviewer comments are captured from any commented decision**, not just a final bare `approve`: the comment arrives through the revise loop (a `comment` decision that re-presents the same gate), so gating capture on `status === 'approve'` missed the highest-signal feedback.
- **`storeItemPreview` no longer crashes** on store items that have no `data`, and serve store-event parsers read the new `id` field.
- **Store writes no longer strand locks between operations**: store locking moved to short per-operation transactions with in-process serialization, fresh disk reads before mutation, and stale-lock stealing by age, so a crashed/errored long-lived worker cannot leave the store permanently blocked and concurrent same-process writes do not clobber each other.
- Interim usage and active-context token accounting corrected.
- **Terminally-errored sessions leave the pending approvals list**: a run that died with an error other than `USER_STOPPED`/`TIMEOUT` (e.g. `EXECUTION_ERROR`) left its `await_human` part `pending` and stuck in the approvals list forever (unclearable, since approve/reject need a live suspended session and the discard control is hidden for errored runs). A pending gate whose session is neither suspended nor running is now classified as `errored` and drops from the pending bucket.
- **Delegated leaf gate renders as one actionable approval box at the manager root**: a manager parked on a child's `subagent_wait` bookmark previously showed an empty "approval requested" card with no buttons; the descended leaf's full `await_human` details and resume token are now stamped onto that entry so it renders and acts as a single approval (skipped for a delegated child's own view-only page).
- **Duplicate approval box after navigating into and back from a sub-agent**: the reused `SessionDetail` component instance kept the child's approval log entry in its ref across `/sessions/:id` navigations, merging it into the manager's logs; per-session state now resets on `sessionId` change (token-only refreshes excepted, so live logs aren't wiped mid-session).
- **Hot-reloaded agents appear without a daemon restart**: `project.agentFiles` (globbed once at startup) is now updated on add/remove so the `/agents` listing and counts reflect moved, renamed, and newly added agents live, instead of keeping stale paths that 404 as "File not found".
- **Responsive sub-agent approval card**: the card's chip/name/session-id grid no longer overflows horizontally on phones (it switches to a wrapping flex row below 640px), and the in-card status chip margin is reset for correct vertical alignment against the agent name.
- **Stores table scrolls on narrow viewports** instead of squishing: it is wrapped in a horizontal-scroll container with min-width nowrap columns (and the mobile rule that hid columns 4/5 is dropped, so they stay reachable).
- **CSS-only `serve` web rebuilds refresh immediately**: the HTML shell cache is now keyed by both the JS entry and CSS asset hrefs, so a stylesheet-only build no longer keeps serving the old hashed CSS link until the JavaScript entry changes.

### Documentation

- Documented the reworked compaction model and its env vars (`COMPACTION_THRESHOLD`, `COMPACTION_KEEP_RECENT`, `APPROVAL_COMPACTION_MIN_TOKENS`, `CONTEXT_COMPACTION`) plus a tool-output best practice in the context-management guide.
- Documented the `AGENTUSE_TOOL_*` tool-output limits and the full-output artifact offload in the environment-variables reference.
- Updated the learning guide for the single-switch config, provenance, and approval-comment capture.
- Documented the OpenCode Go provider in the model-configuration and models references, and the new model lines it adds.
- Updated the store guide for metadata-only `store_list`, `q`/`where`/`ids` queries, and `fields` projection.
- Documented model reasoning and its per-provider config (`openai.reasoningSummary`, `anthropic.thinking.budgetTokens`) in the agent-syntax, model-configuration, and session-logs references.
- Rewrote the subagent-approval section of the approval-gates guide for the dual-mode cascade.
- Documented the `read < edit < write` filesystem permission model (write implies edit) and the batched `edits[]` form of `filesystem_edit`.
- Trimmed the bundled core/runner/creator skills to durable invariants and documented lean prompting, large-file reading, skill-reuse, and source-precedence guidance for skill defaults vs. learned corrections.
- Added development/documentation workflow polish: a `watch:all` script and fixed Mintlify dev/preview port `4747`.

## [0.14.0] - 2026-06-12

This release refines the human-in-the-loop and `serve` surfaces introduced in 0.13.0 and hardens skills, sandboxing, and auth. Approval gates, the session/approval web UI, the JSON API, and channels/Slack remain **experimental**: the core workflow is ready to try, but route shapes, UI details, and API response formats may still evolve based on production feedback.

### Added

- **`agentuse doctor`**: a diagnostics command that checks project context, auth/provider credentials, sandbox readiness, and skill configuration, resolving project context from the agent file path rather than `process.cwd()`.
- **Unified session page**: `serve` collapses the run log and the approval surface onto one page at `sessions/:id`. The page shows the full run timeline and, when the session is suspended on an `await_human` gate, exposes approve/reject/continue actions. A new sessions list plus `GET /api/sessions` (with `agent` / `trigger` / `days` filters) and `GET /api/sessions/:id` back it.
- **Session token**: a stateless, session-scoped `?token=` (HMAC-SHA256 of `AGENTUSE_API_KEY` over the session id, base64url, timing-safe compared) makes a `sessions/:id` link clickable without pasting an `Authorization` header. It grants view + approve for that one session and is empty/omitted on local where there is no API key.
- **Root web dashboard**: `GET /` now serves an HTML dashboard (AgentUse wordmark, theme-aware SVG favicon, nav cards, and a per-project agent/schedule rollup that deep-links into the agents view) instead of raw JSON. Server-info JSON moved under `GET /api`.
- **Agents & schedules surfaces**: new `GET /api/agents` and `GET /api/schedules` JSON endpoints, matching HTML pages at `/agents` and `/schedules`, and `serve agents` + `serve schedules` CLI subcommands. `Scheduler.listSerialized()` returns JSON-friendly schedule rows sorted by next run.
- **Skill trust config**: `skills: trusted` keeps auto skill discovery but trusts loaded skills to use the tools already configured on the agent (without enabling new tools or new bash commands), aimed at sandboxed/yolo-style agents.
- **Portable skill directory placeholders**: skill content can reference `${skillDir}`, `${SKILL_DIR}`, or `${CLAUDE_SKILL_DIR}`, each substituted with the skill's absolute directory so bundled scripts and assets resolve regardless of install location. Literal `$SKILL_DIR` (no braces) is left untouched for runtime shell expansion.
- **AgentUse assistant skill**: `npx skills add agentuse/agentuse` installs a discovery stub that redirects to `agentuse skills get core`, keeping AI coding assistants aligned with the installed CLI version.
- **OpenAI prompt cache options**: the `openai` model config accepts `promptCacheKey` (a routing key, max 64 chars) and `promptCacheRetention` (`'in_memory'` or `'24h'`). AgentUse already sends a stable default `promptCacheKey` per agent so repeated runs with the same prompt prefix route to cache more easily; set `promptCacheRetention: 24h` only for extended retention on models that support it.
- **Configurable tool-output limits**: new `AGENTUSE_TOOL_*` environment variables centralize the byte, line, and line-length caps applied to tool output, shared by the bash and filesystem tools (defaults match prior behavior).
- **Approval artifact viewer**: `await_human` accepts `artifact_path` (a project-root-relative path to a local file the agent produced) or `artifact_paths` (several of them). The session page shows each as a tile that opens the file in an in-page popup (a sandboxed iframe), served from a new `GET /sessions/:id/artifacts/*` route. Markdown renders as a themed document, HTML/images/PDFs display inline, and the path is resolved against the project root with a traversal + secrets guard (`.env`, `.git`, internal `.agentuse` state are never served). The viewer is mobile-responsive (full-screen on small screens) with an "open in tab" fallback.
- **Interactive artifacts in the approval viewer**: HTML artifacts can now run their own inline JS in the preview, so charts and dashboards render live. The frame is sandboxed to an opaque origin with a strict CSP (inline script/style allowed, `connect-src 'none'` blocks all network egress, no external hosts), so an artifact can neither exfiltrate the session token nor pull in remote code. Markdown frontmatter renders as a metadata table (chips for arrays, clickable URLs, ISO dates) instead of raw `---` delimiters, and the preview follows the session's light/dark theme.
- **Session stop controls**: a running session (including delegated subagents) can now be stopped from the `serve` web UI and the `agentuse sessions` CLI; stopping a session also clears its pending approvals.
- **Session filters and approval history links**: the `serve` sessions list gains filtering, and approval history entries link back to their sessions.
- **More OpenRouter model series**: the model registry now includes OpenRouter `deepseek`, `qwen`, `kimi` (moonshotai), `gemini` (google), and `grok` (x-ai) series, with per-line dedup that keeps only the latest release of each product line.

### Changed

- **JSON API moved under an `/api` prefix** (potentially breaking). All JSON `GET` endpoints now live under `/api/*` (`/api`, `/api/agents`, `/api/schedules`, `/api/sessions`), replacing the old `?format=json` content negotiation, which has been **removed**. The root and the `/agents` / `/schedules` paths now return HTML. `POST /api/run`, `POST /api/resume`, and the approval action routes keep working at their original un-prefixed paths (`/run`, `/resume`, …) for backward compatibility, but those legacy aliases are deprecated and will be removed in a future release. Update self-hosting health checks and any scripted JSON consumers to the `/api/*` paths.
- **Sessions follow the agent file across working directories**: session identity and resume now key off a `stateRoot` derived from the agent file (with extensionless path support) rather than the current working directory, so a session can be inspected and resumed from a different `cwd`. Sandbox bind mounts continue to use the cwd-derived project root.
- **Scheduled runs are staggered** so many agents sharing the same cron expression no longer all fire in the same instant.
- **Live session feedback**: the running status pill pulses, finished sessions open at the top of the log while an active gate auto-scrolls to the bottom, and a persistent "session running" footer signals progress during the thinking gap between steps. Dashboard HTML is sent with `Cache-Control: no-store` so a tab left open across a restart never runs stale inline JS.
- **Narrow-screen session log layout**: on phones the session log no longer wastes the left gutter on fixed time/marker columns. The timestamp and status marker sit on their own row and the log content spans the full width below.
- **Approval gate prompting reworked for richer reviews**: the `await_human` instructions and field descriptions now steer the agent to put a one-line yes/no question in `prompt` and the full, Markdown-formatted reviewable content in `draft` (plus real `context`/`risk` detail and a worked example), instead of cramming a terse summary into `prompt`. This fixes approval cards that rendered as unstyled one-liners.
- **Autonomous agent prompts are stricter about silent execution**, reducing intermediate narration, tool-call announcements, and repeated summaries before the final terminal-friendly result.
- `GET /approvals/:id` now redirects to `sessions/:id`; the legacy `approvals/:id/*` action routes remain as transition aliases.
- `learning.apply` now defaults to `false` when omitted, so learnings are extracted but only injected after manual review unless auto-apply is explicitly enabled.
- **Bash tool output uses head + tail truncation**: large output is now truncated to keep both the start and the end (40/60 split) with an omitted-bytes marker in the middle, instead of head-only. This preserves errors and recent output at the tail of big diffs and command runs.
- **Sandbox exec lifetime is bounded**: Docker sandbox commands (and image setup) now run under a timeout that kills and removes the container on expiry, so a runaway sandboxed command can no longer hang a run indefinitely.
- **Cached token usage is tracked and persisted**: prompt-cache read/write token counts are accounted across runs (including subagents), persisted with session usage, and surfaced in the `serve` session views and usage totals.
- **Model registry generation auto-tracks major versions** from models.dev rather than hardcoded version floors, so new majors are picked up automatically and stale builds age out; the doc reference updater is now vendor- and token-aware (fixing the MiniMax-routed-to-Gemini mismatch).
- **`serve` Web UI rebuilt as a Preact single-page app**: the server-rendered HTML (previously built by string concatenation inside an 8,000+ line `serve.ts`) is replaced by a Preact + `preact-iso` SPA with content-hashed, immutably cacheable assets and self-hosted Geist fonts. A new SSE hub pushes status and log deltas from a single shared worker poll per session (the polling fallback stays byte-for-byte equivalent), so live session views update without per-client polling. Per-route auth gating is preserved exactly (Bearer-gated operator pages vs capability-token session pages), and Slack approval deep links still authorize the SPA by minting a session-view token via redirect. On local (no-API-key) daemons the session page loads and streams without a token; on exposed daemons token-less fetches still 401.
- **Approvals page tidy-up**: completed approvals are hidden from the approvals page, approval history labels are shortened, and pending approvals are cleared when their session stops.
- **Slack approval cards reworked**: cards now lead with the agent's display name (`<Agent Name> · approval completed`) instead of a generic "AgentUse approval ..." header, render the agent's Markdown as Slack mrkdwn (bold/italic/strike/links/headings/bullets, with Markdown tables wrapped in code fences and code spans passed through untouched), give the prompt a full-width section instead of squeezing it into the field grid, and reorder fields to Decision / Reviewer / Duration / Session. Run lifecycle cards adopt the same layout (`<Agent Name> · run started/completed/failed`) and drop their redundant Agent/Status fields. Every card carries a permanent "Open in AgentUse web UI" link to its session page that survives all status updates (previously a waiting-only "Review approval" button that vanished once a decision was made), and the Decision message stays last in the thread so its actionable buttons aren't buried under a status note.
- **Slack comments move to thread replies**: the Comment button (which opened a modal and intermittently failed with `expired_trigger_id`, since `views.open` must consume the single-use trigger within ~3s and Socket Mode delivery is best-effort) is removed in favor of replying directly in the approval thread, which has no expiry. Legacy Comment buttons on already-posted approvals now point at the reply flow.
- **Slack Socket Mode connectivity hardened**: the server ping timeout drops from 30s to 20s so a silent connection is detected and reconnected sooner, and a health watchdog tears down and recreates a socket that stays down for more than 60s, as a backstop for when the SDK's internal auto-reconnect gets stuck. Both mitigations are in-process and work the same under pm2/systemd/bare/Docker.

### Fixed

- **Agent file hot reload works with Chokidar v5**: `serve` now watches concrete `.agentuse` files and reconciles additions/removals, so schedule changes and newly added agents are picked up without relying on unsupported glob watching or broad root-directory watchers that can exhaust file descriptors.
- **Skill discovery is compatible with existing assistant skills**: `SKILL.md` files may omit `name` or `description`, names are inferred from the containing directory when missing, explicit names may use broader assistant-style formats, and directory/name mismatches no longer cause the skill to be skipped.
- **Doom-loop detection no longer flags intentional repeated commands** when meaningful model text appears between identical tool calls; truly consecutive identical calls still trigger the guard.
- **Deprecated `mcp_servers` warnings are emitted once per process** instead of repeating every time an agent is parsed.
- **Sandbox no longer mounts `$HOME` as the project root**: `findProjectRoot` stops its upward walk at `$HOME` (falling back to the starting directory) instead of treating a marker like `.agentuse`, `.git`, or `package.json` in the home directory as a project root, and `createSandbox` refuses to bind-mount a project root that resolves to `$HOME` or an ancestor. This prevented the Docker sandbox from exposing `~/.ssh`, `~/.aws`, and the rest of `$HOME` to `sandbox__exec`. Project-root detection also respects the `$HOME` env var.
- **Anthropic OAuth tokens refresh before expiry** (within a 5-minute buffer) and **concurrent refreshes no longer race**, avoiding mid-run auth failures and duplicate refreshes.
- **Slack Socket Mode log storms reduced**, cutting repetitive connection logging.
- Agents always receive a default skills config from the parser, so skill loading behaves consistently when `skills` is omitted.
- **Approval gates in delegated subagents fail loud**: a `type: manager` agent delegating to a subagent with `approval: true` previously completed the run silently while leaving an orphaned, un-resumable pending approval (the subagent never propagated the `await_human` suspension to the parent session). Approval in a delegated subagent is now rejected at load time with a clear error; gates are supported only on the top-level/manager agent.
- **Subagent session logs render in the `serve` view**: subagent sessions stored nested under their parent (`{parent}/subagent/{sub}`) are now resolved by basename when the computed path is empty, so a running or resumed subagent no longer shows "No session events yet."; resumed-subagent session lookup is also fixed.
- **Store lock no longer leaks across concurrent runs**: the `serve` worker handles execute/resume requests concurrently, and overlapping `Store` instances previously drifted the lock ref count so the lock file was never deleted, permanently blocking every other process. Acquire/release is now serialized per lock path with an async mutex, the ref count is the sole authority for same-process re-entrancy, same-PID leftover lock files are reclaimed, and the store lock is released before a session flips to completed/suspended.
- **Store guards data payloads against non-object corruption**: `Store.update`/`create` previously spread a raw string payload into numeric character keys, producing stored data that wiped the store on next load via schema validation. Payloads are now normalized at the persistence boundary (plain object passes, JSON-string-of-object is parsed, anything else throws a clear error) with tool wrappers returning a soft `{success:false, error}`.
- **Stored XSS / page break from inline session data**: the session page seeds session data (logs, tokens, flags) inline via `JSON.stringify`, which doesn't neutralize the `</script>` sequence, so a log field carrying it (e.g. a `filesystem_write` input that is itself an HTML file) closed the page script early and could inject executing markup. All eight inline-script injections now escape `<` to its `<` form (still valid JSON).
- **`javascript:`/`data:` URLs in approval cards**: agent-supplied `artifact_url`/`draft_url` values are sanitized to `http(s)` only at the data source and via an `await_human` schema refine; previously such a scheme survived HTML-escaping and ran on click. Raw HTML artifacts opened in a new tab now also get an opaque origin (header CSP `sandbox` directive + `X-Frame-Options`) instead of running same-origin.
- **Approval gates in delegated subagents fail loud (extended)**: a subagent configured with `tools: { await_human: true }` (not just `approval:` frontmatter) is now also rejected at load time, closing a bypass that posted a dead-end Slack card and orphaned a pending approval the single-session resume machinery can't honor.
- **Resuming Slack approvals from a standalone `agentuse run`**: a non-`serve` run carries no project id, so its approval resumed against the default/first project's storage and failed with `SESSION_NOT_FOUND`. Session lookups now locate the project that actually owns the session (a session lives in exactly one project) instead of collapsing to the default, which is only a routing preference for new runs.
- **Faster dashboard scans over large session stores**: date-windowed session/approval scans previously read and parsed every `session.json` before applying the time filter, blowing past the 30s per-project worker timeout on large stores ("Some projects failed to load"). The creation time is now decoded from the directory-name ULID prefix and out-of-window files are skipped (verified: identical result set, 93% fewer reads on a ~6,900-session store).
- **Comment dialog mobile layout**: the dialog footer stacks vertically with full-width action buttons on phones (no more overflow), the keyboard hint is hidden, and the textarea uses a 16px font so iOS Safari doesn't auto-zoom when it gains focus.
- **Branch-review hardening (correctness and perf)**: a batch of smaller fixes surfaced by two code-review passes, including: `await_human` registers its abort handle before async run setup so a stop racing setup isn't dropped; resumed nested subagents read/write their own session and tools snapshot instead of a top-level path; MCP connection-failure warnings name the real server instead of "unknown"; the file watcher hot-reloads the env file that actually changed and stops firing callbacks mid-shutdown; overlapping runs of the same schedule are skipped; subagent `AbortError` re-throws so parent timeout/cancellation propagates; `readJSON` returns `null` only on `ENOENT` and re-throws corrupt JSON; failed compaction throws instead of fabricating a fake summary; a timed-out sandbox exec reports "timed out" rather than a stray container-teardown error; the model-registry dedup lets `release_date` decide only when both sides have one (a newer-but-undated model is no longer dropped for an older dated sibling); the artifact route is exempt from the header auth gate so the in-page viewer works on keyed deploys (the handler still enforces the session token); and `serveSessionArtifact` uses async fs with a realpath symlink check to keep the event loop unblocked and the containment guard sound.

### Documentation

- Documented `agentuse doctor`, the skill directory placeholders, the `skills: trusted` config, the sandbox `$HOME` guard, and the implicit `learning.apply: false` default.
- Reworked the serve docs around the unified session page and session token: rewrote the approval-gates API section to the `sessions` routes (noting the `approvals` redirect and legacy aliases), documented `GET /api/sessions` and `GET /api/sessions/:id`, added browser-based session browsing to the session-logs guide, and moved the documented JSON endpoints under the `/api` prefix.
- Fixed the self-hosting Docker health check to ping the `/api` server-info endpoint instead of the POST-only run endpoint, and added agent-authoring gotchas.
- Documented the `AGENTUSE_TOOL_*` env vars and head+tail truncation behavior in the environment-variables and builtin-tools references, and added a tool-output best practice to the context-management guide.
- Documented the OpenAI `promptCacheKey` / `promptCacheRetention` options in the agent-syntax reference and model-configuration guide.
- Updated the README for the `/api/*` JSON prefix, the session-page review flow, `agentuse doctor`, and added a Commercial Support section.

## [0.13.0] - 2026-05-12

This is a large pre-1.0 release centered on human-in-the-loop agent workflows. Approval gates, the Approval API, web approval pages, and channels/Slack integrations are currently **experimental**: the core workflow is ready to try, but configuration shape, UI details, and API response formats may evolve based on production feedback.

### Added

- **Approval gates**: agents can now pause for human review with `approval: true`, then resume after a reviewer approves, rejects, or comments.
- **Web approval dashboard**: `agentuse serve` now exposes `/approvals` for reviewing pending approvals, inspecting approval context, and continuing completed or errored approval sessions.
- **Slack channels**: agents can post approval, completion, and failure updates to Slack using `channels.slack`, with support for compact status cards, threaded approval details, and Socket Mode actions.
- **Slack review threads**: approval notifications keep the channel message concise while placing summaries, drafts, artifacts, context, and risks in the Slack thread.
- **Session continuation**: `agentuse sessions resume` can approve, reject, comment on suspended approval sessions, provide tool results for suspended `await_*` tools, or continue ended sessions with a follow-up prompt.
- **Store browser**: `serve` includes a web UI for browsing agent stores, including sortable tables and links from session/tool activity to relevant store items.
- **Expanded OpenAI reasoning effort support**: OpenAI model configuration now accepts the full supported effort set, including `none`, `minimal`, and `xhigh` where the selected model supports them.

### Changed

- `serve` now enforces a single daemon owner so approval links, Slack replies, session resumes, and API traffic route through one process.
- Approval pages, session logs, and serve navigation were redesigned for better review flow and clearer running tool details.

### Fixed

- Restores pending approval state when resume preflight or resumed execution fails.
- Persists gate notifications and improves page status feedback during approval and resume flows.
- Allows quoted `agent-browser eval` payloads while hardening bash command validation against unsafe command chaining.
- Resolves relative filesystem paths more consistently in tool/path validation.
- Treats built-in `demo:` models as valid even though they are intentionally not listed in the generated external model registry.
- Skips Docker sandbox orphan cleanup for containers owned by live AgentUse processes and guards cleanup against PID reuse.

### Documentation

- Added guides for Approval Gates and Channels.
- Updated agent syntax, CLI commands, environment variables, configuration files, session logs, store, model configuration, webhooks, CI/CD, and related guides for the new approval/channel workflow.

## [0.12.0] - 2026-04-28

### Added

- **Multi-project `serve`**: one `serve` process hosts multiple project roots, selected by the `project` request field. Schedulers and storage stay isolated; `GET /` lists projects.
- **Per-PID flat log file**: `agentuse serve logs` tails or prints worker log files.
- **Global config at `~/.agentuse/config.json`** (or `AGENTUSE_CONFIG`). Supports `serve.projects`, `serve.default`, `serve.port`, `serve.host`, `serve.auth`, and `serve.logFile`. CLI flags override config; `-C` replaces `serve.projects`; the API key remains env-only.

### Fixed

- `serve` worker validates required env vars at startup and dedupes Node experimental warnings.
- `agentuse run -C <dir>` treats `-C` as the project root instead of walking upward.
- Non-git project sessions are isolated per project.

### Documentation

- README, webhooks guide, and CLI reference updated for multi-project `serve`, `GET /`, and `serve logs`.

## [0.11.0] - 2026-04-24

### Added

- **Amazon Bedrock provider** (`bedrock:`) via `@ai-sdk/amazon-bedrock`, thanks to @lseguin1337
  - Three authentication modes: static AWS credentials (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION`, optional `AWS_SESSION_TOKEN`), Bearer token (`AWS_BEARER_TOKEN_BEDROCK`), and AWS SDK credential provider chain (`AWS_PROFILE` / SSO / EC2/ECS/EKS instance roles)
  - `parseModelConfig` preserves colons in Bedrock model IDs (e.g. `bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0`)
  - Static model-registry validation is skipped for `bedrock:` so any AWS-supported model ID is accepted
  - `bedrock` is reserved as a built-in provider name, preventing shadowing via `provider add bedrock`
  - Documentation updates: model configuration guide, models reference, CLI commands, environment variables, self-hosting, agent syntax

### Changed

- `@aws-sdk/credential-providers` is declared as an **optional** dependency, users authenticating with static keys or Bearer tokens skip the ~16 MB / 85 transitive dependencies. Install it explicitly (`pnpm add @aws-sdk/credential-providers`) only when using `AWS_PROFILE`, SSO, or instance roles

## [0.10.0] - 2026-03-10

### Added

- **Custom provider support** for OpenAI-compatible endpoints via `agentuse provider add <name> --url <url>`
- Custom provider authentication with optional API key storage
- `provider add` and `provider remove` CLI commands for managing custom endpoints

### Changed

- Rename `auth` command to `provider` for managing providers and credentials
- Refactor model version sorting to use integer-based comparison, fixing incorrect ordering for hyphen-format versions (e.g., `claude-sonnet-4-6`)
- Improve default OpenAI model selection in docs generation with stricter regex matching
- Update model registry with latest model entries

### Fixed

- Fix version sorting bug where `4-6` was parsed as `4.6` float instead of `4006` integer, causing incorrect model ordering
- Fix duplicate `writeFileSync` call in model generation script

### Documentation

- Expand model configuration guide with custom provider setup instructions
- Add custom provider examples and usage patterns to models reference

---

## [0.9.0] - 2026-03-10

### Added

- **Docker-based sandbox execution** with per-path filesystem mounting, replacing E2B
- Orphaned container cleanup and graceful shutdown for sandbox environments
- Docker image auto-pull for seamless sandbox setup
- Path validator module for sandbox mount validation

### Changed

- Switch plugin compilation from esbuild-wasm to native esbuild, fixing WASM crashes in bun test environment
- Tighten skill name validation to enforce lowercase alphanumeric with single hyphens and optional colon namespacing
- Update model references to Claude 4.6
- Consolidate isolated environment guide into new sandbox guide

### Documentation

- Add sandbox guide with Docker-based execution instructions
- Update self-hosting guide for sandbox workflow
- Update model references across documentation

---

## [0.8.0] - 2026-02-04

### Added

- **[Experimental]** Manager agent type with orchestration and store support for coordinating multi-agent workflows
- **[Experimental]** Schedule awareness for manager agents to pace work appropriately
- **[Experimental]** Agent learning system with evaluation and injection of learnings from past sessions
- **[Experimental]** Persistent store with locking and atomic writes for data safety
- Session status tracking with completion markers and error logging
- Explicit agent ID/name support in frontmatter configuration
- Agent ID tracking in session metadata for improved traceability

### Changed

- Replace agent.name with agent.id for session and store identifiers (breaking change)
- Make agent.id mandatory with migration logic for existing sessions
- Move learning injection from system messages to agent instructions
- Improve sessions list CLI readability
- Optimize agent file watching with glob pattern
- Extract tool loading and system message building into separate modules
- Improve bash path access validation with clearer skill warnings

### Fixed

- Track error states for tool execution results
- Include toolCallId in error tool results
- Prevent race conditions with serialized writes during interrupts
- Resolve race condition in tool result updates
- Suppress telemetry errors and add shutdown timeout

### Documentation

- Add manager agents and store guides
- Add learning guide with experimental warnings
- Improve quickstart and demo content

---

## [0.7.1] - 2026-01-27

### Added

- Demo provider (`demo:hello`, `demo:welcome`) for zero-config trials - no API keys required

### Changed

- Update hello-world template to use demo provider

---

## [0.7.0] - 2026-01-27

### Added

- `agentuse add` command for installing skills and agents from GitHub or local sources
- Interactive selection and filtering options for add command
- `agentuse serve ps` subcommand to list running servers with process registry
- Session-level error tracking for pre-execution failures

### Fixed

- Prevent duplicate server instances in serve mode with improved error handling
- Make Bash tool timeout input schema dynamic based on user config

---

## [0.6.0] - 2026-01-20

### Added

- OpenAI ChatGPT OAuth (Codex) authentication support
- `agentuse agents` command to discover and list project agents
- File reader tool for loaded skill directories
- Human-readable cron format display in scheduler
- Version and notes fields in agent schema

### Changed

- Refactor auth storage to support separate OAuth and API key management

### Fixed

- Remove unimplemented config markers from project root search
- Auto-append `.agentuse` extension when resolving agent files
- Ensure session updates complete before returning
- Deep sort nested objects in doom loop detector for consistent comparison
- Improve tool call feedback with running state and metadata hints

---

## [0.5.1] - 2026-01-08

### Fixed

- Handle agent requests concurrently instead of sequentially in worker
- Execute agents in subprocess to avoid EBADF in async callbacks

---

## [0.5.0] - 2026-01-04

### Added

- Cron-based agent scheduling for serve mode (`scheduler` config in agent YAML)
- API key authentication for exposed hosts (`AGENTUSE_API_KEY` environment variable)
- Hot reload for agent and environment files in serve mode
- Telemetry for server events and executions
- Pre-flight environment variable validation for agents
- Path variable resolution in tool validators

### Changed

- Simplify scheduler config to single string format
- Rename `--all` flag to `--subagents` in sessions command
- Improve serve startup output and quiet dotenv config
- Display allowed file paths in Bash tool description

### Fixed

- Use explicit directory as project root in serve mode
- Resolve symlinks for Bash path validation consistency

### Documentation

- Add scheduler feature documentation and tests
- Add schedule and webhooks guides
- Add built-in tools reference documentation
- Reorganize guides into Building and Running sections
- Consolidate production deployment into self-hosting guide
- Consolidate duplicate content with cross-references

---

## [0.4.3] - 2026-01-02

### Added

- Agent benchmarking system with evaluation and reporting (`agentuse benchmark` command)

### Documentation

- Update model names and examples in documentation

---

## [0.4.2] - 2025-12-30

### Added

- Bash tool `allowedPaths` config for additional directories beyond project root (e.g., shared repos, temp directories)
- Anonymous usage telemetry (opt-out via `AGENTUSE_TELEMETRY=false`)

### Changed

- Improved logger display for built-in tools (Skill, Bash, Read, Write, Edit) with color-coded badges
- Simplified Skill tool result to show "Loaded" instead of full content

---

## [0.4.1] - 2025-12-29

### Added

- Replace regex parsing with tree-sitter AST for bash tool output parsing

### Fixed

- Skip error detection for skill tool output in runner

### Changed

- Split monolithic runner file into focused modules
- Streamline MCP tool output handling

### Documentation

- Add CI/CD integration guide

---

## [0.4.0] - 2025-12-25

### Features

**Skill System**
- Add skill system for reusable agent instructions with SKILL.md file support
- New `agentuse skills` command to discover and list skills from project and user directories
- Skill discovery from multiple directories (.agentuse/skills, ~/.agentuse/skills, .claude/skills, ~/.claude/skills)

**CLI Improvements**
- Add `--no-tty` flag and `NO_TTY` environment variable to disable TUI output for automation
- Add `--compact` flag for single-line header instead of ASCII logo
- Improved execution summary with duration, tokens, and tool calls
- Cleaner output with verbose logs moved to debug level
- Agent metadata block displaying name, model, and tool count

**Deployment**
- Docker support with multi-arch builds (amd64/arm64)
- Multi-stage Dockerfile using Bun for compilation and Alpine for runtime
- Includes Node.js, Python, and common utilities for agent execution

### Fixes

- Disable TUI mode in CI environments (GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite, Travis, Azure Pipelines)
- Fix model provider validations

### Documentation

- Add skills guide and CLI command reference
- Add `agentuse serve` command reference with comprehensive API documentation
- POST /run endpoint with request/response schemas
- Error codes, HTTP status mappings, and NDJSON streaming examples
- Update OAuth setup for self-hosting with `CLAUDE_CODE_OAUTH_TOKEN`
- Add `setup-github` command for automated GitHub Actions secret configuration
- Add isolated environment guide for local sandboxed development
- Add self-hosting guide for production deployments

### Refactoring

- Add debug logging and improve runner initialization
- Enhanced lifecycle logging with configurable debug mode
- Better error handling in runner start/stop
- Remove `--output` flag from setup-github for simplified auth flow

### Maintenance

- Upgrade AI SDK to v6 (ai@6.0.3, @ai-sdk/anthropic@3.x, @ai-sdk/openai@3.x, @ai-sdk/mcp@3.x)
- Migrate `experimental_createMCPClient` to stable `createMCPClient`
- Add @ai-sdk/devtools as dev dependency with optional middleware (AGENTUSE_DEVTOOLS=true)
- Remove deprecated @types/glob dependency

---

## [0.3.0] - 2025-12-24

### Features

**Configurable Builtin Tools with Security Controls**
- New tools system for agent YAML configs with filesystem and bash tools
- Filesystem read/write/edit tools with path-based access control
- Bash tool with command allowlist and denylist validation
- Path traversal protection with symlink resolution
- Doom loop detector to catch agents stuck in repetitive tool calls
- Support for glob patterns in path and command configs

**HTTP Server for Running Agents via API**
- New `agentuse serve` command exposes agents via HTTP endpoint
- Supports both JSON and NDJSON streaming responses
- Configurable host, port, and working directory

**Model Registry**
- New `agentuse models` command to list recommended models
- Script to generate model registry from models.dev API

**Tool Improvements**
- Add optional `workdir` parameter to bash tool for setting command working directory
- Fuzzy string matching for edit tool to handle LLM errors (7 progressively fuzzier match strategies)
- Dynamic tool descriptions showing configured allowlist patterns

### Security

**Hardened Bash Command Execution**
- Sanitize environment variables before command execution (LD_PRELOAD, DYLD_*, NODE_OPTIONS, etc.)
- Detect and block command/process substitution (`$()`, backticks, `<()`)
- Block network exfiltration patterns (piping to nc/curl/wget)
- Block reverse shell patterns (nc -e, bash -i)
- Block credential theft patterns (reading history, SSH keys)
- Check fork bomb patterns before parsing

### Fixes

- Extract tool success status from nested result formats (bash errors now properly reflected)
- Improve type safety for tool result handling
- Resolve path variables in tool descriptions
- Fix multi-line command matching with dotAll regex flag

### Documentation

- Add comprehensive variables reference (`${root}`, `${agentDir}`, `${tmpDir}`, `${env:VAR_NAME}`)
- Update environment variable syntax from `${VAR_NAME}` to `${env:VAR_NAME}`
- Update model references to latest 2025 versions (Claude 4.5, GPT-5.2)
- Update messaging to emphasize unattended execution via cron, CI/CD, and serverless

### Other

- Extract ASCII logo to shared branding utility
- Comprehensive test suites for security, workdir, and fuzzy edit replacers

---

## [0.2.0] - 2025-12-21

### Features

**Session Tracking and Logging**
- Comprehensive tracking of agent interaction parts (text, tool calls, tool results)
- Session management with detailed metadata for observability and debugging
- New `agentuse sessions` command with `list`, `show`, and `path` subcommands
- Duration tracking and final token usage in session view
- `--full` flag to show complete tool I/O (truncated by default)

**Improved Agent Execution**
- Robust interrupt and timeout management with graceful Ctrl-C handling
- Multi-stage interrupt mechanism with abort signal propagation to subagents
- Debounced text part updates to prevent race conditions

### Fixes

- Move `createMCPClient` import to `@ai-sdk/mcp` after AI SDK 5.0.79 changes
- Pin AI SDK package versions for stability

### Documentation

- Add session logs guide with CLI reference and schemas
- Refactor session docs into guide and reference pages

---

## [0.1.5] - 2025-12-20

### Fixes

- Move `createMCPClient` import to `@ai-sdk/mcp` (removed from `ai@5.0.79`)
- Pin AI SDK package versions

---

## [0.1.4] - 2025-10-20

### Features

**Improved Logging and UI**
- Animated spinner for tool execution progress
- TUI-aware formatting with colored badges for tools and sub-agents
- LLM spinner tracking with first-token latency display
- Context-aware truncation for log values preserving important fields
- Explicit subagent prefixes (`subagent__`) for unambiguous identity

**Enhanced Tool Handling**
- Detailed logging for MCP tool retrieval and errors
- Preload HTTP tools and use cached `preloadedTools` when available
- Log disallowed tools instead of silent skip
- Tool timeout configuration via server config or `MCP_TOOL_TIMEOUT` env var

**Agent Execution Improvements**
- CLI and YAML overrides for timeout and max steps (default reduced from 1000 to 100)
- Subagent nesting depth control with cycle detection (default max depth: 2)
- `hasTextOutput` and `finishReason` metadata for detecting incomplete runs

**Configuration**
- Support camelCase `mcpServers` (deprecate `mcp_servers`)
- Base URL resolution for providers with suffix-based variants

### Fixes

- Handle `text-start`/`text-end` streaming events correctly
- Validate subagent depth env and correct log depth
- Replace `console.error` with `logger.error` in tool call errors

### Documentation

- Rename `mcp_servers` to `mcpServers` across docs

---

## [0.1.3] - 2025-09-25

### Features

**Plugin System**
- TypeScript plugins via esbuild-wasm bundling and dynamic import
- JavaScript plugin hot-reload with cache-busting
- Performance trace reporting with `ToolCallTrace` interface

**CLI Improvements**
- `--model` override flag to override agent model (propagates to sub-agents)
- `-C/--directory` option (works like `git -C`)
- Project-based path resolution for portable agent projects

**Agent Configuration**
- Optional `description` field for agents (shown in logs and events)
- Detailed tool and LLM trace collection with timing metadata

**Subagent Handling**
- Mark and log subagent tool calls distinctly
- Clarify that sub-agents cannot nest (subagent entries ignored)

### Fixes

- Simplify `-C/--directory` to just cd first, then run normally
- Fix directory path detection in `findProjectRoot`
- Resolve test isolation issues between plugin tests

### Documentation

- Update docs links from cookbook to templates

---

## [0.1.2] - 2025-08-30

### Features

**Documentation Overhaul**
- New docs integrated with Mintlify
- Clarify agent SOPs, delegation, and communication patterns
- Add OpenAI GPT-5 provider options (`reasoningEffort`, `textVerbosity`)

**CLI Improvements**
- `--env-file` option to specify custom .env path
- Improved logging and fatal error handling for MCP
- Switch docs and scripts to pnpm

**New Agent Templates**
- `hello-world` - minimal greeting agent
- `website-change-tracker` - monitoring agent with Slack alerts
- `daily-ai-news` - AI news researcher with Exa and Slack

### Fixes

- Simplify `connectMCP` signature and harden result check
- Clarify security warning for remote agents (Danger callout)

---

## [0.1.1] - 2025-08-22

### Features

- Accept optional prompt args for run command (`run <file> [prompt...]`)
- `formatWarning` helper for concise tool error logs
- AuthenticationError for clearer typed auth failures

### Fixes

- Fix Bun invocation in README example

### Other

- Add np config for releases
- Remove legacy agent-generator module

---

## [0.1.0] - 2025-08-22

Initial release.

### Features

- Multi-provider support (OpenAI, Anthropic) with flexible model config parsing
- MCP server integration with environment variable control
- Streaming execution with step counting
- Auth storage for managing credentials on disk
- Verbose logging mode with tool call/result separation
- Parallel server connections and tool fetching
- Raw MCP SDK client for resource access
- JSON env var parsing for complex MCP configurations

### CLI

- `run` command with `--quiet` and `--debug` options
- Auth commands for credential management
