# Telemetry Integration Research for AgentUse

> **Research Date:** October 20, 2025
> **Purpose:** Investigate how popular open source projects implement telemetry to understand actual usage patterns and provide recommendations for AgentUse.

## Executive Summary

This document provides comprehensive research on telemetry implementations across popular open source projects. Based on analysis of Next.js, VS Code, Homebrew, Astro, Go toolchain, and other major projects, we've identified best practices, common patterns, and privacy-preserving approaches suitable for AgentUse.

**Key Findings:**
- Most successful OSS projects use opt-out telemetry with clear first-run notifications
- Privacy is paramount: collect minimal, anonymous data only
- Multiple opt-out methods (env vars + CLI commands) are standard
- PostHog is the most popular telemetry backend for privacy-conscious OSS projects
- Transparent telemetry (Go's approach) represents the gold standard for privacy

---

## Table of Contents

1. [Popular OSS Projects Analysis](#1-popular-oss-projects-analysis)
2. [Telemetry Backends & Services](#2-telemetry-backends--services)
3. [Best Practices](#3-best-practices)
4. [Privacy-Preserving Approaches](#4-privacy-preserving-approaches)
5. [Recommendations for AgentUse](#5-recommendations-for-agentuse)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [References](#7-references)

---

## 1. Popular OSS Projects Analysis

### 1.1 Next.js (Vercel)

**What they track:**
- Commands invoked (`next build`, `next dev`, `next export`)
- General machine information (OS, architecture)
- Plugins and integrations used
- Build performance metrics

**Privacy approach:**
- Completely anonymous
- No personal data, file paths, or code content
- No environment variables or sensitive data

**Opt-out methods:**
```bash
# CLI command
npx next telemetry disable

# Environment variable
NEXT_TELEMETRY_DISABLED=1

# Debug mode (print without sending)
NEXT_TELEMETRY_DEBUG=1
```

**Community feedback:**
- ❌ Telemetry is opt-out by default (generated pushback)
- ✅ Clear documentation on what's collected
- ✅ Easy to disable

**Source:** https://nextjs.org/telemetry

---

### 1.2 VS Code (Microsoft)

**Architecture:**
- Backend: Azure Monitor + Application Insights
- Collection module: `@vscode/extension-telemetry` npm package
- High-resolution event traces (10s-100s events per minute)

**Data classification system:**
1. **SystemMetaData**: Non-personally identifiable generated values
2. **CallstackOrException**: Scrubbed stack traces from errors
3. **PublicNonPersonalData**: Public info like extension IDs
4. **EndUserPseudonymizedInformation**: Hashed identifiers (NIC hash + UUID)

**Privacy features:**
- User identification via hash (not reversible)
- No telemetry endpoints in OSS builds by default
- Configurable via `product.json`

**Source:** https://code.visualstudio.com/api/extension-guides/telemetry

---

### 1.3 Homebrew

**Architecture:**
- Backend: InfluxDB (time-series database)
- 365-day retention period
- Public JSON API for aggregate data

**Privacy approach:**
- Completely anonymous
- Impossible to match events to specific users
- **No IP addresses stored or received**
- Source code publicly visible (`analytics.rb`, `analytics.sh`)

**Opt-out methods:**
```bash
brew analytics off

# Or environment variable
HOMEBREW_NO_ANALYTICS=1
```

**Transparency:**
- ✅ First-run notification before enabling
- ✅ Publicly accessible aggregate data
- ✅ Open source implementation

**Purpose:**
Prioritize fixes and features based on how, where, and when people actually use Homebrew.

**Source:** https://docs.brew.sh/Analytics

---

### 1.4 Astro

**Implementation:**
- Package: `@astrojs/telemetry`
- Location: `packages/telemetry/` in monorepo
- Backend: PostHog (privacy-focused analytics)

**What they track:**
- Command invoked (`astro build`, `astro dev`, etc.)
- CPU count, OS type
- CI environment detection
- Integrations and adapters used
- Configuration options (markdown, etc.)

**Opt-out methods:**
```bash
astro telemetry disable
astro telemetry enable

# Environment variable
ASTRO_TELEMETRY_DISABLED=1
```

**Source:** https://github.com/withastro/astro/tree/main/packages/telemetry

---

### 1.5 Go Toolchain (Transparent Telemetry)

**Innovation:** "Transparent Telemetry" by Russ Cox

**Key principles:**
1. **Opt-in by design** (privacy-first)
2. Open, public process for deciding metrics
3. Tamper-evident transparent log
4. Minimal data collection (kilobytes per year)
5. **Every bit collected is published publicly**

**Architecture:**
- Repository: `golang.org/x/telemetry`
- Counter values stored in per-week local files
- Configuration served via transparent log
- Public review process for new metrics

**Core packages:**
- `counter`: Instrument programs with counters
- `upload`: Upload telemetry data
- `cmd/gotelemetry`: Manage telemetry config

**What makes it "transparent":**
- Decisions about metrics made in open, public process
- Collection config auto-generated from tracked metrics
- Config served using tamper-evident transparent log
- All collected data published for inspection

**Community reception:**
- ✅ Highly regarded for privacy-preserving approach
- ✅ Academic rigor in design
- ⚠️ More complex infrastructure required

**Sources:**
- https://research.swtch.com/telemetry-intro
- https://github.com/golang/telemetry
- https://github.com/golang/go/discussions/58409

---

### 1.6 Turborepo (Vercel)

**Implementation:**
- Config stored at: `~/.config/turborepo/telemetry.json`
- First-run notification with opt-out instructions
- Anonymous usage and host information

**Known issues:**
- ⚠️ Telemetry warnings sent to stderr (breaks JSON parsing)
- ⚠️ Can interfere with programmatic usage

**Lesson learned:** Telemetry shouldn't break JSON output or interfere with CI/CD

**Source:** https://turbo.build/repo/docs/telemetry

---

### 1.7 Artillery (Load Testing CLI)

**Implementation:**
- Backend: PostHog
- Privacy-conscious by design

**What they DON'T collect:**
- ❌ No personally identifiable information
- ❌ No usernames or hostnames
- ❌ No file names or paths
- ❌ No environment variables
- ❌ No IP addresses

**Opt-out:**
```bash
ARTILLERY_DISABLE_TELEMETRY=true
```

**Source:** https://www.artillery.io/docs/resources/telemetry

---

### 1.8 .NET SDK/CLI (Microsoft)

**Privacy approach:**
- No personal data (usernames, emails)
- No code scanning or project-level data
- System-generated metadata only

**Opt-out:**
```bash
DOTNET_CLI_TELEMETRY_OPTOUT=1
# or
DOTNET_CLI_TELEMETRY_OPTOUT=true
```

**Source:** https://learn.microsoft.com/en-us/dotnet/core/tools/telemetry

---

## 2. Telemetry Backends & Services

### 2.1 PostHog (Recommended for OSS)

**Overview:**
- Open source product analytics platform
- Self-hosted or cloud options
- Privacy-focused by design

**Used by:**
- Astro
- Artillery
- Traceloop (OpenLLMetry)
- Continue (VS Code extension)
- Speakeasy SDKs

**Features:**
- Event tracking and analytics
- Feature flags
- Session replay (optional)
- A/B testing
- User segmentation

**Why popular for OSS:**
- ✅ Self-hosting option (full data control)
- ✅ Open source SDKs
- ✅ Privacy-friendly
- ✅ Easy integration
- ✅ Free tier available

**Example implementation:**
```typescript
import { PostHog } from 'posthog-node';

const client = new PostHog(
  'API_KEY',
  { host: 'https://app.posthog.com' }
);

client.capture({
  distinctId: 'anonymous_user_hash',
  event: 'command_executed',
  properties: {
    command: 'run',
    os: 'linux',
    node_version: '18.0.0'
  }
});
```

---

### 2.2 Application Insights (Azure)

**Used by:**
- VS Code
- Microsoft tooling

**Features:**
- Enterprise-grade analytics
- Deep integration with Azure
- Advanced query capabilities
- Real-time monitoring

**Pros:**
- ✅ Robust and scalable
- ✅ Comprehensive SDK support
- ✅ Advanced analytics

**Cons:**
- ❌ Requires Azure account
- ❌ Not open source
- ❌ Overkill for small projects

---

### 2.3 InfluxDB

**Used by:**
- Homebrew

**Type:** Time-series database

**Pros:**
- ✅ Excellent for metrics over time
- ✅ Self-hostable
- ✅ Open source
- ✅ Efficient storage

**Use case:** Best for tracking trends and patterns over time

---

### 2.4 Sentry

**Type:** Error tracking + performance monitoring

**Features:**
- Open source SDKs
- Self-hosted or cloud
- OpenTelemetry integration
- Error tracking with stack traces
- Performance monitoring

**Best for:** Error tracking rather than usage analytics

**Source:** https://sentry.io

---

### 2.5 Custom Solution

**Approach:** Simple HTTP endpoint + database

**Pros:**
- ✅ Full control
- ✅ No third-party dependencies
- ✅ Cost-effective

**Cons:**
- ❌ More development effort
- ❌ Need to build analytics yourself
- ❌ Maintenance burden

---

## 3. Best Practices

### 3.1 Transparency & Documentation

**First-run notification:**
```bash
📊 AgentUse collects anonymous usage data to improve the tool.

We collect:
  • Commands executed (run, auth, etc.)
  • OS and Node.js version
  • Anonymized error types

We DO NOT collect:
  • Personal information
  • File paths or content
  • Environment variables
  • IP addresses

Disable anytime: agentuse telemetry disable
Learn more: https://docs.agentuse.io/telemetry
```

**Documentation requirements:**
- Clear explanation of what's collected
- Why it's collected
- How to opt-out
- Where data is stored
- Retention policy

---

### 3.2 Multiple Opt-Out Methods

**Standard pattern:**

1. **Environment variable** (highest priority)
```bash
AGENTUSE_TELEMETRY_DISABLED=1
```

2. **CLI command**
```bash
agentuse telemetry disable
agentuse telemetry enable
agentuse telemetry status
```

3. **Config file** (persistent setting)
```json
// ~/.config/agentuse/config.json
{
  "telemetry": {
    "enabled": false
  }
}
```

---

### 3.3 What to Track (Safe Data)

**✅ Safe to collect:**
- Command executed (`run`, `auth login`, etc.)
- Operating system type (Linux, macOS, Windows)
- OS version
- Node.js version
- CLI version
- CPU count (for performance insights)
- CI environment detection (`CI=true`)
- Command duration/performance
- Error types (with scrubbed stack traces)
- Feature usage (MCP servers enabled, subagents used)
- Model providers used (anthropic, openai, openrouter)

**Example event:**
```json
{
  "event": "command_executed",
  "properties": {
    "command": "run",
    "cli_version": "0.1.4",
    "os": "linux",
    "node_version": "18.0.0",
    "duration_ms": 1234,
    "is_ci": false,
    "mcp_servers_count": 2,
    "model_provider": "anthropic",
    "subagents_used": true
  },
  "timestamp": "2025-10-20T12:00:00Z",
  "session_id": "hashed_value"
}
```

---

### 3.4 What NOT to Collect

**❌ Never collect:**
- Usernames or email addresses
- API keys or tokens
- File paths or names
- File content or code
- Agent file content (instructions)
- Environment variables
- Command arguments (may contain sensitive data)
- IP addresses (or hash/anonymize them)
- Git repository information
- Personally identifiable information (PII)

---

### 3.5 Performance Considerations

**Non-blocking implementation:**
```typescript
// Fire and forget - don't block user
async function trackEvent(event: string, properties: object) {
  if (!isTelemetryEnabled()) return;

  // Don't await - run in background
  sendTelemetry(event, properties).catch(() => {
    // Silently fail - never break user experience
  });
}
```

**Timeout configuration:**
- Short timeout (2-5 seconds max)
- No retries in user-facing commands
- Queue events if offline, send on next run

**Best practices:**
- Use async/background uploads
- Don't block command execution
- Fail silently (never show errors to user)
- Be mindful of CI/CD environments

---

### 3.6 Debug Mode

**Allow users to see what's being sent:**

```bash
AGENTUSE_TELEMETRY_DEBUG=1 agentuse run agent.md
```

**Output:**
```
[TELEMETRY] Event: command_executed
[TELEMETRY] Properties: {
  "command": "run",
  "cli_version": "0.1.4",
  "os": "linux"
}
[TELEMETRY] Would send to: https://telemetry.agentuse.io
[TELEMETRY] (Debug mode - not actually sending)
```

---

### 3.7 Storage Patterns

**Config location examples:**
```
# Linux/macOS
~/.config/agentuse/telemetry.json
~/.config/agentuse/config.json

# Windows
%APPDATA%/agentuse/telemetry.json

# Alternative
~/.agentuse/config.json
```

**Config file structure:**
```json
{
  "telemetry": {
    "enabled": true,
    "userId": "anonymous_hashed_id",
    "firstRunCompleted": true,
    "lastUpload": "2025-10-20T12:00:00Z"
  }
}
```

---

## 4. Privacy-Preserving Approaches

### 4.1 Mozilla Prio

**Concept:** Cryptographic approach to privacy

**How it works:**
1. Clients split data into "shares"
2. Individual shares reveal nothing
3. Servers collect shares from all clients
4. Combining shares reveals only aggregates
5. Individual values cannot be recovered (if ≥1 server is honest)

**Use case:** Aggregate statistics without revealing individual data

**Source:** https://blog.mozilla.org/security/2019/06/06/next-steps-in-privacy-preserving-telemetry-with-prio/

---

### 4.2 Divvi Up

**Organization:** Internet Security Research Group (ISRG) - makers of Let's Encrypt

**How it works:**
1. Library splits data into two encrypted shares
2. Each share uploaded to different processor
3. Processors don't share data with each other
4. Each processor sees only partial information
5. Full data never reconstructable from single processor

**Use case:** Privacy-respecting metrics for mobile apps and services

**Source:** https://divviup.org

---

### 4.3 Local Differential Privacy

**Concept:** Randomize data on client before sending

**How it works:**
1. Add statistical noise to data on client
2. Submit randomized data to server
3. Aggregation removes noise, reveals trends
4. Individual submissions remain private

**Use case:** Frequency estimation and trend analysis

---

### 4.4 Oblivious HTTP (OHTTP)

**Concept:** Enhanced privacy for data in transit

**How it works:**
1. Data encrypted before leaving client
2. Intermediary relay cannot decrypt
3. Only destination server can decrypt
4. Prevents tracking by network observers

**Use case:** Protect telemetry in transit from network surveillance

**Source:** https://arxiv.org/html/2507.06350

---

### 4.5 Go's Transparent Telemetry (Recommended)

**Gold standard for privacy-preserving OSS telemetry**

**Five core components:**

1. **Counting**
   - Local counter files (per-week)
   - No immediate upload
   - User controls what's shared

2. **Configuration**
   - Public review process
   - Transparent log of configs
   - Community can audit changes

3. **Upload**
   - Opt-in only
   - User knows exactly what's sent
   - Published for inspection

4. **Aggregation**
   - Only aggregates published
   - Individual data never revealed

5. **Transparency**
   - Tamper-evident log
   - Public audit trail
   - Open governance

**Key insight:** "Transparent" means transparent to users, not just open source

---

## 5. Recommendations for AgentUse

### 5.1 Recommended Approach: PostHog with Privacy-First Design

**Why PostHog:**
1. ✅ Open source and privacy-focused
2. ✅ Self-hosted option available
3. ✅ Used by similar CLI tools (Astro, Artillery)
4. ✅ Easy integration
5. ✅ Good developer experience
6. ✅ Free tier sufficient for early stage

**Implementation philosophy:**
- Opt-out with clear first-run notification
- Multiple disable methods (env var + CLI)
- Collect minimal, anonymous data only
- Debug mode for transparency
- Never block user experience

---

### 5.2 What to Track for AgentUse

**High-value metrics:**

1. **Command usage:**
   - `agentuse run` (most important!)
   - `agentuse auth login/logout`
   - `agentuse auth list`

2. **Environment information:**
   - OS type and version
   - Node.js version
   - CLI version
   - CI environment detection

3. **Feature adoption:**
   - MCP servers used (count, not names/config)
   - Model providers (anthropic, openai, openrouter)
   - Subagents enabled (yes/no)
   - Plugins used (count)
   - Agent source (local file vs URL)

4. **Performance metrics:**
   - Command execution time
   - Agent execution duration (bucketed: <1s, 1-5s, 5-30s, >30s)
   - MCP server startup time (aggregate)

5. **Error tracking:**
   - Error types (parsing, execution, auth)
   - Error categories (no scrubbed stack traces initially)
   - Failure reasons (authentication failed, timeout, etc.)

**Event examples:**
```typescript
// Command execution
{
  event: 'command_run',
  properties: {
    cli_version: '0.1.4',
    os: 'linux',
    node_version: '18.0.0',
    is_ci: false,
    agent_source: 'local_file', // or 'url'
    mcp_servers_count: 2,
    has_subagents: true,
    model_provider: 'anthropic',
    duration_bucket: '1-5s'
  }
}

// Auth action
{
  event: 'auth_login',
  properties: {
    cli_version: '0.1.4',
    provider: 'anthropic',
    method: 'oauth' // or 'api_key'
  }
}

// Error event
{
  event: 'error',
  properties: {
    cli_version: '0.1.4',
    error_type: 'parsing_error',
    command: 'run',
    context: 'yaml_frontmatter' // general category
  }
}
```

---

### 5.3 Implementation Details

**File structure:**
```
src/
  telemetry/
    index.ts         # Main telemetry client
    config.ts        # Config management
    events.ts        # Event definitions
    types.ts         # TypeScript types
```

**Config location:**
```
~/.config/agentuse/config.json
```

**Config schema:**
```json
{
  "telemetry": {
    "enabled": true,
    "userId": "uuid-v4-generated-once",
    "firstRunNotified": true,
    "lastUpload": "2025-10-20T12:00:00Z"
  }
}
```

---

### 5.4 CLI Commands

**Add telemetry subcommand:**

```bash
# Show status
agentuse telemetry status

# Disable telemetry
agentuse telemetry disable

# Enable telemetry
agentuse telemetry enable

# Show what's being tracked (debug)
agentuse telemetry show
```

**Environment variable:**
```bash
AGENTUSE_TELEMETRY_DISABLED=1
```

**Debug mode:**
```bash
AGENTUSE_TELEMETRY_DEBUG=1
```

---

### 5.5 First-Run Experience

**When to show notification:**
- First time ANY command runs
- Before telemetry is enabled
- Only once ever

**Notification format:**
```bash
┌────────────────────────────────────────────────────────────────┐
│ 📊 AgentUse collects anonymous usage data                     │
│                                                                │
│ This helps us understand how AgentUse is used and prioritize  │
│ improvements. We collect minimal, anonymous data:             │
│                                                                │
│   ✓ Commands executed (run, auth, etc.)                       │
│   ✓ OS and Node.js version                                    │
│   ✓ Anonymous error types                                     │
│                                                                │
│ We DO NOT collect:                                            │
│   ✗ Personal information or API keys                          │
│   ✗ File paths or agent content                               │
│   ✗ Environment variables or IP addresses                     │
│                                                                │
│ Disable anytime:                                              │
│   agentuse telemetry disable                                  │
│   AGENTUSE_TELEMETRY_DISABLED=1                               │
│                                                                │
│ Learn more: https://docs.agentuse.io/telemetry                │
└────────────────────────────────────────────────────────────────┘
```

**Store that notification was shown:**
```json
{
  "telemetry": {
    "firstRunNotified": true,
    "enabled": true  // Default to enabled after notification
  }
}
```

---

### 5.6 Code Example

**Basic implementation:**

```typescript
// src/telemetry/index.ts
import { PostHog } from 'posthog-node';
import { getTelemetryConfig, isEnabled } from './config';
import type { TelemetryEvent } from './types';

class Telemetry {
  private client: PostHog | null = null;
  private initialized = false;

  async init() {
    if (this.initialized) return;

    const enabled = await isEnabled();
    if (!enabled) return;

    // Only initialize if enabled
    this.client = new PostHog(
      process.env.POSTHOG_API_KEY || 'PRODUCTION_KEY',
      {
        host: 'https://app.posthog.com',
        // Don't block on network requests
        flushAt: 20,
        flushInterval: 10000
      }
    );

    this.initialized = true;
  }

  async track(event: string, properties?: Record<string, any>) {
    // Check if telemetry is enabled
    if (!await isEnabled()) return;

    // Debug mode - print instead of sending
    if (process.env.AGENTUSE_TELEMETRY_DEBUG === '1') {
      console.log('[TELEMETRY]', event, properties);
      return;
    }

    try {
      await this.init();

      if (!this.client) return;

      const config = await getTelemetryConfig();

      // Fire and forget - don't await
      this.client.capture({
        distinctId: config.userId,
        event,
        properties: {
          cli_version: getVersion(),
          os: process.platform,
          node_version: process.version,
          ...properties
        }
      });
    } catch (error) {
      // Silently fail - never break user experience
    }
  }

  async flush() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}

export const telemetry = new Telemetry();

// Helper function
export async function trackCommand(
  command: string,
  properties?: Record<string, any>
) {
  await telemetry.track('command_executed', {
    command,
    ...properties
  });
}
```

**Config management:**

```typescript
// src/telemetry/config.ts
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

interface TelemetryConfig {
  enabled: boolean;
  userId: string;
  firstRunNotified: boolean;
  lastUpload?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'agentuse');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function getTelemetryConfig(): Promise<TelemetryConfig> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data);
    return config.telemetry || getDefaultConfig();
  } catch {
    return getDefaultConfig();
  }
}

export async function setTelemetryConfig(
  config: Partial<TelemetryConfig>
): Promise<void> {
  const current = await getTelemetryConfig();
  const updated = { ...current, ...config };

  await fs.mkdir(CONFIG_DIR, { recursive: true });

  const fullConfig = await getFullConfig();
  fullConfig.telemetry = updated;

  await fs.writeFile(
    CONFIG_FILE,
    JSON.stringify(fullConfig, null, 2)
  );
}

export async function isEnabled(): Promise<boolean> {
  // Environment variable takes precedence
  if (process.env.AGENTUSE_TELEMETRY_DISABLED === '1') {
    return false;
  }

  const config = await getTelemetryConfig();
  return config.enabled;
}

function getDefaultConfig(): TelemetryConfig {
  return {
    enabled: false, // Start disabled until first-run notice
    userId: randomUUID(),
    firstRunNotified: false
  };
}
```

**First-run notification:**

```typescript
// src/telemetry/notification.ts
import { getTelemetryConfig, setTelemetryConfig } from './config';

export async function showFirstRunNotification(): Promise<void> {
  const config = await getTelemetryConfig();

  // Already shown
  if (config.firstRunNotified) return;

  // Skip in CI environments
  if (process.env.CI === 'true') {
    await setTelemetryConfig({ firstRunNotified: true, enabled: false });
    return;
  }

  console.log(`
┌────────────────────────────────────────────────────────────────┐
│ 📊 AgentUse collects anonymous usage data                     │
│                                                                │
│ This helps us understand how AgentUse is used and prioritize  │
│ improvements. We collect minimal, anonymous data:             │
│                                                                │
│   ✓ Commands executed (run, auth, etc.)                       │
│   ✓ OS and Node.js version                                    │
│   ✓ Anonymous error types                                     │
│                                                                │
│ We DO NOT collect:                                            │
│   ✗ Personal information or API keys                          │
│   ✗ File paths or agent content                               │
│   ✗ Environment variables or IP addresses                     │
│                                                                │
│ Disable anytime:                                              │
│   agentuse telemetry disable                                  │
│   AGENTUSE_TELEMETRY_DISABLED=1                               │
│                                                                │
│ Learn more: https://docs.agentuse.io/telemetry                │
└────────────────────────────────────────────────────────────────┘
  `);

  // Mark as notified and enable by default
  await setTelemetryConfig({
    firstRunNotified: true,
    enabled: true
  });
}
```

---

## 6. Implementation Roadmap

### Phase 1: Foundation (Week 1)

**Goals:**
- Set up basic telemetry infrastructure
- Implement config management
- Add first-run notification

**Tasks:**
1. ✅ Research telemetry approaches (DONE)
2. Add PostHog dependency
3. Create telemetry module structure
4. Implement config management
5. Add first-run notification
6. Create `telemetry` CLI subcommand

**Deliverables:**
- Basic telemetry system (disabled by default)
- First-run notification
- CLI commands to enable/disable

---

### Phase 2: Core Events (Week 2)

**Goals:**
- Track essential command usage
- Validate data collection

**Tasks:**
1. Instrument `agentuse run` command
2. Instrument `agentuse auth` commands
3. Add error tracking
4. Test in development
5. Verify PostHog data flow

**Events to track:**
- `command_run`
- `command_auth_login`
- `command_auth_logout`
- `error`

---

### Phase 3: Enhanced Metrics (Week 3)

**Goals:**
- Add feature adoption tracking
- Performance metrics

**Tasks:**
1. Track MCP server usage
2. Track model provider usage
3. Track subagent usage
4. Add performance bucketing
5. Add CI detection

**Events to track:**
- Feature adoption metrics
- Performance buckets
- Environment details

---

### Phase 4: Documentation & Polish (Week 4)

**Goals:**
- Complete documentation
- Community transparency

**Tasks:**
1. Create telemetry documentation page
2. Update privacy policy
3. Add telemetry FAQ
4. Announce in release notes
5. Create blog post explaining approach

**Deliverables:**
- Comprehensive docs
- Privacy policy
- Transparent communication

---

### Phase 5: Analysis & Iteration (Ongoing)

**Goals:**
- Analyze collected data
- Make data-driven decisions

**Tasks:**
1. Create PostHog dashboards
2. Set up weekly review process
3. Identify usage patterns
4. Prioritize features based on data
5. Share aggregated insights publicly

---

## 7. References

### Articles & Documentation

1. **Next.js Telemetry**
   - https://nextjs.org/telemetry

2. **VS Code Telemetry**
   - https://code.visualstudio.com/api/extension-guides/telemetry
   - https://code.visualstudio.com/docs/configure/telemetry

3. **Homebrew Analytics**
   - https://docs.brew.sh/Analytics

4. **Astro Telemetry**
   - https://github.com/withastro/astro/tree/main/packages/telemetry
   - https://astro.build/telemetry/

5. **Go Transparent Telemetry**
   - https://research.swtch.com/telemetry-intro
   - https://research.swtch.com/telemetry-design.pdf
   - https://github.com/golang/telemetry
   - https://github.com/golang/go/discussions/58409

6. **Turborepo Telemetry**
   - https://turbo.build/repo/docs/telemetry

7. **Artillery Telemetry**
   - https://www.artillery.io/docs/resources/telemetry

8. **.NET Telemetry**
   - https://learn.microsoft.com/en-us/dotnet/core/tools/telemetry

9. **CLI Telemetry Best Practices**
   - https://marcon.me/articles/cli-telemetry-best-practices/

10. **PostHog OSS Telemetry Ethics**
    - https://posthog.com/blog/open-source-telemetry-ethical

### Privacy-Preserving Approaches

11. **Mozilla Prio**
    - https://blog.mozilla.org/security/2019/06/06/next-steps-in-privacy-preserving-telemetry-with-prio/

12. **Divvi Up**
    - https://divviup.org/blog/horizontal-tella/

13. **OHTTP Privacy Architecture**
    - https://arxiv.org/html/2507.06350

### Tools & Services

14. **PostHog**
    - https://posthog.com/docs

15. **Application Insights**
    - https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview

16. **InfluxDB**
    - https://www.influxdata.com/

17. **Sentry**
    - https://sentry.io

18. **OpenTelemetry**
    - https://opentelemetry.io/

---

## Appendix A: Community Sentiment Analysis

### Opt-in vs Opt-out Debate

**Opt-out (Default enabled):**
- ✅ Higher participation rates (better data)
- ✅ Easier to get critical mass
- ❌ Community pushback (privacy concerns)
- ❌ Ethical concerns (consent)

**Examples:** Next.js, Homebrew, Astro

**Opt-in (User chooses):**
- ✅ Respects user privacy
- ✅ Better community reception
- ✅ Ethical consent model
- ❌ Lower participation (often <5%)
- ❌ Biased sample (power users)

**Examples:** Go toolchain

**Recommendation for AgentUse:**
- Start with **opt-out**
- Show clear first-run notification
- Make opting out trivial
- Be transparent about what's collected
- Monitor community feedback and adjust

---

## Appendix B: Sample Dashboard Queries

**PostHog queries for key metrics:**

1. **Daily Active Users (DAU)**
```sql
SELECT count(DISTINCT distinctId)
FROM events
WHERE event = 'command_executed'
  AND timestamp >= now() - interval '1 day'
```

2. **Most Popular Commands**
```sql
SELECT properties.command, count(*)
FROM events
WHERE event = 'command_executed'
GROUP BY properties.command
ORDER BY count DESC
```

3. **Model Provider Adoption**
```sql
SELECT properties.model_provider, count(*)
FROM events
WHERE event = 'command_run'
GROUP BY properties.model_provider
```

4. **Error Rate**
```sql
SELECT
  (SELECT count(*) FROM events WHERE event = 'error') * 100.0 /
  (SELECT count(*) FROM events WHERE event = 'command_executed')
    AS error_rate_percent
```

5. **MCP Server Usage**
```sql
SELECT
  properties.mcp_servers_count,
  count(*)
FROM events
WHERE event = 'command_run'
  AND properties.mcp_servers_count > 0
GROUP BY properties.mcp_servers_count
ORDER BY properties.mcp_servers_count
```

---

## Appendix C: Privacy Checklist

Before launching telemetry, verify:

- [ ] First-run notification implemented
- [ ] Environment variable opt-out works
- [ ] CLI disable command works
- [ ] Debug mode shows what's being sent
- [ ] No PII in any events
- [ ] No file paths or names collected
- [ ] No API keys or tokens collected
- [ ] No command arguments (may contain secrets)
- [ ] User ID is anonymous hash
- [ ] Telemetry never blocks command execution
- [ ] Failures are silent (no errors to user)
- [ ] Documentation page created
- [ ] Privacy policy updated
- [ ] CI environment auto-disables
- [ ] Timeout set (max 5 seconds)
- [ ] No retries in synchronous path

---

## Conclusion

Telemetry in open source projects is a balance between gathering useful data and respecting user privacy. The research shows that successful implementations share common traits:

1. **Transparency first** - Users must know what's collected
2. **Privacy by design** - Collect minimal, anonymous data only
3. **Easy opt-out** - Multiple methods, clearly documented
4. **Non-invasive** - Never block or slow down user experience
5. **Community trust** - Open about purpose and use

For AgentUse, we recommend:
- **PostHog** as the telemetry backend (privacy-focused, OSS-friendly)
- **Opt-out** approach with clear first-run notification
- **Minimal data collection** focused on commands and feature adoption
- **Multiple opt-out methods** (env var + CLI command)
- **Debug mode** for transparency

The Go toolchain's "Transparent Telemetry" represents the gold standard, but requires significant infrastructure. Starting with a simpler PostHog-based approach allows us to gather valuable insights while maintaining user trust and privacy.

The key is to be respectful, transparent, and always put user privacy first.

---

**Document Prepared By:** Claude (AI Assistant)
**Research Date:** October 20, 2025
**Last Updated:** October 20, 2025
**Version:** 1.0
