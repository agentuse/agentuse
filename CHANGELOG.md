# Changelog

## [0.14.0] - 2026-06-06

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
- **Session stop controls**: a running session (including delegated subagents) can now be stopped from the `serve` web UI and the `agentuse sessions` CLI; stopping a session also clears its pending approvals.
- **Session filters and approval history links**: the `serve` sessions list gains filtering, and approval history entries link back to their sessions.
- **More OpenRouter model series**: the model registry now includes OpenRouter `deepseek`, `qwen`, `kimi` (moonshotai), `gemini` (google), and `grok` (x-ai) series, with per-line dedup that keeps only the latest release of each product line.

### Changed

- **JSON API moved under an `/api` prefix** (potentially breaking). All JSON `GET` endpoints now live under `/api/*` (`/api`, `/api/agents`, `/api/schedules`, `/api/sessions`), replacing the old `?format=json` content negotiation, which has been **removed**. The root and the `/agents` / `/schedules` paths now return HTML. `POST /api/run`, `POST /api/resume`, and the approval action routes keep working at their original un-prefixed paths (`/run`, `/resume`, …) for backward compatibility, but those legacy aliases are deprecated and will be removed in a future release. Update self-hosting health checks and any scripted JSON consumers to the `/api/*` paths.
- **Sessions follow the agent file across working directories**: session identity and resume now key off a `stateRoot` derived from the agent file (with extensionless path support) rather than the current working directory, so a session can be inspected and resumed from a different `cwd`. Sandbox bind mounts continue to use the cwd-derived project root.
- **Scheduled runs are staggered** so many agents sharing the same cron expression no longer all fire in the same instant.
- **Live session feedback**: the running status pill pulses, finished sessions open at the top of the log while an active gate auto-scrolls to the bottom, and a persistent "session running" footer signals progress during the thinking gap between steps. Dashboard HTML is sent with `Cache-Control: no-store` so a tab left open across a restart never runs stale inline JS.
- **Autonomous agent prompts are stricter about silent execution**, reducing intermediate narration, tool-call announcements, and repeated summaries before the final terminal-friendly result.
- `GET /approvals/:id` now redirects to `sessions/:id`; the legacy `approvals/:id/*` action routes remain as transition aliases.
- `learning.apply` now defaults to `false` when omitted, so learnings are extracted but only injected after manual review unless auto-apply is explicitly enabled.
- **Bash tool output uses head + tail truncation**: large output is now truncated to keep both the start and the end (40/60 split) with an omitted-bytes marker in the middle, instead of head-only. This preserves errors and recent output at the tail of big diffs and command runs.
- **Sandbox exec lifetime is bounded**: Docker sandbox commands (and image setup) now run under a timeout that kills and removes the container on expiry, so a runaway sandboxed command can no longer hang a run indefinitely.
- **Cached token usage is tracked and persisted**: prompt-cache read/write token counts are accounted across runs (including subagents), persisted with session usage, and surfaced in the `serve` session views and usage totals.
- **Model registry generation auto-tracks major versions** from models.dev rather than hardcoded version floors, so new majors are picked up automatically and stale builds age out; the doc reference updater is now vendor- and token-aware (fixing the MiniMax-routed-to-Gemini mismatch).
- **Live session view refinements**: session status handling and the session-view polling in `serve` were improved for more accurate, lower-overhead status updates.
- **Approvals page tidy-up**: completed approvals are hidden from the approvals page, approval history labels are shortened, and pending approvals are cleared when their session stops.

### Fixed

- **Agent file hot reload works with Chokidar v5**: `serve` now watches concrete `.agentuse` files and reconciles additions/removals, so schedule changes and newly added agents are picked up without relying on unsupported glob watching or broad root-directory watchers that can exhaust file descriptors.
- **Skill discovery is compatible with existing assistant skills**: `SKILL.md` files may omit `name` or `description`, names are inferred from the containing directory when missing, explicit names may use broader assistant-style formats, and directory/name mismatches no longer cause the skill to be skipped.
- **Doom-loop detection no longer flags intentional repeated commands** when meaningful model text appears between identical tool calls; truly consecutive identical calls still trigger the guard.
- **Deprecated `mcp_servers` warnings are emitted once per process** instead of repeating every time an agent is parsed.
- **Sandbox no longer mounts `$HOME` as the project root**: `findProjectRoot` stops its upward walk at `$HOME` (falling back to the starting directory) instead of treating a marker like `.agentuse`, `.git`, or `package.json` in the home directory as a project root, and `createSandbox` refuses to bind-mount a project root that resolves to `$HOME` or an ancestor. This prevented the Docker sandbox from exposing `~/.ssh`, `~/.aws`, and the rest of `$HOME` to `sandbox__exec`. Project-root detection also respects the `$HOME` env var.
- **Anthropic OAuth tokens refresh before expiry** (within a 5-minute buffer) and **concurrent refreshes no longer race**, avoiding mid-run auth failures and duplicate refreshes.
- **Slack Socket Mode log storms reduced**, cutting repetitive connection logging.
- Agents always receive a default skills config from the parser, so skill loading behaves consistently when `skills` is omitted.
- **Approval gates in delegated subagents fail loud**: a `type: manager` agent delegating to a subagent with `approval: true` previously completed the run silently while leaving an orphaned, un-resumable pending approval (the subagent never propagated the `await_human` suspension to the parent session). Approval in a delegated subagent is now rejected at load time with a clear error; gates are supported only on the top-level/manager agent. See #107 for the design discussion.
- **Subagent session logs render in the `serve` view**: subagent sessions stored nested under their parent (`{parent}/subagent/{sub}`) are now resolved by basename when the computed path is empty, so a running or resumed subagent no longer shows "No session events yet."; resumed-subagent session lookup is also fixed.
- **Store lock no longer leaks across concurrent runs**: the `serve` worker handles execute/resume requests concurrently, and overlapping `Store` instances previously drifted the lock ref count so the lock file was never deleted, permanently blocking every other process. Acquire/release is now serialized per lock path with an async mutex, the ref count is the sole authority for same-process re-entrancy, same-PID leftover lock files are reclaimed, and the store lock is released before a session flips to completed/suspended.
- **Store guards data payloads against non-object corruption**: `Store.update`/`create` previously spread a raw string payload into numeric character keys, producing stored data that wiped the store on next load via schema validation. Payloads are now normalized at the persistence boundary (plain object passes, JSON-string-of-object is parsed, anything else throws a clear error) with tool wrappers returning a soft `{success:false, error}`.

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

- **Amazon Bedrock provider** (`bedrock:`) via `@ai-sdk/amazon-bedrock` — thanks to @lseguin1337
  - Three authentication modes: static AWS credentials (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION`, optional `AWS_SESSION_TOKEN`), Bearer token (`AWS_BEARER_TOKEN_BEDROCK`), and AWS SDK credential provider chain (`AWS_PROFILE` / SSO / EC2/ECS/EKS instance roles)
  - `parseModelConfig` preserves colons in Bedrock model IDs (e.g. `bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0`)
  - Static model-registry validation is skipped for `bedrock:` so any AWS-supported model ID is accepted
  - `bedrock` is reserved as a built-in provider name, preventing shadowing via `provider add bedrock`
  - Documentation updates: model configuration guide, models reference, CLI commands, environment variables, self-hosting, agent syntax

### Changed

- `@aws-sdk/credential-providers` is declared as an **optional** dependency — users authenticating with static keys or Bearer tokens skip the ~16 MB / 85 transitive dependencies. Install it explicitly (`pnpm add @aws-sdk/credential-providers`) only when using `AWS_PROFILE`, SSO, or instance roles

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
