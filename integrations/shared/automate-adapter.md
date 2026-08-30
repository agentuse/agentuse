# Automate with AgentUse

Treat the current conversation, invocation details, and repository state as the
originating workflow. Do not make the user restate context that is already
clear.

Try these sources in order and stop after the first successful skill load:

1. When `npx` is available, run
   `npx -y agentuse@latest skills get automate --full` once. Subject to the
   host's normal approval, sandbox, and network controls, follow the returned
   skill as authoritative for the current AgentUse release. Do not re-enter
   this freshness adapter from the returned instructions.
2. If that command is unavailable or fails, and `agentuse` is installed, run
   `agentuse skills get automate --full` once and follow the returned skill as
   authoritative for that installed version.
3. If neither source loads, read and follow
   [the bundled automate snapshot](references/automate.md). Its core, creator,
   and tester references are available beside it. Use its artifact-only mode
   when no AgentUse command can execute.

Do not repeatedly retry a failed network or package command. Do not silently run
interactive setup or provider login.
