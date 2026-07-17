# Evaluation: `@ai-sdk/workflow` WorkflowAgent as a SuspendSignal replacement

**Status:** evaluated, NOT adopting now. Re-evaluate when the triggers below fire.
**Context:** agentuse-lab#165 Phase 3. Phases 0-2 (effect WAL, drain+abort,
`stopOnSuspend`, approval leases on v7 `toolApproval`) already closed the
ghost-post class structurally, with regression tests against the real SDK.
**Evaluated version:** `@ai-sdk/workflow` 1.0.30 against `ai` 7.0.30 (2026-07).

## What WorkflowAgent offers

- **Durable agent loops.** Each tool execution is a durable step (`'use step'`);
  step inputs/outputs are recorded to an event log; a crashed or restarted
  process replays the log to reconstruct state without re-running completed
  steps.
- **Approvals that survive restarts.** `needsApproval` on the tool definition
  (note: WorkflowAgent keeps the per-tool `needsApproval` shape that core v7
  replaced with call-level `toolApproval`); the workflow suspends durably and
  resumes when the human decides, hours or days later. This is a first-class
  version of what our SuspendSignal + session journal + resume machinery
  hand-builds - and #165 lived exactly in that hand-built machinery.
- **Automatic step retries** (default 3) and managed stream reconnection
  (`getRun(runId)`, `run.getReadable({ startIndex })`, `WorkflowChatTransport`).

## Why not now

1. **Runtime coupling.** WorkflowAgent only runs inside the Workflow DevKit
   runtime: a build-time compiler for the `'use workflow'`/`'use step'`
   directives plus a "World" (execution + orchestration + persistence backend).
   Vercel's managed World is the default; self-hosting needs a community or
   custom World via `WORKFLOW_TARGET_WORLD` (public beta). agentuse is a
   local-first CLI + pm2 daemon built with plain `bun build`; adopting WDK
   means adopting its compiler, its event-log store, and its scheduler beside
   (or replacing) our session storage. That is a platform migration, not a
   refactor.
2. **Two sources of truth.** Sessions, part journals, context snapshots, the
   web UI, Slack approvals, the gate cascade, stores, and learnings all read
   agentuse's session storage. WorkflowAgent's event log would duplicate the
   run state; every surface would need to read (or mirror) WDK state. The gate
   cascade in particular - a leaf's `await_human` bubbling through
   `subagent_wait` parents so one decision at the root resumes the whole tree -
   has no WorkflowAgent equivalent and would need a full redesign on nested
   workflows.
3. **Replay semantics cut against irreversible effects.** Durable steps "may
   run more than once" (automatic retries; replay on non-determinism bugs) and
   the framework asks tools to be idempotent. Our effect class (posting to X,
   sending email) is exactly the class where at-most-once matters more than
   at-least-once. #165 was caused by an execute firing outside the journaled
   path; a retry-by-default runtime reintroduces that risk shape unless every
   effect tool grows an idempotency key. Our Phase 2 leases + effect WAL are
   built for at-most-once with human-approved content.
4. **The problem it solves is already solved here.** Durable approval across
   restarts is what our session journal + resume already does (and #165's bug
   in that machinery is now fixed and regression-tested at the SDK boundary,
   so an SDK upgrade that changes eager-execution timing gets caught by
   `tests/suspend-drain.test.ts` / `tests/lease-enforcement.test.ts`).
5. **Serialization constraints.** All step context must be plain data. Our
   tool closures carry live handles (store locks, session managers, MCP
   connections, artifact sinks) that would have to be re-derived inside every
   step.

## What would change the answer

- WDK self-hosted Worlds reach stable with a supported local/filesystem World
  (no external queue), and the directive compiler works under bun without a
  bundler change.
- agentuse grows a hosted/serverless execution mode where processes are
  ephemeral by design - then durable-by-construction beats our
  daemon-plus-journal model.
- The SDK deprecates the primitives our runner sits on (`streamText` step loop,
  `toolApproval`) in favor of WorkflowAgent-only APIs.

## Migration sketch (if/when adopted)

1. Wrap `executeAgentCore`'s segment loop as a workflow; each tool execute
   becomes a `'use step'` function taking IDs/config, re-deriving live handles
   inside.
2. Replace SuspendSignal with WorkflowAgent's `needsApproval` on `await_human`
   (the gate becomes a real durable approval instead of an exception).
3. Keep the approval-lease layer: `needsApproval` decides WHETHER to pause;
   leases still decide whether an effectful command is covered by what the
   human actually approved. The two compose.
4. Mirror WDK run events into the session journal so the web UI/Slack surfaces
   keep working during the transition.
5. Port the gate cascade last (nested workflows or a single workflow spanning
   the agent tree).

## Sources

- https://ai-sdk.dev (WorkflowAgent docs: durable steps, needsApproval,
  getRun/readable resume, serialization constraints)
- https://github.com/vercel/workflow / https://vercel.com/blog/introducing-workflow
  (Workflow DevKit, Worlds, event-log replay, `WORKFLOW_TARGET_WORLD`)
- https://vercel.com/changelog/open-source-workflow-dev-kit-is-now-in-public-beta
