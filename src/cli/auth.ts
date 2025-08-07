import { Command } from "commander";
import { AnthropicAuth, AuthStorage } from "../auth/index.js";
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
  return new Promise((resolve) => {
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
    .command("login")
    .description("Login to a provider")
    .argument("[provider]", "Provider to login to")
    .action(async (provider?: string) => {
      try {
        process.stdout.write("🔐 OpenAgent Authentication\n\n");

        if (!provider) {
          process.stdout.write("Available providers:\n");
          process.stdout.write("  • anthropic    - Anthropic Claude (supports OAuth for Claude Max)\n");
          process.stdout.write("  • openai       - OpenAI GPT models\n");
          process.stdout.write("  • custom       - Custom provider\n");
          process.stdout.write("\n");
          
          provider = await promptInput("Select provider: ");
        }

        switch (provider.toLowerCase()) {
          case "anthropic":
            await handleAnthropicLogin();
            break;
          case "openai":
            await handleGenericLogin("openai", "OpenAI API Key");
            break;
          case "custom":
            await handleCustomLogin();
            break;
          default:
            await handleGenericLogin(provider, `${provider} API Key`);
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

      process.stdout.write("Stored credentials:\n");
      for (const [provider, auth] of Object.entries(credentials)) {
        const typeIcon = auth.type === "oauth" ? "🔑" : auth.type === "api" ? "🎫" : "🔧";
        process.stdout.write(`  ${typeIcon} ${provider} (${auth.type})\n`);
      }

      // Show environment variables
      const envVars = [
        { name: "ANTHROPIC_API_KEY", provider: "anthropic" },
        { name: "OPENAI_API_KEY", provider: "openai" },
      ];

      const activeEnvVars = envVars.filter(({ name }) => process.env[name]);
      if (activeEnvVars.length > 0) {
        process.stdout.write("\nEnvironment variables:\n");
        activeEnvVars.forEach(({ name, provider }) => {
          process.stdout.write(`  🌍 ${provider} (${name})\n`);
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

async function handleCustomLogin() {
  const provider = await promptInput("Custom provider ID: ");
  const keyName = await promptInput(`Display name for ${provider} (optional): `);
  
  await handleGenericLogin(provider, keyName || `${provider} API Key`);
}