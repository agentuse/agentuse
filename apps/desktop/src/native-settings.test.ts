import { describe, expect, it } from "bun:test";
import { encodeNativeSettingsMessage, isNativeSettingsPipeClosure, parseNativeSettingsCommand } from "./native-settings";

describe("native settings protocol", () => {
  it("accepts the supported commands", () => {
    expect(parseNativeSettingsCommand('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseNativeSettingsCommand('{"type":"refresh"}')).toEqual({ type: "refresh" });
    expect(parseNativeSettingsCommand('{"type":"toggleServer"}')).toEqual({ type: "toggleServer" });
    expect(parseNativeSettingsCommand('{"type":"toggleCliLink"}')).toEqual({ type: "toggleCliLink" });
    expect(parseNativeSettingsCommand('{"type":"setLaunchAtLogin","enabled":true}')).toEqual({
      type: "setLaunchAtLogin",
      enabled: true,
    });
    expect(parseNativeSettingsCommand('{"type":"setNotificationPreference","category":"approvals","enabled":false}')).toEqual({
      type: "setNotificationPreference",
      category: "approvals",
      enabled: false,
    });
    expect(parseNativeSettingsCommand('{"type":"setDashboardShortcut","shortcut":"Hyper+A"}')).toEqual({
      type: "setDashboardShortcut",
      shortcut: "Hyper+A",
    });
    expect(parseNativeSettingsCommand('{"type":"clearDashboardShortcut"}')).toEqual({ type: "clearDashboardShortcut" });
  });

  it("rejects malformed and unknown commands", () => {
    expect(parseNativeSettingsCommand("not json")).toBeUndefined();
    expect(parseNativeSettingsCommand('{"type":"setLaunchAtLogin","enabled":"yes"}')).toBeUndefined();
    expect(parseNativeSettingsCommand('{"type":"setNotificationPreference","category":"email","enabled":true}')).toBeUndefined();
    expect(parseNativeSettingsCommand('{"type":"setNotificationPreference","category":"sessions","enabled":"yes"}')).toBeUndefined();
    expect(parseNativeSettingsCommand('{"type":"setDashboardShortcut","shortcut":42}')).toBeUndefined();
    expect(parseNativeSettingsCommand('{"type":"setDashboardShortcut","shortcut":null}')).toBeUndefined();
    expect(parseNativeSettingsCommand('{"type":"deleteEverything"}')).toBeUndefined();
  });

  it("encodes one newline-delimited message", () => {
    expect(encodeNativeSettingsMessage({ type: "show" })).toBe('{"type":"show"}\n');
  });

  it("recognizes stream closure errors without hiding unrelated failures", () => {
    expect(isNativeSettingsPipeClosure(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBe(true);
    expect(isNativeSettingsPipeClosure(Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" }))).toBe(true);
    expect(isNativeSettingsPipeClosure(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe(false);
    expect(isNativeSettingsPipeClosure(new Error("missing code"))).toBe(false);
  });
});
