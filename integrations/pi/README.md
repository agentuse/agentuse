# AgentUse for Pi

Turn the workflow in the current Pi conversation into a focused, validated
AgentUse agent with `/automate`.

## Install a release

Download `agentuse-pi-package.tgz` from the desired
[AgentUse release](https://github.com/agentuse/agentuse/releases). Extract it
into a persistent directory and install the resulting `package` directory:

```sh
mkdir -p agentuse-pi
tar -xzf agentuse-pi-package.tgz -C agentuse-pi
pi install ./agentuse-pi/package
```

Keep the extracted directory while the integration is installed. Start a new
Pi session to use `/automate`. See the
[installation guide](https://docs.agentuse.io/guides/coding-agent-integrations)
for download commands and updates.

## Local development

Build with `bun run integrations:build` from the repository root, then install
the generated package:

```sh
pi install ./dist/integrations/pi
```
