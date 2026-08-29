import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCliAvailability, inspectCliLink, toggleCliLink } from "./cli-link";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentuse-cli-link-"));
  roots.push(root);
  const launcher = join(root, "AgentUse.app", "Contents", "Resources", "bin", "agentuse");
  const link = join(root, "home", ".local", "bin", "agentuse");
  mkdirSync(join(root, "AgentUse.app", "Contents", "Resources", "bin"), { recursive: true });
  writeFileSync(launcher, "launcher", { mode: 0o755 });
  chmodSync(launcher, 0o755);
  return { launcher, link };
}

describe("desktop CLI link", () => {
  it("installs and removes the app-managed symlink", async () => {
    const { launcher, link } = fixture();
    expect(inspectCliLink(link, launcher).status).toBe("notInstalled");
    expect((await toggleCliLink(link, launcher, join(link, ".."))).status).toBe("installed");
    expect((await toggleCliLink(link, launcher, join(link, ".."))).status).toBe("notInstalled");
  });

  it("offers an explicit replacement for an existing command at the managed path", async () => {
    const { launcher, link } = fixture();
    mkdirSync(join(link, ".."), { recursive: true });
    writeFileSync(link, "existing command");
    const conflict = inspectCliLink(link, launcher);
    expect(conflict.status).toBe("conflict");
    expect(conflict.actionLabel).toBe("Replace");
    expect(conflict.actionDisabled).toBe(false);
    expect((await toggleCliLink(link, launcher, join(link, ".."))).status).toBe("installed");
  });

  it("recognizes only a link to this app launcher", () => {
    const { launcher, link } = fixture();
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync("somewhere-else", link);
    expect(inspectCliLink(link, launcher).status).toBe("conflict");
  });

  it("allows the app launcher to be added when another installation is already on PATH", async () => {
    const { launcher, link } = fixture();
    const externalBin = join(link, "..", "..", "..", "npm-bin");
    const externalCommand = join(externalBin, "agentuse");
    mkdirSync(externalBin, { recursive: true });
    writeFileSync(externalCommand, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(externalCommand, 0o755);

    const state = inspectCliAvailability(link, launcher, externalBin);
    expect(state.status).toBe("notInstalled");
    expect(state.commands).toEqual([externalCommand]);
    expect(state.actionLabel).toBe("Add");
    expect(state.actionDisabled).toBe(false);
    expect((await toggleCliLink(link, launcher, externalBin)).status).toBe("installed");
  });

  it("warns when another installation precedes the app link", async () => {
    const { launcher, link } = fixture();
    const externalBin = join(link, "..", "..", "..", "pnpm-bin");
    const externalCommand = join(externalBin, "agentuse");
    mkdirSync(externalBin, { recursive: true });
    writeFileSync(externalCommand, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(externalCommand, 0o755);
    await toggleCliLink(link, launcher, join(link, ".."));

    const state = inspectCliAvailability(link, launcher, `${externalBin}:${join(link, "..")}`);
    expect(state.status).toBe("installed");
    expect(state.detail).toContain(externalCommand);
    expect(state.actionLabel).toBe("Remove");
    expect(state.commands).toEqual([externalCommand, link]);
  });

  it("lists every command path in login-shell resolution order", () => {
    const { launcher, link } = fixture();
    const firstBin = join(link, "..", "..", "..", "first-bin");
    const secondBin = join(link, "..", "..", "..", "second-bin");
    const firstCommand = join(firstBin, "agentuse");
    const secondCommand = join(secondBin, "agentuse");
    for (const command of [firstCommand, secondCommand]) {
      mkdirSync(join(command, ".."), { recursive: true });
      writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
      chmodSync(command, 0o755);
    }

    expect(inspectCliAvailability(link, launcher, `${firstBin}:${secondBin}`).commands).toEqual([
      firstCommand,
      secondCommand,
    ]);
  });
});
