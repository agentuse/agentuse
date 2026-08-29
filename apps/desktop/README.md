# AgentUse Desktop (macOS)

This package is a native macOS shell around the existing AgentUse dashboard. It
does not contain a renderer, a separate agent configuration format, or a second
backend. At launch it attaches to a local `agentuse serve` process registered by
the CLI, or starts the packaged `agentuse` CLI if none is available. The
menu-bar menu stays focused on showing the dashboard, opening Settings, and
quitting the app. Settings provides server controls, launch-at-login, and the
current server log, and can link the bundled `agentuse` command into
`~/.local/bin` without introducing a second dashboard renderer. Its UI is
an Ice-inspired SwiftUI helper app using native macOS tabs, forms, buttons,
toggles, typography, colors, and accessibility behavior. Electron remains the
owner of server state and exchanges typed newline-delimited JSON messages with
the helper over its standard input and output.

Before offering to install that link, Settings resolves `agentuse` from the
user's login-shell PATH. Existing npm, pnpm, yarn, bun, Homebrew, and other
installations are reported by path and are never replaced or shadowed.

## Development

From the repository root, build the CLI/web assets first, then run:

```sh
pnpm --filter @agentuse/desktop dev
```

`AGENTUSE_CLI_PATH=/absolute/path/to/bin/cli.js` can override the packaged CLI
for local development. The app starts an owned daemon with `agentuse serve` and
leaves an externally started daemon untouched when quitting.

For routine testing of the packaged app, install and launch one canonical copy:

```sh
pnpm desktop:install-local
```

This builds into temporary staging, gracefully terminates any running AgentUse
desktop bundle, replaces `~/Applications/AgentUse.app`, and launches that copy.
Avoid launching `apps/desktop/dist/*/AgentUse.app` directly; keeping one
canonical installation prevents Launch Services from retaining several local
copies with the same bundle identifier.

Building the desktop package requires Xcode because the desktop build compiles
`native-settings/AgentUseSettings.swift` and uses Apple's asset-catalog compiler
to produce the multi-resolution app icon. The default
build matches the host architecture. Set `AGENTUSE_SETTINGS_UNIVERSAL=1` to
produce an `arm64` + `x86_64` Settings helper for a universal Electron build.

## Packaging

```sh
pnpm --filter @agentuse/desktop dist:mac
```

Unsigned development artifacts are supported by running
`CSC_IDENTITY_AUTO_DISCOVERY=false pnpm desktop:package:mac`. For a signed
release, set `CSC_LINK`/`CSC_KEY_PASSWORD` for electron-builder and set
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; the after-sign
hook will notarize the `.app`. Keep those credentials in CI secrets, never in
this package or a user configuration file.

For a manual release, prefer a validated local Keychain profile so credentials
never enter the shell environment:

```sh
xcrun notarytool store-credentials agentuse-notary --apple-id <apple-id> --team-id <team-id>
APPLE_KEYCHAIN_PROFILE=agentuse-notary pnpm desktop:package:mac
```

`notarytool` prompts securely for the app-specific password. electron-builder
uses the Developer ID Application identity installed in the login Keychain.

`agentuse` is a production workspace dependency. The packaging allowlist keeps
its CLI, built dashboard, skills, and package metadata while excluding source,
tests, prior desktop builds, and workspace caches. The desktop process therefore
starts the same compiled CLI that users run in a terminal without recursively
embedding the repository. The signed application places the native Settings
helper under `Contents/Frameworks`, where nested macOS code is expected.
