import { describe, expect, it, mock } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { createEditMenu, createNavigationMenu } from "./menus";

describe("desktop application menus", () => {
  it("uses native editing roles in standard macOS order", () => {
    const menu = createEditMenu({ open: () => {} });
    const items = menu.submenu as Array<{ role?: string }>;
    expect(items.map((item) => item.role).filter(Boolean)).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]);
  });

  it("provides standard macOS find commands", () => {
    const open = mock(() => undefined);
    const menu = createEditMenu({ open });
    const find = (menu.submenu as MenuItemConstructorOptions[]).find((item) => item.label === "Find");
    const items = find?.submenu as MenuItemConstructorOptions[];

    expect(items.map((item) => item.accelerator)).toEqual(["Command+F"]);
    items[0]?.click?.({} as never, undefined as never, {} as never);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reflects navigation availability and delegates navigation", () => {
    const goBack = mock(() => undefined);
    const goForward = mock(() => undefined);
    const menu = createNavigationMenu({
      canGoBack: () => true,
      canGoForward: () => false,
      goBack,
      goForward,
    });
    const [back, forward] = menu.submenu as Array<{
      accelerator?: string;
      enabled?: boolean;
      click?: () => void;
    }>;

    expect(back.accelerator).toBe("Command+[");
    expect(back.enabled).toBe(true);
    expect(forward.accelerator).toBe("Command+]");
    expect(forward.enabled).toBe(false);
    back.click?.();
    forward.click?.();
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(goForward).toHaveBeenCalledTimes(1);
  });
});
