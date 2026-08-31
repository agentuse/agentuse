import { describe, expect, it } from "bun:test";
import { shouldHideDashboardWindow, type DashboardWindowState } from "./dashboard-presentation";

function windowState(visible: boolean, focused: boolean): DashboardWindowState {
  return {
    isVisible: () => visible,
    isFocused: () => focused,
  };
}

describe("dashboard presentation", () => {
  it("hides a visible, focused window", () => {
    expect(shouldHideDashboardWindow(windowState(true, true))).toBe(true);
  });

  it("summons a visible window that is behind another app", () => {
    expect(shouldHideDashboardWindow(windowState(true, false))).toBe(false);
  });

  it("summons a hidden or missing window", () => {
    expect(shouldHideDashboardWindow(windowState(false, false))).toBe(false);
    expect(shouldHideDashboardWindow(undefined)).toBe(false);
  });
});
