import AppKit
import SwiftUI

private struct SettingsState: Codable, Equatable {
    enum Status: String, Codable {
        case running
        case stopped
        case starting
        case stopping
    }

    var status: Status
    var title: String
    var detail: String
    var actionLabel: String
    var actionDisabled: Bool
    var launchAtLogin: Bool
    var notificationApprovals: Bool
    var notificationSessions: Bool
    var dashboardShortcut: String?
    var dashboardShortcutError: String?
    var cliStatus: String
    var cliTitle: String
    var cliDetail: String
    var cliActionLabel: String
    var cliActionDisabled: Bool
    var cliCommands: [String]
    var logText: String
    var logFile: String?
    var updateStatus: String
    var updateCurrentVersion: String
    var updateAvailableVersion: String?
    var updateProgress: Int?
    var updateDetail: String
    var updateActionLabel: String
    var updateActionDisabled: Bool

    static let loading = SettingsState(
        status: .starting,
        title: "Checking server…",
        detail: "Looking for a local AgentUse server.",
        actionLabel: "Start Server",
        actionDisabled: true,
        launchAtLogin: false,
        notificationApprovals: true,
        notificationSessions: true,
        dashboardShortcut: nil,
        dashboardShortcutError: nil,
        cliStatus: "unavailable",
        cliTitle: "Add CLI launcher",
        cliDetail: "Creates an agentuse command for Terminal at ~/.local/bin/agentuse.",
        cliActionLabel: "Add",
        cliActionDisabled: true,
        cliCommands: [],
        logText: "",
        logFile: nil,
        updateStatus: "unavailable",
        updateCurrentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown",
        updateAvailableVersion: nil,
        updateProgress: nil,
        updateDetail: "Update checks are not ready yet.",
        updateActionLabel: "Check for Updates",
        updateActionDisabled: true
    )
}

private struct HostMessage: Decodable {
    var type: String
    var state: SettingsState?
    var message: String?
}

private struct HelperCommand: Encodable {
    var type: String
    var enabled: Bool?
    var category: String?
    var shortcut: String?

    init(type: String, enabled: Bool? = nil, category: String? = nil, shortcut: String? = nil) {
        self.type = type
        self.enabled = enabled
        self.category = category
        self.shortcut = shortcut
    }
}

private final class HostConnection: @unchecked Sendable {
    static let shared = HostConnection()

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let writeQueue = DispatchQueue(label: "ai.agentuse.settings.write")
    weak var model: SettingsModel?

    func start() {
        send(HelperCommand(type: "ready"))
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                self?.receive(line)
            }
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }

    func send(_ command: HelperCommand) {
        writeQueue.async { [encoder] in
            guard let payload = try? encoder.encode(command) else { return }
            FileHandle.standardOutput.write(payload)
            FileHandle.standardOutput.write(Data([0x0A]))
        }
    }

    private func receive(_ line: String) {
        guard let data = line.data(using: .utf8),
              let message = try? decoder.decode(HostMessage.self, from: data) else { return }
        DispatchQueue.main.async { [weak self] in
            switch message.type {
            case "state":
                if let state = message.state { self?.model?.apply(state) }
            case "error":
                if let message = message.message { self?.model?.showError(message) }
            case "show":
                NSApplication.shared.activate(ignoringOtherApps: true)
                NSApplication.shared.windows.first?.makeKeyAndOrderFront(nil)
            case "hide":
                NSApplication.shared.hide(nil)
            case "quit":
                NSApplication.shared.terminate(nil)
            default:
                break
            }
        }
    }
}

@MainActor
private final class SettingsModel: ObservableObject {
    @Published private(set) var state = SettingsState.loading
    @Published private(set) var actionInFlight = false
    @Published var errorMessage: String?

    init() {
        HostConnection.shared.model = self
    }

    func apply(_ state: SettingsState) {
        self.state = state
        actionInFlight = false
    }

    func showError(_ message: String) {
        errorMessage = message
    }

    func toggleServer() {
        guard !state.actionDisabled, !actionInFlight else { return }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(type: "toggleServer"))
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        guard !actionInFlight else { return }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(type: "setLaunchAtLogin", enabled: enabled))
    }

    func setNotificationPreference(_ category: String, enabled: Bool) {
        guard !actionInFlight else { return }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(
            type: "setNotificationPreference",
            enabled: enabled,
            category: category
        ))
    }

    func setDashboardShortcut(_ shortcut: String) {
        guard !actionInFlight else { return }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(type: "setDashboardShortcut", shortcut: shortcut))
    }

    func clearDashboardShortcut() {
        guard !actionInFlight else { return }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(type: "clearDashboardShortcut"))
    }

    func toggleCliLink() {
        guard !state.cliActionDisabled, !actionInFlight else { return }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(type: "toggleCliLink"))
    }

    func performUpdateAction() {
        guard !state.updateActionDisabled, !actionInFlight else { return }
        let command: String
        switch state.updateStatus {
        case "available": command = "downloadUpdate"
        case "ready": command = "installUpdate"
        default: command = "checkForUpdates"
        }
        actionInFlight = true
        HostConnection.shared.send(HelperCommand(type: command))
    }

    func refresh() {
        guard !actionInFlight else { return }
        HostConnection.shared.send(HelperCommand(type: "refresh"))
    }
}

private struct StatusDot: View {
    let status: SettingsState.Status

    private var color: Color {
        switch status {
        case .running: .green
        case .stopped: .red
        case .starting, .stopping: .orange
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .accessibilityHidden(true)
    }
}

private func shortcutKey(from event: NSEvent) -> String? {
    let namedKeys: [UInt16: String] = [
        36: "Return", 48: "Tab", 49: "Space",
        123: "Left", 124: "Right", 125: "Down", 126: "Up",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5",
        97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
        103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15",
        106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20"
    ]
    if let named = namedKeys[event.keyCode] { return named }
    guard let characters = event.charactersIgnoringModifiers?.uppercased(),
          characters.count == 1,
          let scalar = characters.unicodeScalars.first,
          scalar.isASCII,
          (CharacterSet.alphanumerics.contains(scalar)) else { return nil }
    return characters
}

private func encodedShortcut(from event: NSEvent) -> String? {
    let allowed: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
    let flags = event.modifierFlags.intersection(allowed)
    guard !flags.isEmpty, let key = shortcutKey(from: event) else { return nil }
    if flags == allowed { return "Hyper+\(key)" }
    var parts: [String] = []
    if flags.contains(.command) { parts.append("Command") }
    if flags.contains(.control) { parts.append("Control") }
    if flags.contains(.option) { parts.append("Option") }
    if flags.contains(.shift) { parts.append("Shift") }
    parts.append(key)
    return parts.joined(separator: "+")
}

private func displayedShortcut(_ shortcut: String?) -> String {
    guard let shortcut else { return "Record Shortcut…" }
    let parts = shortcut.split(separator: "+").map(String.init)
    guard let key = parts.last else { return "Record Shortcut…" }
    if parts.first == "Hyper" { return "✦ \(key)" }
    let symbols = parts.dropLast().compactMap { modifier -> String? in
        switch modifier {
        case "Command": "⌘"
        case "Control": "⌃"
        case "Option": "⌥"
        case "Shift": "⇧"
        default: nil
        }
    }.joined()
    return "\(symbols) \(key)"
}

private final class ShortcutRecorderButton: NSButton {
    var shortcut: String? {
        didSet { if !isRecording { refreshTitle() } }
    }
    var onShortcut: ((String) -> Void)?
    private var isRecording = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        bezelStyle = .rounded
        setButtonType(.momentaryPushIn)
        target = self
        action = #selector(beginRecording)
        refreshTitle()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    override var acceptsFirstResponder: Bool { true }

    @objc private func beginRecording() {
        isRecording = true
        title = "Press shortcut…"
        window?.makeFirstResponder(self)
    }

    override func keyDown(with event: NSEvent) {
        guard isRecording else {
            super.keyDown(with: event)
            return
        }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if event.keyCode == 53 && flags.isEmpty {
            finishRecording()
            return
        }
        guard let shortcut = encodedShortcut(from: event) else {
            NSSound.beep()
            return
        }
        self.shortcut = shortcut
        finishRecording()
        onShortcut?(shortcut)
    }

    override func resignFirstResponder() -> Bool {
        finishRecording()
        return super.resignFirstResponder()
    }

    private func finishRecording() {
        isRecording = false
        refreshTitle()
    }

    private func refreshTitle() {
        title = displayedShortcut(shortcut)
    }
}

private struct ShortcutRecorder: NSViewRepresentable {
    var shortcut: String?
    var enabled: Bool
    var onShortcut: (String) -> Void

    func makeNSView(context: Context) -> ShortcutRecorderButton {
        let button = ShortcutRecorderButton(frame: .zero)
        button.shortcut = shortcut
        button.onShortcut = onShortcut
        return button
    }

    func updateNSView(_ button: ShortcutRecorderButton, context: Context) {
        button.shortcut = shortcut
        button.onShortcut = onShortcut
        button.isEnabled = enabled
    }
}

private struct GeneralSettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            Section("Local AgentUse") {
                HStack(spacing: 10) {
                    StatusDot(status: model.state.status)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.state.title)
                        Text(model.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 16)
                    Button(model.state.actionLabel) {
                        model.toggleServer()
                    }
                    .disabled(model.state.actionDisabled || model.actionInFlight)
                }

                Toggle(
                    "Launch AgentUse at Login",
                    isOn: Binding(
                        get: { model.state.launchAtLogin },
                        set: { model.setLaunchAtLogin($0) }
                    )
                )
                .disabled(model.actionInFlight)

                Divider()

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Show or hide Dashboard")
                            Text("Works from any app. Hyper (⌃⌥⌘⇧) appears as ✦.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 16)
                        ShortcutRecorder(
                            shortcut: model.state.dashboardShortcut,
                            enabled: !model.actionInFlight,
                            onShortcut: model.setDashboardShortcut
                        )
                        .frame(minWidth: 96)
                        Button("Clear") {
                            model.clearDashboardShortcut()
                        }
                        .disabled(model.state.dashboardShortcut == nil || model.actionInFlight)
                    }
                    if let error = model.state.dashboardShortcutError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }

            Section("Command Line") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        Image(systemName: "terminal")
                            .foregroundStyle(.secondary)
                            .frame(width: 16)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.state.cliTitle)
                            Text(model.state.cliDetail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 16)
                        Button(model.state.cliActionLabel) {
                            model.toggleCliLink()
                        }
                        .disabled(model.state.cliActionDisabled || model.actionInFlight)
                    }

                    Divider()
                        .padding(.leading, 26)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Commands on PATH")
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundStyle(.secondary)

                        if model.state.cliCommands.isEmpty {
                            Text("No agentuse command was found on your PATH.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(model.state.cliCommands.enumerated()), id: \.offset) { index, path in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("\(index + 1).")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                        .frame(width: 18, alignment: .trailing)
                                    Text(path)
                                        .font(.system(size: 11, design: .monospaced))
                                        .textSelection(.enabled)
                                    Spacer(minLength: 8)
                                    if index == 0 {
                                        Text("Runs first")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.leading, 26)
                }
            }

            Section("Notifications") {
                VStack(alignment: .leading, spacing: 2) {
                    Toggle(
                        "Pending approvals",
                        isOn: Binding(
                            get: { model.state.notificationApprovals },
                            set: { model.setNotificationPreference("approvals", enabled: $0) }
                        )
                    )
                    .disabled(model.actionInFlight)
                    Text("A run is waiting on your decision.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Toggle(
                        "Session completions",
                        isOn: Binding(
                            get: { model.state.notificationSessions },
                            set: { model.setNotificationPreference("sessions", enabled: $0) }
                        )
                    )
                    .disabled(model.actionInFlight)
                    Text("A run finished, with its outcome.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .padding(.top, 8)
    }
}

private struct LogsSettingsView: View {
    @ObservedObject var model: SettingsModel

    private var displayedLog: String {
        model.state.logText.isEmpty ? "No server log is available." : model.state.logText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Server Logs")
                .font(.headline)

            ScrollView {
                Text(displayedLog)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(model.state.logText.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(10)
            }
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay {
                RoundedRectangle(cornerRadius: 7)
                    .stroke(.separator, lineWidth: 1)
            }

            HStack {
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.state.logText, forType: .string)
                }
                .disabled(model.state.logText.isEmpty)

                Button("Reveal in Finder") {
                    guard let path = model.state.logFile else { return }
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                }
                .disabled(model.state.logFile == nil)
            }
        }
        .padding(20)
    }
}

private struct AboutSettingsView: View {
    @ObservedObject var model: SettingsModel

    private var statusColor: Color {
        switch model.state.updateStatus {
        case "available", "ready": .accentColor
        case "error": .red
        case "upToDate": .green
        default: .secondary
        }
    }

    var body: some View {
        VStack(spacing: 12) {
            Spacer()

            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)

            VStack(spacing: 4) {
                Text("AgentUse")
                    .font(.title2)
                    .fontWeight(.semibold)

                Text("Version \(model.state.updateCurrentVersion)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            VStack(spacing: 10) {
                HStack(spacing: 7) {
                    if model.state.updateStatus == "checking" || model.state.updateStatus == "downloading" {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                    }
                    Text(model.state.updateDetail)
                        .font(.caption)
                        .foregroundStyle(model.state.updateStatus == "error" ? .red : .secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(model.state.updateActionLabel) {
                    model.performUpdateAction()
                }
                .disabled(model.state.updateActionDisabled || model.actionInFlight)
            }
            .frame(maxWidth: 360)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

private struct SettingsView: View {
    @StateObject private var model = SettingsModel()

    var body: some View {
        TabView {
            GeneralSettingsView(model: model)
                .tabItem { Label("General", systemImage: "gearshape") }

            LogsSettingsView(model: model)
                .tabItem { Label("Logs", systemImage: "doc.text") }

            AboutSettingsView(model: model)
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 440, idealHeight: 520)
        .alert(
            "AgentUse Settings",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                model.refresh()
            }
        }
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        HostConnection.shared.start()
        DispatchQueue.main.async {
            NSApplication.shared.activate(ignoringOtherApps: true)
            NSApplication.shared.windows.first?.makeKeyAndOrderFront(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
private struct AgentUseSettingsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("AgentUse Settings", id: "agentuse-settings") {
            SettingsView()
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 620, height: 520)
        .commandsRemoved()
    }
}
