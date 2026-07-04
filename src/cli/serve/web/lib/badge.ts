/**
 * Keeps the installed app's icon badge in sync with the pending-approvals
 * count. Pushes set the badge out-of-band (declarative app_badge / service
 * worker); this corrects it whenever the app itself learns the real count,
 * so handled approvals clear the badge on the next look at the app.
 */

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function syncAppBadge(pendingCount: number): void {
  const nav = navigator as BadgeNavigator;
  if (!nav.setAppBadge) return;
  const action = pendingCount > 0
    ? nav.setAppBadge(pendingCount)
    : (nav.clearAppBadge?.() ?? nav.setAppBadge(0));
  void action.catch(() => {});
}
