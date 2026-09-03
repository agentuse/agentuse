import { Command, Option } from "commander";
import { AuthStorage } from "../auth/index.js";
import readline from "readline";
import { logger } from "../utils/logger";
import { openBrowser as openBrowserUrl } from "../utils/open-browser";
import {
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER_ID,
} from "../providers/opencode-go";
import { AUTH_PROVIDERS, BUILTIN_PROVIDERS } from "../providers/registry-sources";
import { getProviderStatus } from "../auth/provider-status.js";
import { CUSTOM_PROVIDER_APIS, type CustomProviderApi } from "../auth/custom-provider-models.js";
import {
  completeProviderOAuth,
  configureCustomProvider,
  removeCustomProvider,
  removeProviderCredential,
  saveProviderApiKey,
  startProviderOAuth,
} from "../auth/provider-setup.js";
import { getProviderAdapters, getProviderPlugin, loadProviderPlugins, loginProviderPlugin, logoutProviderPlugin, providerPluginAuthStatus } from '../plugin/provider-runtime.js';
import { PROVIDER_PLUGIN_REGISTRY } from '../plugin/provider-registry.js';
import type { AuthInteraction } from '../plugin/types.js';

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseGitHubRepoFromRemote(remoteUrl: string): string | undefined {
  const sshMatch = remoteUrl.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== "github.com") return undefined;
    const repo = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return GITHUB_REPO_RE.test(repo) ? repo : undefined;
  } catch {
    return undefined;
  }
}

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

async function promptSecret(question: string): Promise<string> {
  const { isCancel, password } = await import('@clack/prompts');
  const answer = await password({ message: question.trim() });
  if (isCancel(answer)) throw new Error('Interrupted');
  return answer.trim();
}

function pluginAuthInteraction(): AuthInteraction {
  return {
    openBrowser: async ({ url }) => {
      if (!await openBrowserUrl(url)) process.stdout.write(`Open this URL in your browser:\n\n${url}\n\n`);
    },
    showDeviceCode: ({ userCode, verificationUri }) => process.stdout.write(`Open ${verificationUri} and enter ${userCode}\n`),
    prompt: ({ message, secret }) => secret
      ? promptSecret(message)
      : promptInput(message.endsWith(' ') ? message : `${message} `),
    select: async ({ message, choices }) => {
      process.stdout.write(`${message}\n${choices.map((choice, index) => `  ${index + 1}. ${choice.label}`).join('\n')}\n`);
      const value = await promptInput('Select: ');
      const selected = choices[Number(value) - 1] ?? choices.find((choice) => choice.value === value);
      if (!selected) throw new Error('Invalid authentication method');
      return selected.value;
    },
    notify: (message) => process.stdout.write(`${message}\n`),
  };
}


export function createProviderCommand(): Command {
  const authCmd = new Command("provider")
    .description("Manage providers and authentication credentials");

  authCmd
    .command("help")
    .description("Show authentication help and configuration options")
    .action(() => {
      process.stdout.write("🔐 AgentUse Authentication Help\n");
      process.stdout.write(`${"=".repeat(60)}\n\n`);
      
      process.stdout.write("AUTHENTICATION METHODS:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("1. Login Command (Recommended):\n");
      process.stdout.write("   agentuse provider login\n\n");
      
      process.stdout.write("2. Environment Variables:\n");
      process.stdout.write("   Set API keys directly in your environment:\n");
      process.stdout.write("   • ANTHROPIC_API_KEY     - For Anthropic Claude models\n");
      process.stdout.write("   • OPENAI_API_KEY        - For OpenAI GPT models\n");
      process.stdout.write("   • OPENROUTER_API_KEY    - For OpenRouter (multiple models)\n");
      process.stdout.write(`   • ${OPENCODE_GO_API_KEY_ENV}   - For ${OPENCODE_GO_DISPLAY_NAME} open coding models\n`);
      process.stdout.write("   • AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION\n");
      process.stdout.write("                           - For Amazon Bedrock (or AWS_BEARER_TOKEN_BEDROCK)\n\n");
      
      process.stdout.write("ENVIRONMENT VARIABLE SETUP:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("Bash/Zsh (~/.bashrc or ~/.zshrc):\n");
      process.stdout.write("  export ANTHROPIC_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  export OPENAI_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  export OPENROUTER_API_KEY=\"your-api-key\"\n");
      process.stdout.write(`  export ${OPENCODE_GO_API_KEY_ENV}="your-api-key"\n\n`);
      
      process.stdout.write("Fish (~/.config/fish/config.fish):\n");
      process.stdout.write("  set -x ANTHROPIC_API_KEY \"your-api-key\"\n");
      process.stdout.write("  set -x OPENAI_API_KEY \"your-api-key\"\n");
      process.stdout.write("  set -x OPENROUTER_API_KEY \"your-api-key\"\n");
      process.stdout.write(`  set -x ${OPENCODE_GO_API_KEY_ENV} "your-api-key"\n\n`);
      
      process.stdout.write("Windows (PowerShell):\n");
      process.stdout.write("  $env:ANTHROPIC_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  $env:OPENAI_API_KEY=\"your-api-key\"\n");
      process.stdout.write("  $env:OPENROUTER_API_KEY=\"your-api-key\"\n");
      process.stdout.write(`  $env:${OPENCODE_GO_API_KEY_ENV}="your-api-key"\n\n`);
      
      process.stdout.write("Windows (Command Prompt):\n");
      process.stdout.write("  set ANTHROPIC_API_KEY=your-api-key\n");
      process.stdout.write("  set OPENAI_API_KEY=your-api-key\n");
      process.stdout.write("  set OPENROUTER_API_KEY=your-api-key\n");
      process.stdout.write(`  set ${OPENCODE_GO_API_KEY_ENV}=your-api-key\n\n`);
      
      process.stdout.write("PRIORITY ORDER:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("1. OAuth tokens (OpenAI Codex or installed provider plugins)\n");
      process.stdout.write("2. Environment variables\n");
      process.stdout.write("3. Stored API keys (via provider login)\n\n");
      
      process.stdout.write("COMMANDS:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("  provider login [provider]       - Store API credentials\n");
      process.stdout.write("  provider logout [provider]      - Remove stored credentials\n");
      process.stdout.write("  provider add <name> --url <url> - Add custom endpoint\n");
      process.stdout.write("  provider remove <name>          - Remove a provider\n");
      process.stdout.write("  provider list [--json]          - Show provider authentication status\n");
      process.stdout.write("  provider help                   - Show this help message\n");
      process.stdout.write("  plugins list|install|remove     - Manage provider plugins (e.g. Claude Pro/Max)\n\n");
      
      process.stdout.write("GETTING API KEYS:\n");
      process.stdout.write("─".repeat(40) + "\n");
      process.stdout.write("• Anthropic:   https://console.anthropic.com/account/keys\n");
      process.stdout.write("• OpenAI:      https://platform.openai.com/api-keys\n");
      process.stdout.write("• OpenRouter:  https://openrouter.ai/keys\n");
      process.stdout.write("• OpenCode Go: https://opencode.ai/auth\n");
      process.stdout.write("• AWS Bedrock: https://console.aws.amazon.com/iam (create access key with AmazonBedrockFullAccess)\n");
    });

  const addProviderCommand = authCmd
    .command("add <name>")
    .description("Add a custom provider endpoint")
    .requiredOption("--url <url>", "Base URL of the provider endpoint")
    .option("--api <format>", "API format override: openai-completions, openai-responses, or anthropic-messages", "auto")
    .option("--key <key>", "Optional API key for the endpoint")
    .option("--model <id>", "Model ID to save when automatic discovery is unavailable (repeatable)", (id, models: string[]) => [...models, id], [])
    .addOption(new Option("--no-developer-role").hideHelp())
    .addOption(new Option("--no-reasoning-effort").hideHelp())
    .addOption(new Option("--no-stream-usage").hideHelp())
    .addOption(new Option("--no-store").hideHelp())
    .addOption(new Option("--max-tokens-field <field>").hideHelp())
    .addHelpText("after", `
Advanced compatibility overrides (custom endpoints only):
  --no-developer-role           Endpoint rejects developer-role messages
  --no-reasoning-effort         Endpoint rejects reasoning_effort
  --no-stream-usage             Endpoint omits usage from streaming responses
  --no-store                    Endpoint rejects the store field
  --max-tokens-field <field>    max_tokens or max_completion_tokens

Use these only when an endpoint reports a protocol compatibility error.
`);

  addProviderCommand.action(async (name: string, options: {
      url: string;
      key?: string;
      api: string;
      model: string[];
      developerRole: boolean;
      reasoningEffort: boolean;
      streamUsage: boolean;
      store: boolean;
      maxTokensField?: string;
    }) => {
      // Validate name doesn't conflict with built-in providers
      if (BUILTIN_PROVIDERS.includes(name.toLowerCase())) {
        logger.error(`Cannot use reserved provider name '${name}'. Reserved: ${BUILTIN_PROVIDERS.join(", ")}`);
        process.exit(1);
      }

      // Validate name format (alphanumeric, hyphens, underscores)
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
        logger.error("Provider name must start with a letter and contain only letters, numbers, hyphens, and underscores");
        process.exit(1);
      }

      // Validate URL format
      try {
        new URL(options.url);
      } catch {
        logger.error(`Invalid URL: ${options.url}`);
        process.exit(1);
      }

      if (options.maxTokensField && !["max_tokens", "max_completion_tokens"].includes(options.maxTokensField)) {
        logger.error("--max-tokens-field must be max_tokens or max_completion_tokens");
        process.exit(1);
      }
      if (options.api !== 'auto' && !CUSTOM_PROVIDER_APIS.includes(options.api as CustomProviderApi)) {
        logger.error(`--api must be auto or one of: ${CUSTOM_PROVIDER_APIS.join(', ')}`);
        process.exit(1);
      }

      const compatibility = {
        ...(options.developerRole === false && { supportsDeveloperRole: false }),
        ...(options.reasoningEffort === false && { supportsReasoningEffort: false }),
        ...(options.streamUsage === false && { supportsUsageInStreaming: false }),
        ...(options.store === false && { supportsStore: false }),
        ...(options.maxTokensField && {
          maxTokensField: options.maxTokensField as "max_tokens" | "max_completion_tokens",
        }),
      };

      try {
        const configured = await configureCustomProvider({
          name,
          baseURL: options.url,
          key: options.key,
          api: options.api,
          models: options.model,
          compatibility,
        });
        const { name: providerName, provider, models } = configured;

        process.stdout.write(`✅ Added custom provider '${providerName}'\n`);
        process.stdout.write(`   URL: ${provider.baseURL}\n`);
        process.stdout.write(`   API: ${provider.api}${options.api === 'auto' ? ' (detected)' : ''}\n`);
        if (options.key) process.stdout.write(`   Key: ****${options.key.slice(-4)}\n`);
        process.stdout.write(`   Models: ${models.length} saved\n`);
        process.stdout.write(`\nUsage: agentuse run agent.agentuse -m ${providerName}:${models[0]}\n`);
      } catch (error) {
        logger.error(`Could not configure provider: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  authCmd
    .command("login")
    .description("Login to a provider")
    .argument("[provider]", "Provider to login to")
    .action(async (provider?: string) => {
      try {
        process.stdout.write("🔐 AgentUse Authentication\n\n");

        if (!provider) {
          const pluginProviders = (await loadProviderPlugins()).filter((plugin) => plugin.auth);
          process.stdout.write("Available providers:\n");
          process.stdout.write("  1. anthropic    - Anthropic Claude API\n");
          process.stdout.write("  2. openai       - OpenAI GPT models\n");
          process.stdout.write("  3. openrouter   - OpenRouter (access to multiple models)\n");
          process.stdout.write(`  4. ${OPENCODE_GO_PROVIDER_ID}  - ${OPENCODE_GO_DISPLAY_NAME} open coding models\n`);
          pluginProviders.forEach((plugin, index) => {
            process.stdout.write(`  ${index + 5}. ${plugin.id}  - ${plugin.name} (plugin)\n`);
          });
          process.stdout.write("\n");
          
          const selection = await promptInput(`Select provider (1-${pluginProviders.length + 4} or name): `);
          
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
            case "4":
              provider = OPENCODE_GO_PROVIDER_ID;
              break;
            default:
              provider = pluginProviders[Number(selection) - 5]?.id ?? selection;
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
          case OPENCODE_GO_PROVIDER_ID:
            await handleGenericLogin(OPENCODE_GO_PROVIDER_ID, `${OPENCODE_GO_DISPLAY_NAME} API Key`);
            break;
          default:
            {
              const plugin = await getProviderPlugin(provider.toLowerCase());
              if (!plugin?.auth) {
                logger.warn(`Unknown provider: ${provider}`);
                process.exit(1);
              }
              await loginProviderPlugin(plugin, pluginAuthInteraction());
            }
        }
      } catch (error) {
        logger.error("Login failed", error as Error);
        process.exit(1);
      }
    });

  authCmd
    .command("logout")
    .alias("remove")
    .description("Logout from a provider or remove a custom provider")
    .argument("[provider]", "Provider to logout from or custom provider to remove")
    .option("--oauth", "Remove only OAuth credentials")
    .option("--api", "Remove only API key credentials")
    .action(async (provider?: string, options?: { oauth?: boolean; api?: boolean }) => {
      if (provider) {
        const providerId = provider.toLowerCase();
        const plugin = await getProviderPlugin(providerId);
        if (plugin?.auth) {
          await logoutProviderPlugin(plugin);
          process.stdout.write(`✅ Logged out from ${plugin.name}\n`);
          return;
        }
        if (!options?.api) {
          const adapter = (await getProviderAdapters(providerId)).find((candidate) => candidate.provider.auth);
          if (adapter) {
            const sources = await providerPluginAuthStatus(adapter.provider);
            if (sources.some((source) => source.kind === 'oauth')) {
              await logoutProviderPlugin(adapter.provider);
              process.stdout.write(`✅ Logged out from ${adapter.provider.name}\n`);
              return;
            }
          }
        }
      }
      const knownProviders = AUTH_PROVIDERS;

      // Build list of stored credentials
      const storedList: { provider: string; type: string; key: string; isCustom?: boolean }[] = [];
      for (const p of knownProviders) {
        const providerAuth = await AuthStorage.getProviderAuth(p);
        if (providerAuth.oauth) {
          storedList.push({
            provider: p,
            type: providerAuth.oauth.type === "codex-oauth" ? "ChatGPT OAuth" : "OAuth",
            key: `${p}:oauth`,
          });
        }
        if (providerAuth.api) {
          storedList.push({
            provider: p,
            type: "API key",
            key: `${p}:api`,
          });
        }
      }

      // Add custom providers to the list
      const customProviders = await AuthStorage.getCustomProviders();
      for (const [name, config] of Object.entries(customProviders)) {
        storedList.push({
          provider: name,
          type: `Custom (${config.baseURL})`,
          key: `custom:${name}`,
          isCustom: true,
        });
      }

      if (storedList.length === 0) {
        logger.warn("No stored credentials found");
        return;
      }

      if (!provider) {
        process.stdout.write("Stored credentials:\n");
        storedList.forEach((item, i) => {
          process.stdout.write(`  ${i + 1}. ${item.provider} (${item.type})\n`);
        });
        process.stdout.write("\n");

        const selection = await promptInput("Select credential to remove: ");
        const index = parseInt(selection) - 1;

        if (index >= 0 && index < storedList.length) {
          const item = storedList[index];
          if (item.isCustom) {
            await removeCustomProvider(item.provider);
          } else if (item.key.endsWith(":oauth")) {
            await removeProviderCredential(item.provider, 'oauth');
          } else {
            await removeProviderCredential(item.provider, 'api_key');
          }
          process.stdout.write(`✅ Removed ${item.type} from ${item.provider}\n`);
          return;
        } else {
          provider = selection;
        }
      }

      // Check if it's a custom provider first
      const customProvider = await AuthStorage.getCustomProvider(provider);
      if (customProvider) {
        await removeCustomProvider(provider);
        process.stdout.write(`✅ Removed custom provider '${provider}'\n`);
        return;
      }

      // Handle provider-specific logout
      const providerAuth = await AuthStorage.getProviderAuth(provider);
      const hasOAuth = !!providerAuth.oauth;
      const hasApiKey = !!providerAuth.api;

      if (!hasOAuth && !hasApiKey) {
        logger.warn(`No credentials found for ${provider}`);
        return;
      }

      // If specific flag is set, remove only that type
      if (options?.oauth) {
        if (hasOAuth) {
          await removeProviderCredential(provider, 'oauth');
          process.stdout.write(`✅ Removed OAuth from ${provider}\n`);
        } else {
          logger.warn(`No OAuth credentials found for ${provider}`);
        }
        return;
      }

      if (options?.api) {
        if (hasApiKey) {
          await removeProviderCredential(provider, 'api_key');
          process.stdout.write(`✅ Removed API key from ${provider}\n`);
        } else {
          logger.warn(`No API key found for ${provider}`);
        }
        return;
      }

      // If both exist, ask which to remove
      if (hasOAuth && hasApiKey) {
        process.stdout.write(`${provider} has both OAuth and API key configured:\n`);
        process.stdout.write("  1. OAuth\n");
        process.stdout.write("  2. API key\n");
        process.stdout.write("  3. Both\n\n");

        const selection = await promptInput("Select what to remove (1-3): ");

        switch (selection) {
          case "1":
            await removeProviderCredential(provider, 'oauth');
            process.stdout.write(`✅ Removed OAuth from ${provider}\n`);
            break;
          case "2":
            await removeProviderCredential(provider, 'api_key');
            process.stdout.write(`✅ Removed API key from ${provider}\n`);
            break;
          case "3":
            await removeProviderCredential(provider, 'oauth');
            await removeProviderCredential(provider, 'api_key');
            process.stdout.write(`✅ Removed all credentials from ${provider}\n`);
            break;
          default:
            logger.warn("Invalid selection");
        }
      } else {
        // Only one type exists, remove it
        if (hasOAuth) {
          await removeProviderCredential(provider, 'oauth');
          process.stdout.write(`✅ Removed OAuth from ${provider}\n`);
        } else {
          await removeProviderCredential(provider, 'api_key');
          process.stdout.write(`✅ Removed API key from ${provider}\n`);
        }
      }
    });

  authCmd
    .command("list")
    .alias("ls")
    .description("List stored credentials")
    .option("--json", "Output provider status as JSON")
    .action(async (options: { json?: boolean }) => {
      const status = await getProviderStatus();

      if (options.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }

      const authPath = status.credentialStore;
      const homedir = process.env.HOME || process.env.USERPROFILE || "";
      const displayPath = authPath.startsWith(homedir)
        ? authPath.replace(homedir, "~")
        : authPath;

      process.stdout.write(`📁 Credentials stored in: ${displayPath}\n\n`);

      process.stdout.write("Authentication (in priority order):\n");
      process.stdout.write("─".repeat(50) + "\n\n");

      for (const provider of status.providers.filter((item) => item.configured)) {
        process.stdout.write(`${provider.name}:\n`);
        for (const source of provider.sources) {
          const icon = source.kind === "oauth" ? "🔑" : source.kind === "api_key" ? "🎫" : "🌍";
          const activeMarker = source.active ? " ← active" : "";
          const priorityLabel = `[${source.priority}]`;
          process.stdout.write(`  ${priorityLabel} ${icon} ${source.name}${activeMarker}\n`);
        }
        if (provider.actionRequired) process.stdout.write(`  ⚠️  ${provider.actionRequired}\n`);
        process.stdout.write("\n");
      }

      const unconfiguredProviders = status.providers.filter((provider) => !provider.configured);

      if (unconfiguredProviders.length > 0) {
        process.stdout.write("Not configured:\n");
        for (const provider of unconfiguredProviders) {
          process.stdout.write(provider.actionRequired
            ? `  ⚠️  ${provider.name} - ${provider.actionRequired}\n`
            : `  ⚠️  ${provider.name} - run \`agentuse provider login ${provider.id}\`\n`);
        }
        process.stdout.write("\n");
      }

      if (status.customProviders.length > 0) {
        const customProviderAuth = await AuthStorage.getCustomProviders();
        process.stdout.write("Custom Providers:\n");
        process.stdout.write("─".repeat(50) + "\n");
        for (const provider of status.customProviders) {
          const key = customProviderAuth[provider.id]?.key;
          const keyStatus = key ? ` (key: ****${key.slice(-4)})` : "";
          process.stdout.write(`  🔌 ${provider.id} → ${provider.baseURL}${keyStatus}\n`);
        }
        process.stdout.write("\n");
      }

      process.stdout.write("Priority: [1] OAuth → [2] Environment API key → [3] Stored API key\n");
    });

  authCmd
    .command("setup-github")
    .description("Set up long-lived OAuth token for GitHub Actions (1 year validity)")
    .option("--repo <repo>", "GitHub repository (owner/repo) - auto-detected from git if not specified")
    .action(async (options: { repo?: string }) => {
      const { execFileSync, spawnSync } = await import("child_process");

      // Auto-detect repo from git remote if not specified
      if (!options.repo) {
        try {
          const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
          const repo = parseGitHubRepoFromRemote(remoteUrl);
          if (repo) {
            options.repo = repo;
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
      if (!GITHUB_REPO_RE.test(options.repo)) {
        logger.error(`Invalid repository "${options.repo}". Expected owner/repo`);
        process.exit(1);
      }

      // Check prerequisites
      try {
        execFileSync("gh", ["--version"], { stdio: "ignore" });
      } catch {
        logger.error("GitHub CLI (gh) is not installed. Run: brew install gh");
        process.exit(1);
      }

      try {
        execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
      } catch {
        logger.error("Not authenticated with gh. Run: gh auth login");
        process.exit(1);
      }

      // Check if we have secrets:write permission by trying to list secrets
      try {
        execFileSync("gh", ["secret", "list", "--repo", options.repo], { stdio: "ignore" });
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
        const result = spawnSync("gh", ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--repo", options.repo], {
          input: token,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (result.status !== 0) {
          throw new Error(result.stderr || result.error?.message || "gh secret set failed");
        }

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
  const adapter = (await getProviderAdapters('anthropic')).find((candidate) => candidate.provider.auth);
  if (!adapter) {
    const subscription = PROVIDER_PLUGIN_REGISTRY.find((entry) => entry.provider === 'anthropic');
    if (subscription) {
      process.stdout.write(`Tip: Claude Pro/Max login needs a plugin: agentuse plugins install ${subscription.source}\n\n`);
    }
    await handleGenericLogin("anthropic", "Anthropic API Key");
    return;
  }

  process.stdout.write("Anthropic login methods:\n");
  process.stdout.write(`  1. ${adapter.provider.name} (OAuth)\n`);
  process.stdout.write("  2. Anthropic API Key\n\n");
  const method = await promptInput("Select method (1-2): ");
  if (method === '1') {
    await loginProviderPlugin(adapter.provider, pluginAuthInteraction());
  } else if (method === '2') {
    await handleGenericLogin("anthropic", "Anthropic API Key");
  } else {
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
    const flow = await startProviderOAuth('openai');

    process.stdout.write(`${"=".repeat(80)}\n`);
    process.stdout.write(`📋 AUTHORIZATION URL:\n`);
    process.stdout.write(`${flow.authorizationUrl}\n`);
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

    process.stdout.write("🔄 Exchanging code for tokens...\n");

    try {
      await completeProviderOAuth(flow.flowId, callbackUrl);
      process.stdout.write("✅ Successfully authenticated with ChatGPT!\n");
    } catch {
      logger.warn("Invalid code or authorization failed");
    }
  } catch (error) {
    logger.error("Authentication failed", error as Error);
  }
}

/** Create 'auth' command as hidden alias for backward compatibility */
export function createAuthCommand(): Command {
  const cmd = createProviderCommand();
  // Override the command name to 'auth' for the alias
  cmd.name('auth');
  return cmd;
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
    await saveProviderApiKey(provider, key);

    process.stdout.write(`✅ Successfully stored ${keyName}!\n`);
  } catch (error) {
    logger.error("Failed to store API key", error as Error);
  }
}
