import { Command } from "commander";
import { AnthropicAuth, AuthStorage, CodexAuth } from "../auth/index.js";
import readline from "readline";
import { logger } from "../utils/logger";

function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function promptInput(question: string): Promise<string> {
  const rl = createReadlineInterface();
  return new Promise((resolve, reject) => {
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('Interrupted'));
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}


export function createAuthCommand(): Command {
  const authCmd = new Command("auth")
    .description("Manage authentication credentials");

  authCmd
    .command("help")
    .description("Show authentication help and configuration options")
    .action(() => {
      process.stdout.write("🔐 AgentUse Authentication Help\n");
      process.stdout.write(`${"=".repeat(60)}\n\n`);
      
      process.stdout.write("AUTHENTICATION METHODS:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("1. Login Command (Recommended):\n");
      process.stdout.write("   agentuse auth login\n\n");
      
      process.stdout.write("2. Environment Variables:\n");
      process.stdout.write("   Set API keys directly in your environment:\n");
      process.stdout.write("   • ANTHROPIC_API_KEY     - For Anthropic Claude models\n");
      process.stdout.write("   • OPENAI_API_KEY        - For OpenAI GPT models\n");
      process.stdout.write("   • OPENROUTER_API_KEY    - For OpenRouter (multiple models)\n\n");
      
      process.stdout.write("ENVIRONMENT VARIABLE SETUP:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("Bash/Zsh (~/.bashrc or ~/.zshrc):\n");
      process.stdout.write("  export ANTHROPIC_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  export OPENAI_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  export OPENROUTER_API_KEY=\"your-api-key\"\n\n");
      
      process.stdout.write("Fish (~/.config/fish/config.fish):\n");
      process.stdout.write("  set -x ANTHROPIC_API_KEY \"your-api-key\"\n");
      process.stdout.write("  set -x OPENAI_API_KEY \"your-api-key\"\n");
      process.stdout.write("  set -x OPENROUTER_API_KEY \"your-api-key\"\n\n");
      
      process.stdout.write("Windows (PowerShell):\n");
      process.stdout.write("  $env:ANTHROPIC_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  $env:OPENAI_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  $env:OPENROUTER_API_KEY=\"your-api-key\"\n\n");
      
      process.stdout.write("Windows (Command Prompt):\n");
      process.stdout.write("  set ANTHROPIC_API_KEY=your-api-key\n");
      process.stdout.write("  set OPENAI_API_KEY=your-api-key\n");
      process.stdout.write("  set OPENROUTER_API_KEY=your-api-key\n\n");
      
      process.stdout.write("PRIORITY ORDER:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("1. OAuth tokens (Anthropic OAuth or OpenAI Codex OAuth)\n");
      process.stdout.write("2. Stored API keys (via auth login)\n");
      process.stdout.write("3. Environment variables\n\n");
      
      process.stdout.write("COMMANDS:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("  auth login [provider]  - Store API credentials\n");
      process.stdout.write("  auth logout [provider] - Remove stored credentials\n");
      process.stdout.write("  auth list             - Show stored credentials\n");
      process.stdout.write("  auth help             - Show this help message\n\n");
      
      process.stdout.write("GETTING API KEYS:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("• Anthropic:   https://console.anthropic.com/account/keys\n");
      process.stdout.write("• OpenAI:      https://platform.openai.com/api-keys\n");
      process.stdout.write("• OpenRouter:  https://openrouter.ai/keys\n");
    });

  authCmd
    .command("login")
    .description("Login to a provider")
    .argument("[provider]", "Provider to login to")
    .action(async (provider?: string) => {
      try {
        process.stdout.write("🔐 AgentUse Authentication\n\n");

        if (!provider) {
          process.stdout.write("Available providers:\n");
          process.stdout.write("  1. anthropic    - Anthropic Claude (supports OAuth for Claude Max)\n");
          process.stdout.write("  2. openai       - OpenAI GPT models\n");
          process.stdout.write("  3. openrouter   - OpenRouter (access to multiple models)\n");
          process.stdout.write("\n");
          
          const selection = await promptInput("Select provider (1-3 or name): ");
          
          // Handle numbered selection
          switch (selection) {
            case "1":
              provider = "anthropic";
              break;
            case "2":
              provider = "openai";
              break;
            case "3":
              provider = "openrouter";
              break;
            default:
              provider = selection;
          }
        }

        switch (provider.toLowerCase()) {
          case "anthropic":
            await handleAnthropicLogin();
            break;
          case "openai":
            await handleOpenAILogin();
            break;
          case "openrouter":
            await handleGenericLogin("openrouter", "OpenRouter API Key");
            break;
          default:
            logger.warn(`Unknown provider: ${provider}`);
            process.exit(1);
        }
      } catch (error) {
        logger.error("Login failed", error as Error);
        process.exit(1);
      }
    });

  authCmd
    .command("logout")
    .description("Logout from a provider")
    .argument("[provider]", "Provider to logout from")
    .action(async (provider?: string) => {
      const credentials = await AuthStorage.all();
      const providers = Object.keys(credentials);

      if (providers.length === 0) {
        logger.warn("No stored credentials found");
        return;
      }

      if (!provider) {
        process.stdout.write("Stored credentials:\n");
        providers.forEach((p, i) => {
          const auth = credentials[p];
          process.stdout.write(`  ${i + 1}. ${p} (${auth.type})\n`);
        });
        process.stdout.write("\n");
        
        const selection = await promptInput("Select provider to logout from: ");
        const index = parseInt(selection) - 1;
        
        if (index >= 0 && index < providers.length) {
          provider = providers[index];
        } else {
          provider = selection;
        }
      }

      if (providers.includes(provider)) {
        await AuthStorage.remove(provider);
        process.stdout.write(`✅ Logged out from ${provider}\n`);
      } else {
        logger.warn(`No credentials found for ${provider}`);
      }
    });

  authCmd
    .command("list")
    .alias("ls")
    .description("List stored credentials")
    .action(async () => {
      const credentials = await AuthStorage.all();
      const authPath = AuthStorage.getFilePath();
      const homedir = process.env.HOME || process.env.USERPROFILE || "";
      const displayPath = authPath.startsWith(homedir)
        ? authPath.replace(homedir, "~")
        : authPath;

      process.stdout.write(`📁 Credentials stored in: ${displayPath}\n\n`);

      // Define providers and their auth sources in priority order
      const providers = [
        {
          name: "anthropic",
          display: "Anthropic",
          envVars: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
        },
        {
          name: "openai",
          display: "OpenAI",
          envVars: ["OPENAI_API_KEY"],
        },
        {
          name: "openrouter",
          display: "OpenRouter",
          envVars: ["OPENROUTER_API_KEY"],
        },
      ];

      process.stdout.write("Authentication (in priority order):\n");
      process.stdout.write("─".repeat(50) + "\n\n");

      for (const provider of providers) {
        const storedAuth = credentials[provider.name];
        const sources: { priority: number; source: string; type: string; active: boolean }[] = [];

        // Priority 1: OAuth tokens (stored)
        if (storedAuth && (storedAuth.type === "oauth" || storedAuth.type === "codex-oauth")) {
          sources.push({
            priority: 1,
            source: storedAuth.type === "codex-oauth" ? "ChatGPT OAuth" : "OAuth",
            type: storedAuth.type,
            active: true,
          });
        }

        // Priority 1 (Anthropic only): CLAUDE_CODE_OAUTH_TOKEN
        if (provider.name === "anthropic" && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
          // If no stored OAuth, this takes priority
          if (!storedAuth || storedAuth.type !== "oauth") {
            sources.push({
              priority: 1,
              source: "CLAUDE_CODE_OAUTH_TOKEN",
              type: "env",
              active: true,
            });
          }
        }

        // Priority 2: Stored API keys
        if (storedAuth && storedAuth.type === "api") {
          sources.push({
            priority: 2,
            source: "Stored API key",
            type: "api",
            active: !sources.some(s => s.priority === 1),
          });
        }

        // Priority 3: Environment variables
        for (const envVar of provider.envVars) {
          if (envVar === "CLAUDE_CODE_OAUTH_TOKEN") continue; // Already handled
          if (process.env[envVar]) {
            sources.push({
              priority: 3,
              source: envVar,
              type: "env",
              active: sources.length === 0,
            });
          }
        }

        // Display provider section
        if (sources.length > 0) {
          process.stdout.write(`${provider.display}:\n`);
          for (const source of sources.sort((a, b) => a.priority - b.priority)) {
            const icon = source.type === "oauth" || source.type === "codex-oauth" ? "🔑" : source.type === "api" ? "🎫" : "🌍";
            const activeMarker = source.active ? " ← active" : "";
            const priorityLabel = `[${source.priority}]`;
            process.stdout.write(`  ${priorityLabel} ${icon} ${source.source}${activeMarker}\n`);
          }
          process.stdout.write("\n");
        }
      }

      // Show providers with no auth configured
      const unconfigured = providers.filter(p => {
        const stored = credentials[p.name];
        const hasEnv = p.envVars.some(e => process.env[e]);
        return !stored && !hasEnv;
      });

      if (unconfigured.length > 0) {
        process.stdout.write("Not configured:\n");
        for (const p of unconfigured) {
          process.stdout.write(`  ⚠️  ${p.display} - run \`agentuse auth login ${p.name}\`\n`);
        }
        process.stdout.write("\n");
      }

      process.stdout.write("Priority: [1] OAuth → [2] Stored API key → [3] Environment variable\n");
    });

  authCmd
    .command("setup-github")
    .description("Set up long-lived OAuth token for GitHub Actions (1 year validity)")
    .option("--repo <repo>", "GitHub repository (owner/repo) - auto-detected from git if not specified")
    .action(async (options: { repo?: string }) => {
      const { execSync } = await import("child_process");

      // Auto-detect repo from git remote if not specified
      if (!options.repo) {
        try {
          const remoteUrl = execSync("git remote get-url origin", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
          // Parse GitHub URL: git@github.com:owner/repo.git or https://github.com/owner/repo.git
          const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
          if (match) {
            options.repo = match[1];
            process.stdout.write(`📦 Auto-detected repository: ${options.repo}\n\n`);
          }
        } catch {
          // Not a git repo or no remote
        }
      }

      if (!options.repo) {
        logger.error("Could not detect repository. Specify --repo owner/repo");
        process.stdout.write("\nUsage:\n");
        process.stdout.write("  agentuse auth setup-github                    # Auto-detect from git\n");
        process.stdout.write("  agentuse auth setup-github --repo owner/repo  # Specify repo\n");
        process.exit(1);
      }

      // Check prerequisites
      try {
        execSync("gh --version", { stdio: "ignore" });
      } catch {
        logger.error("GitHub CLI (gh) is not installed. Run: brew install gh");
        process.exit(1);
      }

      try {
        execSync("gh auth status", { stdio: "ignore" });
      } catch {
        logger.error("Not authenticated with gh. Run: gh auth login");
        process.exit(1);
      }

      // Check if we have secrets:write permission by trying to list secrets
      try {
        execSync(`gh secret list --repo ${options.repo}`, { stdio: "ignore" });
      } catch {
        logger.error(`Cannot access secrets for ${options.repo}`);
        process.stdout.write("\nYou need a PAT with 'secrets:write' permission.\n");
        process.stdout.write("Set it with: export GH_TOKEN=your_pat_here\n");
        process.stdout.write("\nOr create one at:\n");
        process.stdout.write("  GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens\n");
        process.stdout.write("  Permissions: Secrets (Read and write)\n");
        process.exit(1);
      }

      process.stdout.write("🔐 Setting up OAuth for GitHub Actions\n\n");
      process.stdout.write(`Repository: ${options.repo}\n\n`);
      process.stdout.write("This uses a long-lived token (1 year) - no refresh needed!\n\n");

      process.stdout.write(`${"=".repeat(60)}\n`);
      process.stdout.write("📝 Step 1: Generate a long-lived token\n");
      process.stdout.write(`${"=".repeat(60)}\n\n`);
      process.stdout.write("Run this command in Claude Code CLI:\n\n");
      process.stdout.write("   claude setup-token\n\n");
      process.stdout.write("This will give you an OAuth token valid for 1 year.\n\n");

      const token = await promptInput("📝 Paste the OAuth token here: ");

      if (!token || token.length === 0) {
        logger.warn("No token provided");
        return;
      }

      // Basic validation - Claude tokens typically start with specific patterns
      if (token.length < 20) {
        logger.warn("Token seems too short. Make sure you copied the full token.");
        return;
      }

      // Upload to GitHub secrets
      process.stdout.write("\n📤 Uploading token to GitHub secrets...\n");

      try {
        execSync(`echo "${token}" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${options.repo}`, {
          stdio: "pipe",
        });

        process.stdout.write("\n✅ GitHub Actions setup complete!\n\n");
        process.stdout.write("Secret created:\n");
        process.stdout.write("   • CLAUDE_CODE_OAUTH_TOKEN (valid for 1 year)\n\n");
        process.stdout.write("No SECRETS_ADMIN_PAT needed - this token doesn't require refresh!\n");
      } catch {
        logger.error("Failed to upload secret");
        process.exit(1);
      }
    });

  return authCmd;
}

async function handleAnthropicLogin() {
  process.stdout.write("Anthropic login methods:\n");
  process.stdout.write("  1. Claude Pro/Max Plan (OAuth) (Experimental)\n");
  process.stdout.write("  2. Anthropic Console (OAuth)\n");
  process.stdout.write("  3. Manual API Key\n");
  process.stdout.write("\n");

  const method = await promptInput("Select method (1-3): ");

  switch (method) {
    case "1":
      await handleAnthropicOAuth("max");
      break;
    case "2":
      await handleAnthropicOAuth("console");
      break;
    case "3":
      await handleGenericLogin("anthropic", "Anthropic API Key");
      break;
    default:
      logger.warn("Invalid selection");
  }
}

async function handleOpenAILogin() {
  process.stdout.write("OpenAI login methods:\n");
  process.stdout.write("  1. ChatGPT Pro/Plus (OAuth) - Uses your ChatGPT subscription\n");
  process.stdout.write("  2. Manual API Key\n");
  process.stdout.write("\n");

  const method = await promptInput("Select method (1-2): ");

  switch (method) {
    case "1":
      await handleCodexOAuth();
      break;
    case "2":
      await handleGenericLogin("openai", "OpenAI API Key");
      break;
    default:
      logger.warn("Invalid selection");
  }
}

async function handleCodexOAuth() {
  // Some weird bug where program exits without this delay (from OpenCode)
  await new Promise((resolve) => setTimeout(resolve, 10));

  process.stdout.write("\n🔄 Starting ChatGPT OAuth flow...\n\n");

  try {
    const { url, pkce } = await CodexAuth.authorize();

    process.stdout.write(`${"=".repeat(80)}\n`);
    process.stdout.write(`📋 AUTHORIZATION URL:\n`);
    process.stdout.write(`${url}\n`);
    process.stdout.write(`${"=".repeat(80)}\n\n`);

    process.stdout.write("📝 Steps:\n");
    process.stdout.write("   1. Visit the URL above in your browser\n");
    process.stdout.write("   2. Sign in to ChatGPT and authorize the application\n");
    process.stdout.write("   3. You'll be redirected to a page (it may show an error - that's OK)\n");
    process.stdout.write("   4. Copy the FULL URL from your browser's address bar\n");
    process.stdout.write("   5. Paste it below\n\n");

    const callbackUrl = await promptInput("📝 Paste the callback URL here: ");

    if (!callbackUrl || callbackUrl.length === 0) {
      logger.warn("No URL provided");
      return;
    }

    // Extract code from callback URL
    let code: string | null = null;
    try {
      const parsed = new URL(callbackUrl);
      code = parsed.searchParams.get("code");
    } catch {
      // Maybe they just pasted the code directly
      code = callbackUrl.trim();
    }

    if (!code) {
      logger.warn("Could not extract authorization code from URL");
      return;
    }

    process.stdout.write("🔄 Exchanging code for tokens...\n");

    try {
      const credentials = await CodexAuth.exchange(code, pkce);
      await AuthStorage.set("openai", {
        type: "codex-oauth",
        refresh: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        accountId: credentials.accountId,
      });

      process.stdout.write("✅ Successfully authenticated with ChatGPT!\n");
      if (credentials.accountId) {
        process.stdout.write(`📋 Account ID: ${credentials.accountId}\n`);
      }
    } catch {
      logger.warn("Invalid code or authorization failed");
    }
  } catch (error) {
    logger.error("Authentication failed", error as Error);
  }
}

async function handleAnthropicOAuth(mode: "max" | "console") {
  // Some weird bug where program exits without this delay (from OpenCode)
  await new Promise((resolve) => setTimeout(resolve, 10));
  
  process.stdout.write(`\n🔄 Starting ${mode === "max" ? "Claude Pro/Max" : "Console"} OAuth flow...\n\n`);

  try {
    const { url, verifier } = await AnthropicAuth.authorize(mode);
    
    // Always show the URL prominently  
    process.stdout.write(`\n${"=".repeat(80)}\n`);
    process.stdout.write(`📋 AUTHORIZATION URL:\n`);
    process.stdout.write(`${url}\n`);
    process.stdout.write(`${"=".repeat(80)}\n\n`);

    process.stdout.write("📝 Steps:\n");
    process.stdout.write("   1. Visit the URL above in your browser\n");
    process.stdout.write("   2. Sign in to Claude and authorize the application\n");
    process.stdout.write("   3. Copy the authorization code you receive\n");
    process.stdout.write("   4. Paste it below\n\n");

    const code = await promptInput("📝 Paste the authorization code here: ");
    
    if (!code || code.length === 0) {
      logger.warn("No code provided");
      return;
    }

    process.stdout.write("🔄 Exchanging code for tokens...\n");
    
    try {
      const credentials = await AnthropicAuth.exchange(code, verifier);
      await AuthStorage.set("anthropic", {
        type: "oauth",
        refresh: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
      });
      process.stdout.write("✅ Login successful\n");
      
      if (mode === "max") {
        process.stdout.write("🎉 Successfully authenticated with Claude Max!\n");
      }
    } catch {
      logger.warn("Invalid code");
    }

  } catch (error) {
    logger.error("Authentication failed", error as Error);
  }
}

async function handleGenericLogin(provider: string, keyName: string) {
  process.stdout.write(`\n🔑 Please enter your ${keyName}:\n`);
  
  // Use simple input instead of password masking for easier debugging
  const key = await promptInput("API Key: ");
  
  if (!key || key.length === 0) {
    logger.warn("No API key provided");
    return;
  }

  try {
    await AuthStorage.set(provider, {
      type: "api",
      key,
    });

    process.stdout.write(`✅ Successfully stored ${keyName}!\n`);
  } catch (error) {
    logger.error("Failed to store API key", error as Error);
  }
}

