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

function createUpdater(fake = new FakeAutoUpdater(), packaged = true, beforeInstall?: () => void) {
  return {
    fake,
    updater: new DesktopUpdater(fake as DesktopAutoUpdater, {
      isPackaged: packaged,
      platform: "darwin",
      currentVersion: "0.19.1",
      beforeInstall,
    }),
  };
}

describe("desktop updater", () => {
  it("checks without downloading or enabling install-on-quit", async () => {
    const { fake, updater } = createUpdater();

    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    await updater.checkForUpdates();

    expect(fake.checks).toBe(1);
    expect(fake.downloads).toBe(0);
    expect(fake.installs).toEqual([]);
    expect(updater.state.status).toBe("checking");
  });

  it("requires separate download and restart/install actions", async () => {
    const actions: string[] = [];
    const fake = new FakeAutoUpdater();
    fake.quitAndInstall = (isSilent?: boolean, isForceRunAfter?: boolean) => {
      actions.push("install");
      fake.installs.push([isSilent, isForceRunAfter]);
    };
    const { updater } = createUpdater(fake, true, () => actions.push("authorize-quit"));

    fake.emit("update-available", { version: "0.19.2" });
    expect(updater.state).toMatchObject({
      status: "available",
      availableVersion: "0.19.2",
      actionLabel: "Download Update",
    });
    expect(fake.downloads).toBe(0);

    await updater.downloadUpdate();
    expect(fake.downloads).toBe(1);
    expect(updater.state.status).toBe("downloading");
    expect(fake.installs).toEqual([]);

    fake.emit("download-progress", { percent: 51.7 });
    expect(updater.state.progress).toBe(52);
    fake.emit("update-downloaded", { version: "0.19.2" });
    expect(updater.state.actionLabel).toBe("Restart and Install");
    expect(fake.installs).toEqual([]);

    updater.installUpdate();
    expect(fake.installs).toEqual([[false, true]]);
    expect(actions).toEqual(["authorize-quit", "install"]);
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

  it("does not contact the updater from an unpackaged app", async () => {
    const { fake, updater } = createUpdater(new FakeAutoUpdater(), false);

    await updater.checkForUpdates();
    await updater.downloadUpdate();
    updater.installUpdate();

    expect(updater.state.status).toBe("unavailable");
    expect(fake.checks).toBe(0);
    expect(fake.downloads).toBe(0);
    expect(fake.installs).toEqual([]);
  });
});
