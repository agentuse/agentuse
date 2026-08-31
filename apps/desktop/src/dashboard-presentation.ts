export interface DashboardWindowState {
  isVisible(): boolean;
  isFocused(): boolean;
}

export function shouldHideDashboardWindow(window: DashboardWindowState | undefined): boolean {
  return Boolean(window?.isVisible() && window.isFocused());
}
