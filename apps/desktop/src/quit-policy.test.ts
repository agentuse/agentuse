import { describe, expect, it } from "bun:test";
import { createDesktopQuitPolicy, shouldWarnBeforeFullQuit } from "./quit-policy";

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

  it("warns only while a server owned by the app is still running", () => {
    expect(shouldWarnBeforeFullQuit(undefined)).toBe(false);
    expect(shouldWarnBeforeFullQuit({ exitCode: 0, killed: false })).toBe(false);
    expect(shouldWarnBeforeFullQuit({ exitCode: null, killed: true })).toBe(false);
    expect(shouldWarnBeforeFullQuit({ exitCode: null, killed: false })).toBe(true);
  });
});
