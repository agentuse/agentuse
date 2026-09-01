import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDesktopGlobalDefaults } from "./global-defaults";

describe("Desktop global defaults", () => {
  const roots: string[] = [];
  const originalConfigDir = process.env.AGENTUSE_CONFIG_DIR;
  const originalConfig = process.env.AGENTUSE_CONFIG;
  const originalEnv = process.env.AGENTUSE_ENV;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.AGENTUSE_CONFIG_DIR;
    else process.env.AGENTUSE_CONFIG_DIR = originalConfigDir;
    if (originalConfig === undefined) delete process.env.AGENTUSE_CONFIG;
    else process.env.AGENTUSE_CONFIG = originalConfig;
    if (originalEnv === undefined) delete process.env.AGENTUSE_ENV;
    else process.env.AGENTUSE_ENV = originalEnv;
    delete process.env.DESKTOP_ENV_FILE_KEY;
    delete process.env.DESKTOP_CONFIG_ENV_KEY;
  });

  it("loads AGENTUSE_CONFIG_DIR defaults before Desktop runtime checks", () => {
    const root = mkdtempSync(join(tmpdir(), "agentuse-desktop-defaults-"));
    roots.push(root);
    const envPath = join(root, ".env");
    const configPath = join(root, "config.json");
    writeFileSync(envPath, "DESKTOP_ENV_FILE_KEY=from-env-file\n");
    writeFileSync(configPath, JSON.stringify({ env: { DESKTOP_CONFIG_ENV_KEY: "from-config" } }));
    process.env.AGENTUSE_CONFIG_DIR = root;
    delete process.env.AGENTUSE_ENV;
    delete process.env.AGENTUSE_CONFIG;

    const loaded = initializeDesktopGlobalDefaults();

    expect(loaded.envFile).toBe(envPath);
    expect(loaded.configEnvKeys).toContain("DESKTOP_CONFIG_ENV_KEY");
    expect(process.env.DESKTOP_ENV_FILE_KEY).toBe("from-env-file");
    expect(process.env.DESKTOP_CONFIG_ENV_KEY).toBe("from-config");
  });
});
