import { Command } from "commander";
import { generateAgent } from "../agent-generator";
import { writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { mkdir } from "fs/promises";
import { logger } from "../utils/logger";
import { existsSync } from "fs";
import readline from "readline";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

export function createAgentCommand(): Command {
  return new Command("create-agent")
    .description("Create an AI agent from a natural language description")
    .argument("<description>", "Natural language description of what the agent should do")
    .option("-o, --output <path>", "Output file path (default: ./agents/<agent-name>.agentmd)")
    .option("-f, --force", "Overwrite existing file without prompting")
    .option("-d, --dry-run", "Preview the generated agent without creating a file")
    .option("-m, --model <model>", "Override the default model for the agent")
    .action(async (description: string, options: { output?: string, force?: boolean, dryRun?: boolean, model?: string }) => {
      try {
        logger.info("Analyzing agent requirements...");
        
        // Generate agent configuration from description
        const agent = await generateAgent(description, options.model);
        
        // Format as .agentmd
        const agentContent = formatAgentMd(agent);
        
        if (options.dryRun) {
          // Just show the output
          console.log("\n--- Generated Agent ---");
          console.log(agentContent);
          console.log("--- End of Agent ---\n");
          return;
        }
        
        // Determine output path
        const outputPath = options.output || `./agents/${agent.name}.agentmd`;
        const absolutePath = resolve(outputPath);
        
        // Check if file exists
        if (existsSync(absolutePath) && !options.force) {
          const answer = await prompt(`File ${outputPath} already exists. Overwrite? [y/N]: `);
          if (answer !== 'y' && answer !== 'yes') {
            logger.info("Operation cancelled");
            return;
          }
        }
        
        // Create directory if needed
        const dir = dirname(absolutePath);
        await mkdir(dir, { recursive: true });
        
        // Write the file
        await writeFile(absolutePath, agentContent, 'utf-8');
        
        logger.info(`✅ Agent created successfully: ${absolutePath}`);
        logger.info(`\nRun your agent with:`);
        logger.info(`  openagent run ${outputPath}`);
        
      } catch (error) {
        logger.error("Failed to create agent", error as Error);
        process.exit(1);
      }
    });
}

function formatAgentMd(agent: any): string {
  const frontmatter = [
    '---',
    `model: ${agent.model}`,
  ];
  
  // Add MCP servers if any tools require them
  if (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) {
    frontmatter.push('mcp_servers:');
    for (const [name, config] of Object.entries(agent.mcpServers)) {
      const mcpConfig = config as any;
      frontmatter.push(`  ${name}:`);
      frontmatter.push(`    command: ${mcpConfig.command}`);
      if (mcpConfig.args && mcpConfig.args.length > 0) {
        frontmatter.push(`    args:`);
        mcpConfig.args.forEach((arg: string) => {
          frontmatter.push(`      - "${arg}"`);
        });
      }
      if (mcpConfig.env) {
        frontmatter.push(`    env:`);
        for (const [key, value] of Object.entries(mcpConfig.env)) {
          frontmatter.push(`      ${key}: "${value}"`);
        }
      }
    }
  }
  
  frontmatter.push('---');
  
  // Build the full content
  return [
    frontmatter.join('\n'),
    '',
    `# ${agent.name}`,
    '',
    agent.instructions.trim(),
  ].join('\n');
}