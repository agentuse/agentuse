import { describe, expect, it } from "bun:test";
import { createDesktopQuitPolicy } from "./quit-policy";

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
});
