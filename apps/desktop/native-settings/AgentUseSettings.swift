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
    var logText: String
    var logFile: String?

    static let loading = SettingsState(
        status: .starting,
        title: "Checking server…",
        detail: "Looking for a local AgentUse server.",
        actionLabel: "Start Server",
        actionDisabled: true,
        launchAtLogin: false,
        logText: "",
        logFile: nil
    )
}

private struct HostMessage: Decodable {
    var type: String
    var state: SettingsState?
}

private struct HelperCommand: Encodable {
    var type: String
    var enabled: Bool?

    init(type: String, enabled: Bool? = nil) {
        self.type = type
        self.enabled = enabled
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

    init() {
        HostConnection.shared.model = self
    }

    func apply(_ state: SettingsState) {
        self.state = state
        actionInFlight = false
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

private struct SettingsView: View {
    @StateObject private var model = SettingsModel()

    var body: some View {
        TabView {
            GeneralSettingsView(model: model)
                .tabItem { Label("General", systemImage: "gearshape") }

            LogsSettingsView(model: model)
                .tabItem { Label("Logs", systemImage: "doc.text") }
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 380, idealHeight: 440)
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
        .defaultSize(width: 620, height: 440)
        .commandsRemoved()
    }
}
