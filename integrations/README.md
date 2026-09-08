# AgentUse integrations

This directory contains the small, platform-specific templates used to package
AgentUse for Codex, Claude Code, Pi, and generic Agent Skills hosts.

Canonical workflow guidance remains in `skill-data/`. Do not copy generated
skills into this directory. Build complete, version-matched packages with:

```sh
bun run integrations:build
```

The command writes local marketplaces, a Pi package, and portable test archives
under `dist/integrations/`. These outputs are for local development and are not
attached to GitHub Releases. Validate their contents and checksums with:

```sh
bun run integrations:check
```

The generated packages are self-contained. They first try current guidance
from `npx -y agentuse@latest`, then an installed AgentUse CLI, and finally their
bundled snapshot.
