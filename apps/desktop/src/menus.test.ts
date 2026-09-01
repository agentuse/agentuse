import { describe, expect, it, mock } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { createEditMenu, createNavigationMenu, createTrayMenu, createViewMenu } from "./menus";

describe("desktop application menus", () => {
  it("keeps the menu-bar menu focused on dashboard, settings, and quit", () => {
    const showDashboard = mock(() => undefined);
    const showSettings = mock(() => undefined);
    const quit = mock(() => undefined);
    const items = createTrayMenu({ showDashboard, showSettings, quit });

    expect(items.map((item) => item.label).filter(Boolean)).toEqual([
      "Show Dashboard",
      "Settings…",
      "Quit AgentUse",
    ]);
    items[0]?.click?.({} as never, undefined as never, {} as never);
    items[2]?.click?.({} as never, undefined as never, {} as never);
    items[4]?.click?.({} as never, undefined as never, {} as never);
    expect(showDashboard).toHaveBeenCalledTimes(1);
    expect(showSettings).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

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

  it("provides the standard sidebar shortcut in the View menu", () => {
    const toggle = mock(() => undefined);
    const menu = createViewMenu({ toggle });
    const [item] = menu.submenu as MenuItemConstructorOptions[];

    expect(item?.label).toBe("Toggle Sidebar");
    expect(item?.accelerator).toBe("Command+B");
    item?.click?.({} as never, undefined as never, {} as never);
    expect(toggle).toHaveBeenCalledTimes(1);
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
