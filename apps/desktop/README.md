# AgentUse Desktop (macOS)

This package is a native macOS shell around the existing AgentUse dashboard. It
does not contain a renderer, a separate agent configuration format, or a second
backend. At launch it attaches to a local `agentuse serve` process registered by
the CLI, or starts the packaged `agentuse` CLI if none is available.

## Development

From the repository root, build the CLI/web assets first, then run:

```sh
pnpm --filter @agentuse/desktop dev
```

`AGENTUSE_CLI_PATH=/absolute/path/to/bin/cli.js` can override the packaged CLI
for local development. The app starts an owned daemon with `agentuse serve` and
leaves an externally started daemon untouched when quitting.

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

`agentuse` is a production workspace dependency. The packaging allowlist keeps
its CLI, built dashboard, skills, and package metadata while excluding source,
tests, prior desktop builds, and workspace caches. The desktop process therefore
starts the same compiled CLI that users run in a terminal without recursively
embedding the repository.
