import { describe, expect, test } from "bun:test";
import { parseNotificationFrames } from "./notification-stream";

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
