import { Command } from "commander";
import { AnthropicAuth, AuthStorage } from "../auth/index.js";
import readline from "readline";

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
        console.log("🔐 OpenAgent Authentication\n");

        if (!provider) {
          console.log("Available providers:");
          console.log("  • anthropic    - Anthropic Claude (supports OAuth for Claude Max)");
          console.log("  • openai       - OpenAI GPT models");
          console.log("  • custom       - Custom provider");
          console.log("");
          
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
        console.error("❌ Login failed:", error);
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
        console.log("❌ No stored credentials found");
        return;
      }

      if (!provider) {
        console.log("Stored credentials:");
        providers.forEach((p, i) => {
          const auth = credentials[p];
          console.log(`  ${i + 1}. ${p} (${auth.type})`);
        });
        console.log("");
        
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
        console.log(`✅ Logged out from ${provider}`);
      } else {
        console.log(`❌ No credentials found for ${provider}`);
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

      console.log(`📁 Credentials stored in: ${displayPath}\n`);

      if (Object.keys(credentials).length === 0) {
        console.log("No stored credentials");
        return;
      }

      console.log("Stored credentials:");
      for (const [provider, auth] of Object.entries(credentials)) {
        const typeIcon = auth.type === "oauth" ? "🔑" : auth.type === "api" ? "🎫" : "🔧";
        console.log(`  ${typeIcon} ${provider} (${auth.type})`);
      }

      // Show environment variables
      const envVars = [
        { name: "ANTHROPIC_API_KEY", provider: "anthropic" },
        { name: "OPENAI_API_KEY", provider: "openai" },
      ];

      const activeEnvVars = envVars.filter(({ name }) => process.env[name]);
      if (activeEnvVars.length > 0) {
        console.log("\nEnvironment variables:");
        activeEnvVars.forEach(({ name, provider }) => {
          console.log(`  🌍 ${provider} (${name})`);
        });
      }
    });

  return authCmd;
}

async function handleAnthropicLogin() {
  console.log("Anthropic login methods:");
  console.log("  1. Claude Pro/Max Plan (OAuth) (Experimental)");
  console.log("  2. Anthropic Console (OAuth)");
  console.log("  3. Manual API Key");
  console.log("");

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
      console.log("❌ Invalid selection");
  }
}

async function handleAnthropicOAuth(mode: "max" | "console") {
  // Some weird bug where program exits without this delay (from OpenCode)
  await new Promise((resolve) => setTimeout(resolve, 10));
  
  console.log(`\n🔄 Starting ${mode === "max" ? "Claude Pro/Max" : "Console"} OAuth flow...\n`);

  try {
    const { url, verifier } = await AnthropicAuth.authorize(mode);
    
    // Always show the URL prominently  
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📋 AUTHORIZATION URL:`);
    console.log(`${url}`);
    console.log(`${"=".repeat(80)}\n`);

    console.log("📝 Steps:");
    console.log("   1. Visit the URL above in your browser");
    console.log("   2. Sign in to Claude and authorize the application");
    console.log("   3. Copy the authorization code you receive");
    console.log("   4. Paste it below\n");

    const code = await promptInput("📝 Paste the authorization code here: ");
    
    if (!code || code.length === 0) {
      console.log("❌ No code provided");
      return;
    }

    console.log("🔄 Exchanging code for tokens...");
    
    try {
      const credentials = await AnthropicAuth.exchange(code, verifier);
      await AuthStorage.set("anthropic", {
        type: "oauth",
        refresh: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
      });
      console.log("✅ Login successful");
      
      if (mode === "max") {
        console.log("🎉 Successfully authenticated with Claude Max!");
      }
    } catch {
      console.log("❌ Invalid code");
    }

  } catch (error) {
    console.log("❌ Authentication failed");
    console.log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleGenericLogin(provider: string, keyName: string) {
  console.log(`\n🔑 Please enter your ${keyName}:`);
  
  // Use simple input instead of password masking for easier debugging
  const key = await promptInput("API Key: ");
  
  if (!key || key.length === 0) {
    console.log("❌ No API key provided");
    return;
  }

  try {
    await AuthStorage.set(provider, {
      type: "api",
      key,
    });

    console.log(`✅ Successfully stored ${keyName}!`);
  } catch (error) {
    console.log(`❌ Failed to store API key: ${error}`);
  }
}

async function handleCustomLogin() {
  const provider = await promptInput("Custom provider ID: ");
  const keyName = await promptInput(`Display name for ${provider} (optional): `);
  
  await handleGenericLogin(provider, keyName || `${provider} API Key`);
}