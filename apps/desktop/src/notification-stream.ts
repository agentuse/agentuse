import { sameServerEndpoint, type ServerEndpoint } from "./runtime";

export interface NativeNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  appBadge?: number;
}

export interface NativeNotificationEvent {
  category: "approvals" | "sessions";
  payload: NativeNotificationPayload;
}

export function parseNotificationFrames(buffer: string): {
  events: NativeNotificationEvent[];
  remainder: string;
} {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  const events: NativeNotificationEvent[] = [];

  for (const frame of frames) {
    const lines = frame.split("\n");
    if (!lines.some((line) => line === "event: notification")) continue;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const event = JSON.parse(data) as NativeNotificationEvent;
      if (
        (event.category === "approvals" || event.category === "sessions")
        && typeof event.payload?.title === "string"
        && typeof event.payload.body === "string"
        && typeof event.payload.url === "string"
      ) {
        events.push(event);
      }
    } catch {
      // A malformed event must not break the long-lived stream.
    }
  }

  return { events, remainder };
}

/**
 * Where a clicked notification opens. Its path is rebased onto the current
 * dashboard origin. When the notification came from a daemon Desktop no longer
 * uses, its session lives on that other backend, so open the dashboard home
 * instead of a page that would not exist here.
 */
export function notificationTargetUrl(
  url: string,
  dashboardUrl: string,
  source?: ServerEndpoint,
  current?: ServerEndpoint,
): string | undefined {
  if (source && !(current && sameServerEndpoint(source, current))) return dashboardUrl;
  try {
    const remote = new URL(url);
    return new URL(`${remote.pathname}${remote.search}${remote.hash}`, dashboardUrl).toString();
  } catch {
    return undefined;
  }
}
