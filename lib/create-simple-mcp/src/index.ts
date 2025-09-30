#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Options {
  projectName: string;
  targetDir: string;
  skipInstall: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const projectName = args[0] || 'my-mcp-tools';
  const skipInstall = args.includes('--skip-install');

  return {
    projectName,
    targetDir: path.resolve(process.cwd(), projectName),
    skipInstall
  };
}

function showHelp() {
  console.log(`
create-simple-mcp - Scaffold a new MCP tools project

Usage:
  npm create simple-mcp [project-name]

Options:
  --skip-install    Skip automatic npm install
  --help, -h        Show this help message

Examples:
  npm create simple-mcp my-tools
  npx create-simple-mcp my-tools
  npm create simple-mcp my-tools --skip-install
`);
}

function copyTemplate(src: string, dest: string, replacements: Record<string, string>) {
  const content = fs.readFileSync(src, 'utf-8');

  // Replace template variables
  let output = content;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }

  fs.writeFileSync(dest, output, 'utf-8');
}

function copyDirectory(src: string, dest: string, replacements: Record<string, string>) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name.replace('.template', ''));

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath, replacements);
    } else {
      if (entry.name.endsWith('.template')) {
        copyTemplate(srcPath, destPath, replacements);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

async function main() {
  const args = parseArgs();

  // Check for help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const { projectName, targetDir, skipInstall } = args;

  console.log(`\n🚀 Creating MCP tools project: ${projectName}\n`);

  // Check if directory already exists
  if (fs.existsSync(targetDir)) {
    console.error(`❌ Error: Directory ${projectName} already exists`);
    process.exit(1);
  }

  try {
    // Find templates directory
    // When built, templates will be at dist/../templates
    // When in development, templates will be at src/../templates
    const templatesDir = path.resolve(__dirname, '..', 'templates');

    if (!fs.existsSync(templatesDir)) {
      console.error(`❌ Error: Templates directory not found at ${templatesDir}`);
      process.exit(1);
    }

    // Create project directory
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`✓ Created directory: ${projectName}/`);

    // Copy templates with variable substitution
    const replacements = {
      PROJECT_NAME: projectName
    };

    copyDirectory(templatesDir, targetDir, replacements);
    console.log(`✓ Copied template files`);

    // Install dependencies
    if (!skipInstall) {
      console.log(`\n📦 Installing dependencies...\n`);

      try {
        execSync('npm install', {
          cwd: targetDir,
          stdio: 'inherit'
        });
        console.log(`\n✓ Dependencies installed`);
      } catch (error) {
        console.error(`\n⚠️  Failed to install dependencies. Run 'npm install' manually.`);
      }
    }

    // Print success message
    console.log(`
✨ Success! Created ${projectName}

Get started:
  cd ${projectName}
  ${skipInstall ? 'npm install\n  ' : ''}npm run serve

Your project includes:
  📁 tools/example.ts  - Example tool with HTTP requests
  📁 tools/date.ts     - Simple date/time tool

Next steps:
  1. Edit tools/example.ts or create new tools
  2. Test with: npm run serve
  3. Use with Claude Desktop or AgentUse

Documentation:
  🔗 https://github.com/agentuse/agentuse/tree/main/lib/simple-mcp

Happy building! 🎉
`);

  } catch (error) {
    console.error(`\n❌ Error creating project:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});