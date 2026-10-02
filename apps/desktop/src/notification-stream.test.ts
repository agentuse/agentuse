import { describe, expect, test } from "bun:test";
import { notificationTargetUrl, parseNotificationFrames } from "./notification-stream";

describe("native notification stream", () => {
  test("parses notification events and ignores heartbeats", () => {
    const parsed = parseNotificationFrames(
      ': hb\n\nevent: notification\ndata: {"category":"approvals","payload":{"title":"Approval needed","body":"Deploy","url":"http://127.0.0.1/sessions/s1"}}\n\n',
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.payload.title).toBe("Approval needed");
    expect(parsed.remainder).toBe("");
  });

  test("retains a fragmented event for the next chunk", () => {
    const first = parseNotificationFrames('event: notification\ndata: {"category":"sessions"');
    expect(first.events).toHaveLength(0);
    const second = parseNotificationFrames(`${first.remainder},"payload":{"title":"Session completed","body":"Agent","url":"http://127.0.0.1/sessions/s2"}}\n\n`);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.category).toBe("sessions");
  });

  test("drops malformed or unexpected events without closing the stream", () => {
    const parsed = parseNotificationFrames(
      'event: notification\ndata: nope\n\nevent: approvals\ndata: {}\n\nevent: notification\ndata: {"category":"other","payload":{}}\n\n',
    );
    expect(parsed.events).toEqual([]);
  });
});

describe("notification click target", () => {
  const daemon = { port: 12233, projectRoot: "project-a" };

  test("rebases the run's path onto the current dashboard", () => {
    expect(notificationTargetUrl("http://127.0.0.1:12233/sessions/s1?project=a", "http://127.0.0.1:12233", daemon, daemon))
      .toBe("http://127.0.0.1:12233/sessions/s1?project=a");
    expect(notificationTargetUrl("http://100.64.0.1:12233/sessions/s1", "http://127.0.0.1:12233"))
      .toBe("http://127.0.0.1:12233/sessions/s1");
  });

  test("opens the dashboard home when Desktop has switched to another daemon", () => {
    const other = { port: 12234, projectRoot: "project-b" };
    expect(notificationTargetUrl("http://127.0.0.1:12233/sessions/s1", "http://127.0.0.1:12234", daemon, other))
      .toBe("http://127.0.0.1:12234");
    expect(notificationTargetUrl("http://127.0.0.1:12233/sessions/s1", "http://127.0.0.1:12233", daemon, { ...daemon, projectRoot: "project-b" }))
      .toBe("http://127.0.0.1:12233");
    expect(notificationTargetUrl("http://127.0.0.1:12233/sessions/s1", "http://127.0.0.1:12233", daemon, undefined))
      .toBe("http://127.0.0.1:12233");
  });
});
