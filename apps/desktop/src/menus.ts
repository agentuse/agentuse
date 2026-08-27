import type { MenuItemConstructorOptions } from "electron";

export interface NavigationCommands {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

export function createEditMenu(): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  };
}

export function createNavigationMenu(commands: NavigationCommands): MenuItemConstructorOptions {
  return {
    label: "Go",
    submenu: [
      {
        label: "Back",
        accelerator: "Command+[",
        enabled: commands.canGoBack(),
        click: commands.goBack,
      },
      {
        label: "Forward",
        accelerator: "Command+]",
        enabled: commands.canGoForward(),
        click: commands.goForward,
      },
    ],
  };
}
