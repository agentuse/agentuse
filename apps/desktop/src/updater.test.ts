import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { DesktopUpdater, type DesktopAutoUpdater } from "./updater";

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  checkError?: Error;

  async checkForUpdates(): Promise<void> {
    this.checks += 1;
    if (this.checkError) throw this.checkError;
  }

  async downloadUpdate(): Promise<void> {
    this.downloads += 1;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function createUpdater(
  fake = new FakeAutoUpdater(),
  packaged = true,
  beforeInstall?: () => void | Promise<void>,
  onUpdateReady?: (version: string) => void | Promise<void>,
) {
  return {
    fake,
    updater: new DesktopUpdater(fake as DesktopAutoUpdater, {
      isPackaged: packaged,
      platform: "darwin",
      currentVersion: "0.19.1",
      beforeInstall,
      onUpdateReady,
    }),
  };
}

describe("desktop updater", () => {
  it("checks with background download but without install-on-quit", async () => {
    const { fake, updater } = createUpdater();

    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    await updater.checkForUpdates();

    expect(fake.checks).toBe(1);
    expect(fake.downloads).toBe(0);
    expect(fake.installs).toEqual([]);
    expect(updater.state.status).toBe("checking");
  });

  it("downloads automatically and requires an explicit restart/install action", async () => {
    const actions: string[] = [];
    const fake = new FakeAutoUpdater();
    fake.quitAndInstall = (isSilent?: boolean, isForceRunAfter?: boolean) => {
      actions.push("install");
      fake.installs.push([isSilent, isForceRunAfter]);
    };
    const { updater } = createUpdater(
      fake,
      true,
      async () => {
        actions.push("drain-server");
        await Promise.resolve();
        actions.push("authorize-native-quit");
      },
      (version) => { actions.push(`prompt-${version}`); },
    );

    fake.emit("update-available", { version: "0.19.2" });
    expect(updater.state).toMatchObject({
      status: "downloading",
      availableVersion: "0.19.2",
      actionLabel: "Download Update",
      actionDisabled: true,
    });
    expect(fake.downloads).toBe(0);
    expect(fake.installs).toEqual([]);

    fake.emit("download-progress", { percent: 51.7 });
    expect(updater.state.progress).toBe(52);
    fake.emit("update-downloaded", { version: "0.19.2" });
    await Promise.resolve();
    expect(updater.state.actionLabel).toBe("Restart and Install");
    expect(fake.installs).toEqual([]);
    expect(actions).toEqual(["prompt-0.19.2"]);

    const install = updater.installUpdate();
    expect(updater.state).toMatchObject({
      status: "ready",
      detail: "Preparing to restart…",
      actionDisabled: true,
    });
    expect(fake.installs).toEqual([]);

    await install;
    expect(fake.installs).toEqual([[undefined, undefined]]);
    expect(actions).toEqual(["prompt-0.19.2", "drain-server", "authorize-native-quit", "install"]);
  });

  it("contains offline errors and allows a later retry", async () => {
    const { fake, updater } = createUpdater();
    fake.checkError = new Error("network unavailable");

    await expect(updater.checkForUpdates()).resolves.toBeUndefined();
    expect(updater.state).toMatchObject({
      status: "error",
      actionDisabled: false,
    });
    expect(updater.state.detail).toContain("network unavailable");

    fake.checkError = undefined;
    await updater.checkForUpdates();
    expect(fake.checks).toBe(2);
    expect(updater.state.status).toBe("checking");
  });

  it("keeps a downloaded update ready when the native prompt fails", async () => {
    const { fake, updater } = createUpdater(
      new FakeAutoUpdater(),
      true,
      undefined,
      async () => { throw new Error("dialog unavailable"); },
    );

    fake.emit("update-downloaded", { version: "0.19.2" });
    await Promise.resolve();
    await Promise.resolve();

    expect(updater.state).toMatchObject({
      status: "ready",
      availableVersion: "0.19.2",
      actionLabel: "Restart and Install",
    });
  });

  it("does not contact the updater from an unpackaged app", async () => {
    const { fake, updater } = createUpdater(new FakeAutoUpdater(), false);

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.installUpdate();

    expect(updater.state.status).toBe("unavailable");
    expect(fake.checks).toBe(0);
    expect(fake.downloads).toBe(0);
    expect(fake.installs).toEqual([]);
  });
});
