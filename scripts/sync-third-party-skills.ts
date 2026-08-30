import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const defaultThirdPartyRoot = resolve(repoRoot, '..', 'agentuse-3rd-party-plugins');
const checkOnly = process.argv.includes('--check');
const rootFlag = process.argv.indexOf('--third-party-root');
const thirdPartyRoot = rootFlag >= 0
  ? resolve(process.argv[rootFlag + 1] ?? '')
  : defaultThirdPartyRoot;

const targets = [
  resolve(thirdPartyRoot, 'codex/plugins/agentuse/skills/automate'),
  resolve(thirdPartyRoot, 'claude-code/plugins/agentuse/skills/automate'),
  resolve(thirdPartyRoot, 'pi/skills/automate'),
];

const skills = ['automate', 'creator', 'tester'] as const;

async function getSkill(name: string): Promise<string> {
  const process = Bun.spawn(
    ['bun', 'src/index.ts', 'skills', 'get', name, '--full'],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'inherit' },
  );
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`agentuse skills get ${name} failed`);
  return output.endsWith('\n') ? output : `${output}\n`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildFreshnessAdapter(automate: string): string {
  const frontmatter = automate.match(/^---\n[\s\S]*?\n---\n/)?.[0];
  if (!frontmatter) throw new Error('automate skill is missing YAML frontmatter');

  return `${frontmatter}
# Automate with AgentUse

Treat the current conversation, invocation details, and repository state as the
originating workflow. Do not make the user restate context that is already
clear.

Try these sources in order and stop after the first successful skill load:

1. When \`npx\` is available, run
   \`npx -y agentuse@latest skills get automate --full\` once. Subject to the
   host's normal approval, sandbox, and network controls, follow the returned
   skill as authoritative for the current AgentUse release. Do not re-enter
   this freshness adapter from the returned instructions.
2. If that command is unavailable or fails, and \`agentuse\` is installed, run
   \`agentuse skills get automate --full\` once and follow the returned skill
   as authoritative for that installed version.
3. If neither source loads, read and follow
   [the bundled automate snapshot](references/automate.md). Its creator and
   tester references are available beside it. Use its artifact-only mode when
   no AgentUse command can execute.

Do not repeatedly retry a failed network or package command. Do not silently run
interactive setup or provider login.
`;
}

function expectedFiles(contents: Record<(typeof skills)[number], string>) {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const manifest = `${JSON.stringify({
    generatedBy: 'bun scripts/sync-third-party-skills.ts',
    sourcePackage: packageJson.name,
    sourceVersion: packageJson.version,
    skills: Object.fromEntries(skills.map((name) => [name, { sha256: sha256(contents[name]) }])),
  }, null, 2)}\n`;

  return {
    'SKILL.md': buildFreshnessAdapter(contents.automate),
    'references/automate.md': contents.automate,
    'references/creator.md': contents.creator,
    'references/tester.md': contents.tester,
    'bundle.json': manifest,
  };
}

function syncFile(path: string, content: string): boolean {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (current === content) return false;
  if (!checkOnly) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return true;
}

const contents = Object.fromEntries(
  await Promise.all(skills.map(async (name) => [name, await getSkill(name)])),
) as Record<(typeof skills)[number], string>;
const files = expectedFiles(contents);
const stale: string[] = [];

for (const target of targets) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = resolve(target, relativePath);
    if (syncFile(path, content)) stale.push(path);
  }
}

if (checkOnly && stale.length > 0) {
  console.error('Third-party AgentUse skill bundles are stale:');
  for (const path of stale) console.error(`- ${path}`);
  process.exit(1);
}

console.log(checkOnly ? 'Third-party AgentUse skill bundles are current.' : `Updated ${stale.length} bundled files.`);
