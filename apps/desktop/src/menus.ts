import type { MenuItemConstructorOptions } from "electron";

export interface NavigationCommands {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

export interface FindCommands {
  open(): void;
}

export interface SidebarCommands {
  toggle(): void;
}

export interface TrayMenuCommands {
  showDashboard(): void;
  showSettings(): void;
  quit(): void;
}

export function createTrayMenu(commands: TrayMenuCommands): MenuItemConstructorOptions[] {
  return [
    { label: "Show Dashboard", click: commands.showDashboard },
    { type: "separator" },
    { label: "Settings…", accelerator: "Command+,", click: commands.showSettings },
    { type: "separator" },
    { label: "Quit AgentUse", accelerator: "Command+Q", click: commands.quit },
  ];
}

export function createEditMenu(find: FindCommands): MenuItemConstructorOptions {
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
      {
        label: "Find",
        submenu: [
          { label: "Find…", accelerator: "Command+F", click: find.open },
        ],
      },
    ],
  };
}

export function createViewMenu(sidebar: SidebarCommands): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      { label: "Toggle Sidebar", accelerator: "Command+B", click: sidebar.toggle },
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
