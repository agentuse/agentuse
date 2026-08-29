import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { encodeNativeSettingsMessage, isNativeSettingsPipeClosure, parseNativeSettingsCommand } from "./native-settings";

const desktopRoot = join(import.meta.dir, "..");

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
    expect(parseNativeSettingsCommand('{"type":"checkForUpdates"}')).toEqual({ type: "checkForUpdates" });
    expect(parseNativeSettingsCommand('{"type":"downloadUpdate"}')).toEqual({ type: "downloadUpdate" });
    expect(parseNativeSettingsCommand('{"type":"installUpdate"}')).toEqual({ type: "installUpdate" });
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

describe("native settings packaged metadata", () => {
  it("stamps the helper bundle version from the desktop package metadata", async () => {
    const script = await Bun.file(join(desktopRoot, "scripts", "build-native-settings.sh")).text();
    expect(script).toContain("require('$desktop_dir/package.json').version");
    expect(script).toContain("Set :CFBundleShortVersionString $settings_version");
    expect(script).toContain("Contents/Resources");
    expect(script).toContain("CFBundleIconFile");
  });

  it("renders updater state and explicit actions in the About tab", async () => {
    const source = await Bun.file(join(desktopRoot, "native-settings", "AgentUseSettings.swift")).text();
    expect(source).toContain('Label("About", systemImage: "info.circle")');
    expect(source).toContain("NSApplication.shared.applicationIconImage");
    expect(source).toContain('object(forInfoDictionaryKey: "CFBundleShortVersionString")');
    expect(source).toContain('Text("Version \\(model.state.updateCurrentVersion)")');
    expect(source).not.toContain('Text("Build")');
    expect(source).not.toContain('object(forInfoDictionaryKey: "CFBundleVersion")');
    expect(source).toContain('case "available": command = "downloadUpdate"');
    expect(source).toContain('case "ready": command = "installUpdate"');
    expect(source).toContain('default: command = "checkForUpdates"');
    expect(source).toContain('case "upToDate": "You’re up to date"');
    expect(source).toContain('Button("Check Again")');
    expect(source).not.toContain('.buttonStyle(.link)');
    expect(source).toContain('HStack(alignment: .top, spacing: 20)');
    expect(source).toContain('.frame(maxWidth: 440, alignment: .leading)');
    expect(source).toContain('ProgressView(value: Double(model.state.updateProgress ?? 0), total: 100)');
    expect(source).toContain('DisclosureGroup("Show Details"');
  });
});

describe("desktop updater packaging", () => {
  it("targets public GitHub Releases and always emits Mac ZIP metadata alongside the DMG", async () => {
    const manifest = await Bun.file(join(desktopRoot, "package.json")).json();
    expect(manifest.dependencies["electron-updater"]).toBeString();
    expect(manifest.scripts["dist:mac"]).toContain("--publish never");
    expect(manifest.build.mac.target).toEqual(["dmg", "zip"]);
    expect(manifest.build.publish).toEqual([{
      provider: "github",
      owner: "agentuse",
      repo: "agentuse",
      releaseType: "release",
    }]);
  });

  it("supervises the packaged server through a dedicated lifetime pipe", async () => {
    const source = await Bun.file(join(desktopRoot, "src", "main.ts")).text();
    expect(source).toContain('stdio: ["ignore", "ignore", "ignore", "pipe"]');
    expect(source).toContain("[DESKTOP_LIFETIME_FD_ENV]");
    expect(source).toContain("[DESKTOP_SUPERVISOR_ENV]");
    expect(source).not.toContain("ownedServer.unref()");
  });
});
