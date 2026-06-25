import { describe, it, expect } from "bun:test";
import { toErrorMessage } from "../src/utils/error-message";

// Regression guard: a provider/runtime can reject with a value that is NOT an
// Error instance (a plain object, an API error envelope, null). The old code did
// `String(error)`, which collapses an object to the useless "[object Object]" and
// then persists that as the session error + bubbles it to the parent manager
// (which then misdiagnosed it as an unrelated failure). toErrorMessage must
// recover a real message instead.
describe("toErrorMessage", () => {
  it("never returns '[object Object]' for a plain object", () => {
    expect(toErrorMessage({ foo: "bar" })).not.toBe("[object Object]");
  });

  it("extracts a string `message` field from an object", () => {
    expect(toErrorMessage({ message: "rate_limit_error" })).toBe("rate_limit_error");
  });

  it("extracts a string `error` field when there is no message", () => {
    expect(toErrorMessage({ error: "overloaded" })).toBe("overloaded");
  });

  it("falls back to a JSON dump for a message-less object", () => {
    const out = toErrorMessage({ status: 529, type: "overloaded_error" });
    expect(out).toContain("529");
    expect(out).toContain("overloaded_error");
    expect(out).not.toBe("[object Object]");
  });

  it("uses Error.message for real Errors", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back to Error.name when the message is empty", () => {
    expect(toErrorMessage(new TypeError(""))).toBe("TypeError");
  });

  it("passes strings through unchanged", () => {
    expect(toErrorMessage("plain failure")).toBe("plain failure");
  });

  it("handles null/undefined without throwing", () => {
    expect(toErrorMessage(null)).toBe("Unknown error");
    expect(toErrorMessage(undefined)).toBe("Unknown error");
  });
});
