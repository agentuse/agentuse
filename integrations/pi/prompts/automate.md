---
description: Turn the current workflow into a tested, reusable AgentUse agent
argument-hint: "[workflow or additional instruction]"
---

Use the `automate` skill bundled with this Pi package. Load and follow its full
instructions, treating the current Pi conversation, repository state, and this
invocation detail as the originating context:

${ARGUMENTS:-Use the workflow we just completed.}
