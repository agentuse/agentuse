# AgentUse for Pi

Turn the workflow in the current Pi conversation into a focused, validated
AgentUse agent with `/automate`.

## Repository installation

AgentUse does not publish a Pi package through new GitHub Releases. Build the
integration from a source checkout, then install the generated package:

```sh
bun run integrations:build
pi install ./dist/integrations/pi
```

Start a new Pi session, then use `/automate`. See the
[installation guide](https://docs.agentuse.io/guides/coding-agent-integrations)
for the complete authoring and validation flow.
