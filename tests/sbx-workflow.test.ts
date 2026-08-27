import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { parse } from 'yaml';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Docker Sandbox development workflow', () => {
  it('declares a named Codex clone environment with loopback-only onboarding', () => {
    const env = parse(read('.sbxenv.yaml'));
    expect(env).toEqual({
      schemaVersion: '1',
      name: 'agentuse-dev',
      agent: 'codex',
      workspace: { path: '.', clone: true },
      ports: [{ sandbox: 12233, host: 12233, hostIP: '127.0.0.1', protocol: 'tcp4' }],
    });
  });

  it('pins repo toolchains and uses a frozen install before build', () => {
    const script = read('scripts/sbx-bootstrap.sh');
    expect(script).toContain('.tool-versions');
    expect(script).toContain('packageManager');
    expect(script).toContain('pnpm install --frozen-lockfile');
    expect(script.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(script.indexOf('pnpm run build'));
  });

  it('refuses the no-auth exposed bind outside a clone Docker Sandbox', () => {
    const result = spawnSync('bash', ['scripts/sbx-onboarding-smoke.sh'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing --host 0.0.0.0 --no-auth outside a clone-mode Docker Sandbox');
  });

  it('isolates AgentUse state and does not import coding-agent credentials', () => {
    const script = read('scripts/sbx-onboarding-smoke.sh');
    expect(script).toContain('export HOME="$SMOKE_HOME/home"');
    expect(script).toContain('export AGENTUSE_CONFIG="$SMOKE_HOME/config/config.json"');
    expect(script).toContain('export XDG_DATA_HOME="$SMOKE_HOME/data"');
    expect(script).not.toContain('.codex/auth');
    expect(script).not.toContain('.agentuse/config');
  });
});
