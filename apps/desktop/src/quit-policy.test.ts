import { describe, expect, it } from "bun:test";
import { createDesktopQuitPolicy, deferDesktopQuitAfterDrain, shouldWarnBeforeFullQuit } from "./quit-policy";

describe("desktop quit policy", () => {
  it("keeps Dock and application-menu quit requests in the background", () => {
    const policy = createDesktopQuitPolicy();
    expect(policy.shouldTerminate()).toBe(false);
  });

  it("terminates only after the menu-bar Quit command opts in", () => {
    const policy = createDesktopQuitPolicy();
    policy.requestFullQuit();
    expect(policy.shouldTerminate()).toBe(true);
  });

  it("identifies a native updater quit so Electron must not prevent it", () => {
    const policy = createDesktopQuitPolicy();
    policy.requestNativeUpdaterQuit();
    expect(policy.shouldTerminate()).toBe(true);
    expect(policy.isNativeUpdaterQuit()).toBe(true);
  });

  it("warns only while a server owned by the app is still running", () => {
    expect(shouldWarnBeforeFullQuit(undefined)).toBe(false);
    expect(shouldWarnBeforeFullQuit({ exitCode: 0, killed: false })).toBe(false);
    expect(shouldWarnBeforeFullQuit({ exitCode: null, killed: true })).toBe(false);
    expect(shouldWarnBeforeFullQuit({ exitCode: null, killed: false })).toBe(true);
  });

  it("defers the final quit until the prevented before-quit event can unwind", async () => {
    const actions: string[] = [];
    let deferredQuit: (() => void) | undefined;

    await deferDesktopQuitAfterDrain(
      async () => { actions.push("drain"); },
      () => { actions.push("quit"); },
      (callback) => {
        actions.push("defer");
        deferredQuit = callback;
      },
    );

    expect(actions).toEqual(["drain", "defer"]);
    deferredQuit?.();
    expect(actions).toEqual(["drain", "defer", "quit"]);
  });
});
