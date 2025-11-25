import { Command } from "commander";
import { AnthropicAuth, AuthStorage } from "../auth/index.js";
import readline from "readline";
import { logger } from "../utils/logger";
import { getModelSuggestions } from "../utils/models-api";

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
      process.stdout.write("1. OAuth tokens (for Anthropic)\n");
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
            await handleGenericLogin("openai", "OpenAI API Key");
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

      if (Object.keys(credentials).length === 0) {
        process.stdout.write("No stored credentials\n");
        return;
      }

      // Get dynamic model suggestions
      const modelSuggestions = await getModelSuggestions();
      
      process.stdout.write("Stored credentials:\n");
      for (const [provider, auth] of Object.entries(credentials)) {
        const typeIcon = auth.type === "oauth" ? "🔑" : auth.type === "api" ? "🎫" : "🔧";
        let modelExample = "";
        
        // Use dynamic suggestions if available
        if (modelSuggestions) {
          const suggestion = modelSuggestions.find(s => s.provider === provider);
          if (suggestion) {
            modelExample = ` → Use as: ${provider}:${suggestion.modelId}`;
          }
        }
        
        process.stdout.write(`  ${typeIcon} ${provider} (${auth.type})${modelExample}\n`);
      }

      // Show environment variables
      const envVars = [
        { name: "ANTHROPIC_API_KEY", provider: "anthropic" },
        { name: "OPENAI_API_KEY", provider: "openai" },
        { name: "OPENROUTER_API_KEY", provider: "openrouter" },
      ];

      const activeEnvVars = envVars.filter(({ name }) => process.env[name]);
      if (activeEnvVars.length > 0) {
        process.stdout.write("\nEnvironment variables:\n");
        activeEnvVars.forEach(({ name, provider }) => {
          let modelExample = "";
          
          // Use dynamic suggestions if available
          if (modelSuggestions) {
            const suggestion = modelSuggestions.find(s => s.provider === provider);
            if (suggestion) {
              modelExample = ` → Use as: ${provider}:${suggestion.modelId}`;
            }
          }
          
          process.stdout.write(`  🌍 ${provider} (${name})${modelExample}\n`);
        });
      }
      
      // Show model usage examples with dynamic suggestions
      if (modelSuggestions && modelSuggestions.length > 0) {
        process.stdout.write("\nModel usage examples:\n");
        modelSuggestions.forEach(suggestion => {
          process.stdout.write(`  agentuse run agent.md --model ${suggestion.provider}:${suggestion.modelId}\n`);
        });
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

