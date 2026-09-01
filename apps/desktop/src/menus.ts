import type { MenuItemConstructorOptions } from "electron";

export interface NavigationCommands {
  open(path: string): void;
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
      { label: "Home", accelerator: "Command+1", click: () => commands.open("/") },
      { label: "Agents", accelerator: "Command+2", click: () => commands.open("/agents") },
      { label: "Sessions", accelerator: "Command+3", click: () => commands.open("/sessions") },
      { label: "Schedules", accelerator: "Command+4", click: () => commands.open("/schedules") },
      { label: "Stores", accelerator: "Command+5", click: () => commands.open("/stores") },
      { label: "Approvals", accelerator: "Command+6", click: () => commands.open("/approvals") },
      { type: "separator" },
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
