# Evaluation: original tool-response batches during SDK upgrades

Status: a development-only evaluation; no production integration is enabled.
Evaluated at AgentUse v0.24.0 with its existing AI SDK 7.0.128 and
OpenAI-compatible provider 3.0.63 pins. The added development dependency is
published `prefix-safe-json@0.6.1`.

The existing `tests/model-stream-transport-drop.test.ts` records repeated
production transport interruptions and pins checkpoint recovery. That is a
reason to evaluate the provider boundary regularly, but the cases here are
**authored fixtures**, not captures or reproductions of those incidents.

## Run

With the project's pinned Bun and pnpm toolchain:

```sh
pnpm install --frozen-lockfile
bun test tests/raw-tool-stream-batches.test.ts
bun test tests/model-stream-transport-drop.test.ts
```

Run test files in separate processes, as the project test script does, because
they replace modules. Expected result: eight paired evaluation cases pass;
the complete native and preflight controls each record two notes, return both
original call IDs in the next request and produce the final response.
The deliberately refused cases may print SDK error diagnostics.

The provider transport returns authored SSE at an `.invalid` endpoint. The
actual provider parser, `executeAgentCore`, default-on Code Mode guest and
tool dispatcher run; the only nested tool records a string in memory. No
model service, shell command, application file write or external tool runs.

## Reviewed observations

| Original response | Native nested effects | PSJ whole-response preflight effects |
| --- | ---: | ---: |
| Complete, distinct call IDs | 2, with results and final response | 2, with results and final response |
| Two calls with the same original ID | 2; provider assigns the second a new ID | 0; whole response refused |
| Complete call plus malformed JSON sibling | 1; valid sibling proceeds | 0; whole response refused |
| Complete arguments with `finish_reason: length` | 0 | 0; whole response refused |

Native execution of a valid sibling and provider-assigned IDs are different
policies, not automatically SDK defects. Length already releases no nested
effect in this runner and is retained as a control. The native expectations
describe these exact installed versions; a future SDK change should trigger
review rather than automatically updating the assertions.

The preflight reads the actual outgoing tool schemas and checks the entire
original fixture with PSJ before the SDK receives any of its bytes. A rejected
response supplies no tool results to a continuation. A retry without tool
results receives the same fixture, preventing a successful fallback response
from hiding refusal or retry behavior.

## Decision still needed

Does retaining this additional development dependency help maintainers review
SDK/provider upgrades, or are existing tests and native policies sufficient?
An independent maintainer run and a later rerun on an actual upgrade would
provide evidence; the package maintainer's own checks do not establish that.

The fixture helper buffers a finite response. It is not a production fetch
adapter: it does not simulate dropped reads, arrival timing, cancellation or
all SSE encodings, and it does not replace approval, leases or input-policy
checks. A runtime policy would need bounded transport handling, explicit
latency/streaming tradeoffs and preservation of AgentUse's approval and schema
transformation contracts. That work is outside this evaluation.

If the checks do not justify the dependency, remove the single test file,
this evaluation note and the development dependency with its lockfile entry.
