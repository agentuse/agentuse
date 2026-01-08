# Changelog

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
