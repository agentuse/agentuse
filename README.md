<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./static/agentuse-logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="./static/agentuse-logo.png">
  <img alt="AgentUse Logo" src="./static/agentuse-logo.png"  width="full">
</picture>

<h1 align="center">AI Agents on Autopilot</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/agentuse">
    <img alt="NPM Version" src="https://img.shields.io/npm/v/agentuse?style=flat-square&color=00DC82&label=version">
  </a>
  <a href="https://www.npmjs.com/package/agentuse">
    <img alt="NPM Downloads" src="https://img.shields.io/npm/dm/agentuse?style=flat-square&color=00DC82">
  </a>
  <a href="https://github.com/agentuse/agentuse">
    <img alt="GitHub Stars" src="https://img.shields.io/github/stars/agentuse/agentuse?style=flat-square&color=00DC82">
  </a>
  <a href="https://github.com/agentuse/agentuse/blob/main/LICENSE">
    <img alt="License" src="https://img.shields.io/npm/l/agentuse?style=flat-square&color=00DC82">
  </a>
  <a href="https://docs.agentuse.io">
    <img alt="Documentation" src="https://img.shields.io/badge/docs-agentuse.io-00DC82?style=flat-square">
  </a>
</p>

<p align="center">
  <strong>Define in markdown. Run on cron, CI/CD, or serverless.</strong><br/>
  No SDK. No flowcharts. Just AI agents that run themselves.
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="https://docs.agentuse.io">Documentation</a> •
  <a href="#-real-world-automation-examples">Examples</a>
</p>

## 🚀 Quick Start

### Zero Setup - Try it NOW (10 seconds)
```bash
# Run an agent directly from the web - no files, no install!
ANTHROPIC_API_KEY=sk-ant-... npx -y agentuse@latest run https://agentuse.io/hello.agentuse
# Or override the model to gpt-5
OPENAI_API_KEY=sk-... npx -y agentuse@latest run https://agentuse.io/hello.agentuse -m openai:gpt-5
```

### Create Your Own (30 seconds)

**Step 1:** Create `daily-reporter.agentuse`:
```markdown
---
model: openai:gpt-5
---

Generate a daily motivation quote with an interesting fact about technology.
Format as JSON with 'quote' and 'fact' fields.
```

**Step 2:** Run it:
```bash
# Try without installing (needs OPENAI_API_KEY for this example)
OPENAI_API_KEY=sk-... npx -y agentuse@latest run daily-reporter.agentuse

# Or install globally for production use
npm install -g agentuse
agentuse run daily-reporter.agentuse

# Schedule it (cron, CI/CD, serverless)
0 9 * * * agentuse run daily-reporter.agentuse >> daily-quotes.json
```

That's it! Your AI agent runs on autopilot - CI/CD pipelines, cron jobs, webhooks, or serverless functions.

## 🎯 Real-World Automation Examples

### Daily Metrics Reporter
```yaml
---
model: openai:gpt-5
description: Daily sales metrics reporter - runs daily at 9am via cron
mcpServers:
  postgres:
    command: uv
    args: ["run", "postgres-mcp", "--access-mode=restricted"]
    requiredEnvVars:
      - DATABASE_URI
---

Query sales_metrics table for yesterday's data.
Generate executive summary with trends and alerts.
Format as markdown report.
```

### SEO Content Monitor
```yaml
---
model: openai:gpt-5
description: SEO performance analyzer - runs weekly via GitHub Actions
mcpServers:
  dataforseo:
    command: "npx"
    args: ["-y", "dataforseo-mcp-server"]
    requiredEnvVars:
      - DATAFORSEO_USERNAME
      - DATAFORSEO_PASSWORD
---

Analyze SEO performance for https://blog.example.com/blog-post
Compare rankings with top 3 competitors in our niche.
Generate keyword opportunities and content gap analysis.
Output recommendations as JSON for our CMS.
```

### X (Twitter) Social Manager
```yaml
---
model: openai:gpt-5
description: Social media automation bot - runs every 6 hours via cron
mcpServers:
  twitter:
    command: npx
    args: ["-y", "@enescinar/twitter-mcp"]
    requiredEnvVars:
      - API_KEY
      - API_SECRET_KEY
      - ACCESS_TOKEN
      - ACCESS_TOKEN_SECRET
  exa:
    command: npx
    args: ["-y", "exa-mcp-server", "--tools=web_search_exa"]
    requiredEnvVars:
      - EXA_API_KEY
    disallowedTools:
      - deep_researcher_*
---

Search for trending tech topics using Exa.
Generate 5 engaging posts based on current trends.
Choose the best one and post to X.
```

<details>
<summary><strong>Why AgentUse?</strong> The philosophy behind the project...</summary>

### The Problem
AI tools today force you to choose: interactive copilots that require your constant attention, visual workflow builders with version control nightmares, or SDK-heavy frameworks with hundreds of lines of boilerplate.

### The Insight
What if AI agents could run like cron jobs? Define what you want in markdown, schedule with cron or CI/CD, and let it work while you don't. No chat. No babysitting. Just results.

### The Solution
AgentUse puts AI agents on autopilot. Define agents in markdown, run via cron, CI/CD, or serverless, and get results asynchronously. This means:
- **Runs unattended** - cron jobs, CI/CD pipelines, serverless functions
- **Version control just works** - diff, review, and merge agents like any other code
- **No SDK required** - if you can write plain English, you can build an agent
- **Production-ready** - built-in retries, streaming, error recovery, and MCP support

Copilots assist you. AgentUse agents work for you.
</details>

## ✨ Features

<div align="center">

| 🚀 **Autopilot Execution** | 🔧 **Developer Experience** | 🔌 **Integrations** |
|:---|:---|:---|
| • Cron jobs<br>• CI/CD pipelines<br>• Serverless functions<br>• Any external trigger | • Markdown format<br>• Zero boilerplate<br>• Git-friendly<br>• URL-shareable agents | • MCP servers<br>• Multiple AI providers (Anthropic, OpenAI, OpenRouter)<br>• Plugin system<br>• Sub-agent composition |

</div>

## 📦 Installation & Setup

### Quick Try (No Install)
```bash
# Run any agent without installing
npx -y agentuse@latest run your-agent.agentuse
```

### Production Install
```bash
npm install -g agentuse
# or: pnpm add -g agentuse
```

### Authentication
```bash
# Interactive login (recommended)
agentuse auth login

# Or use environment variables
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."
```

📚 [Full installation guide →](https://docs.agentuse.io/installation)
📘 [Authentication docs →](https://docs.agentuse.io/guides/model-configuration)

## 📚 Documentation

<div align="center">

| [**🚀 Getting Started**](https://docs.agentuse.io/quickstart) | [**📖 Guides**](https://docs.agentuse.io/guides) | [**📘 API Reference**](https://docs.agentuse.io/reference) | [**💡 Templates**](https://github.com/agentuse/agentuse/tree/main/templates) |
|:---:|:---:|:---:|:---:|
| 5-minute tutorial | Learn concepts | Complete reference | Example agents |

</div>

## 📋 Core Concepts

Agents are markdown files with YAML frontmatter for configuration and plain English instructions:

```markdown
---
model: anthropic:claude-sonnet-4-5  # Required: AI model
mcpServers: {...}                   # Optional: MCP tools
subagents: [...]                     # Optional: sub-agents
---

Your agent instructions in markdown...
```

📚 [Agent syntax guide →](https://docs.agentuse.io/reference/agent-syntax)
📘 [Model configuration →](https://docs.agentuse.io/guides/model-configuration)
🔧 [MCP servers →](https://docs.agentuse.io/guides/creating-agents#mcp-servers)
🤖 [Sub-agents →](https://docs.agentuse.io/guides/subagents)


## 🤝 Contributing

We welcome contributions! Here's how to get started:

- 📖 Read our [Contributing Guide](CONTRIBUTING.md)
- 🐛 Report bugs via [GitHub Issues](https://github.com/agentuse/agentuse/issues)
- 💡 Share ideas in [Discussions](https://github.com/agentuse/agentuse/discussions)
- 🔧 Submit PRs with improvements
- ⭐ Star the repo to show support!

## 📜 License

Apache License 2.0 - see [LICENSE](LICENSE) file for details.

---

<p align="center">
  Made with ❤️ by the AgentUse community<br/>
  <a href="https://github.com/agentuse/agentuse">GitHub</a> •
  <a href="https://docs.agentuse.io">Documentation</a> •
  <a href="https://agentuse.io">Website</a>
</p>