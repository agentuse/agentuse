# Design QA — Dashboard preferences

- Source: `/Users/llch/.codex/visualizations/2026/08/29/01a04bea-95ea-7913-ae46-9b83f821a4f5/dashboard-preferences-mockup.html`
- Source screenshot: `/Users/llch/workspace/agentuse-lab/design-qa/dashboard-preferences-mockup-web.png`
- Implementation screenshot: `/Users/llch/workspace/agentuse-lab/design-qa/dashboard-preferences-browser.png`
- Viewport: 1280 × 720 CSS pixels
- Density: 1×
- State: dark theme, Web browser, notification permission denied

## Comparison

The implementation matches the selected browser mockup's hierarchy, labels,
680px content measure, card treatment, Dashboard-scoped heading, browser-only
notification section, and two-action Troubleshooting section. It intentionally
retains all seven shipping Home controls in their existing one-column layout;
the mockup abbreviated that established product content to four examples.
The implementation screenshot shows the real denied-permission notification
state instead of the mockup's available-permission state.

## Findings and resolution history

1. The first pass kept the correct structure but secondary hints were visibly
   dimmer than the mockup. Settings group and row hints were raised from
   `--muted-2` to `--muted-3`, then rebuilt and recaptured.
2. The first screenshots came from different browser viewport types. Both
   source and implementation were recaptured in agent-owned tabs at the same
   1280 × 720 viewport and 1× density before the final comparison.
3. Interaction verification confirmed theme, session-list, and Home visibility
   controls update and restore correctly. The topbar contains zero reload
   controls and exposes the gear as `Dashboard preferences`.
4. The Swift Settings helper compiled successfully, the native preference
   protocol tests passed, and the unsigned packaged `AgentUse.app` passed the
   Desktop release gate.

Final result: passed

---

# AgentUse updater status design QA

- Source visual truth: `/Users/llch/Library/Application Support/CleanShot/media/media_n9RMYgUdq8/CleanShot 2026-08-29 at 14.44.02@2x.png`
- Implementation screenshot: `/private/tmp/agentuse-updater-ui-success-final.jpeg`
- Normalized comparison: `/private/tmp/agentuse-updater-ui-comparison-normalized.png`
- Viewport: native AgentUse Settings window, 699 × 907 capture; About tab; light appearance
- Source dimensions: 458 × 150 pixels at 2×, normalized to 229 × 75 logical pixels
- Implementation dimensions: 699 × 907 pixels at 1×; focused status crop 229 × 75 pixels
- State: update check completed, current version is up to date

## Full-view comparison evidence

The first implementation preserved the existing centered composition, but user
review found that this produced a weak alignment grid and excessive empty space.
That implementation is retained in the comparison image as rejected evidence,
not as the final target.

## Focused-region comparison evidence

The normalized side-by-side comparison shows the old status region on the left
and the rejected first implementation on the right. It improved status copy but
made `Check Again` look like a text link and did not reproduce Sparkle's defining
spatial structure.

## Required fidelity surfaces

- Fonts and typography: Native system fonts are retained. The state headline
  uses callout/medium hierarchy; support and progress copy use caption styling;
  technical error details use a selectable monospaced caption.
- Spacing and layout rhythm: The corrected implementation uses Sparkle's compact
  icon-and-content header, a single left alignment grid, 20-point horizontal
  separation, and 12-point grouping rhythm. Actions share a trailing button row.
- Colors and visual tokens: Semantic system green, red, secondary, and accent
  colors replace the undifferentiated status dot. Colors remain appearance-aware.
- Image quality and asset fidelity: The supplied application icon is unchanged.
  Update states use native SF Symbols rather than custom-drawn assets.
- Copy and content: Success no longer repeats the current version. Available,
  downloading, ready, and error states use short action-oriented language. Raw
  updater failures are hidden behind an explicit Show Details disclosure.

## Findings

User review identified two P2 issues in the first implementation: the centered
stack lacked a coherent alignment grid, and `Check Again` used link styling even
though it is a direct action. Both were corrected in source. The follow-up native
helper compiled and focused source tests passed; a new post-fix screenshot still
needs acceptance before this report can return to `passed`.

The first expanded-error capture exposed a P2 vertical overflow: long technical
details reached the bottom edge of the window. The details scroll area was then
given a fixed 72-point height. The post-fix capture keeps the full disclosure
inside the About tab and makes long details scrollable.

The first downloading capture showed both an indeterminate spinner and a linear
progress bar. The final implementation uses a semantic download icon plus the
determinate bar, removing redundant progress signals.

## Interaction checks

- Up-to-date: standard bordered Check Again button
- Downloading: version headline, percentage, and determinate progress bar
- Ready: prominent Restart and Install action with restart expectation
- Error: friendly recovery copy, Try Again, and expandable selectable details

## Follow-up polish

- P3: Consider adding a release-notes link when release metadata is available.
- P3: Consider showing a last-successful-check timestamp if it can be persisted
  without adding another noisy status line.

## Comparison history

1. Initial implementation: expanded error details could overflow vertically.
2. Fix: constrained technical details to a 72-point scroll region and removed
   the redundant downloading spinner.
3. Post-fix evidence: success, downloading, ready, collapsed error, and expanded
   error states were recaptured in the compiled native Settings helper.

final result: implementation corrected; visual acceptance pending

---

# Design QA — First onboarding agent Run spotlight

- Source visual truth: `/Users/llch/.codex/generated_images/01a0558d-3840-7192-99a1-f86fa6a3f7a5/exec-7bede736-639b-4ae2-8ab3-ba271415f3d4.png`
- Implementation screenshot: `/private/tmp/agentuse-first-agent-spotlight-final-v3.png`
- Normalized comparison: `/private/tmp/agentuse-first-agent-spotlight-comparison-v2.png`
- Requested viewport: 1440 × 1024 CSS pixels
- Browser capture: 1454 × 1034 CSS pixels at 0.99 device pixel ratio; 1469 × 1044 screenshot pixels
- Source dimensions: 1486 × 1058 pixels
- Normalization: source and implementation were independently resized to 1440 × 1024, then placed side by side without cropping
- State: light theme, first onboarding agent, Source selected, Run spotlight open

## Full-view comparison evidence

The normalized side-by-side comparison confirms the selected hierarchy: the
entire agent-detail screen is dimmed while a single rectangular cutout preserves
the primary Run agent action. The implementation keeps the shipping AgentUse
navigation, agent metadata, capabilities, and source renderer instead of the
mock's invented shell. This is intentional product fidelity rather than design
drift.

## Focused-region comparison evidence

The upper-right action region was readable at full-view scale, so no separate
crop was required. The implementation matches the target's green primary
button, rectangular highlight, anchored pointer, white instruction surface,
headline, supporting copy, and right-aligned Got it action. Per the user's
clarification, only Run agent is inside the cutout; Run with instruction remains
dimmed.

## Required fidelity surfaces

- Fonts and typography: Existing self-hosted Geist and Geist Mono remain in
  place. The coachmark uses the product's 15px/600 headline and 13px supporting
  hierarchy with no wrapping or truncation at desktop or 393px mobile width.
- Spacing and layout rhythm: The cutout uses a 10px inset, 10px radius, and a
  24px anchored card gap. The 284px card remains inside the viewport on desktop
  and mobile; the mobile capture measured 14px left and 298px right edges.
- Colors and visual tokens: The implementation uses the existing `--green`,
  `--surface`, `--line-strong`, and theme-aware foreground tokens. A 62% neutral
  overlay reproduces the target's dimmed-page hierarchy without a radial glow.
- Image quality and asset fidelity: The feature has no raster imagery or custom
  icon assets. It retains the existing text-based Run control; no source assets
  were replaced with CSS drawings or placeholders.
- Copy and content: The visible copy matches the selected target: “Your agent is
  ready”, “Run it once to make sure it works.”, and “Got it”. Source remains the
  selected third tab.

## Findings and comparison history

1. First implementation pass: the 68% overlay was visually darker than the
   selected mock, and keyboard focus could remain behind the blocking overlay.
2. Fixes: reduced the overlay to 62%, focused Run agent after agent data renders,
   added Escape dismissal, and trapped focus between Run agent and Got it.
3. Responsive pass: the anchored card could extend left on narrow screens. It
   now left-aligns with the spotlight below 640px and fits within the viewport.
4. Post-fix evidence: desktop and 393px mobile captures show a rectangular
   cutout, readable coachmark, no overflow, no console warnings/errors, and the
   correct Source selection.

## Interaction checks

- Got it dismisses the overlay and removes `onboarding=first-agent` from the URL.
- Escape performs the same dismissal and URL cleanup.
- A normal `?tab=source` detail link renders no spotlight, preserving later New
  Agent creation behavior.
- Focus begins on Run agent and the modal coachmark exposes only Run agent and
  Got it as its keyboard loop.

## Follow-up polish

- No actionable P0, P1, or P2 differences remain.
- P3: actual onboarding copy can be revisited after observing first-run
  completion behavior, without changing the spotlight interaction.

final result: passed

---

# Design QA — Project-aware first agent onboarding

- Source visual truth: `/Users/llch/.codex/visualizations/2026/08/31/01a0558d-3840-7192-99a1-f86fa6a3f7a5/first-useful-agent-flow.html`
- Implementation screenshot: `/Users/llch/.codex/visualizations/2026/08/31/01a0558d-3840-7192-99a1-f86fa6a3f7a5/implementation-first-screen.png`
- Provider-gate screenshot: `/Users/llch/.codex/visualizations/2026/08/31/01a0558d-3840-7192-99a1-f86fa6a3f7a5/implementation-provider-gate.png`
- Viewport: 1198 × 1134 CSS pixels
- Implementation pixels: 1210 × 1210 full-page capture at 0.99 device pixel ratio
- State: isolated local server with no user config or provider credentials; first project choice and provider-gated existing-project branch

## Full-view comparison evidence

The implementation was captured in the built-in browser and visually inspected.
It preserves the selected mock's four-part progression—project choice, provider
connection, read-only scan, and click-to-create suggestions—inside the existing
AgentUse dashboard design system. The first screen keeps both requested project
choices above the fold and gives the existing-project route the recommended
visual treatment.

The source artifact is an HTML mockup. The built-in browser's security policy
blocked opening its `file:` URL, so a normalized side-by-side source-versus-
implementation image could not be produced in this pass. Per the Product Design
QA gate, this prevents a visual-fidelity pass even though implementation
screenshots and interaction evidence are available.

## Focused region comparison evidence

The provider gate was captured separately because it is the highest-risk
interaction transition. It shows the selected project behind a modal provider
connection step and confirms the scan cannot start before authentication. A
focused source comparison is unavailable for the same blocked source-rendering
reason.

## Required fidelity surfaces

- Fonts and typography: existing AgentUse Geist/Geist Mono hierarchy is retained; card and step copy wraps without clipping at the tested viewport.
- Spacing and layout rhythm: the existing two-column onboarding shell, 12px card gaps, and compact progress rail remain coherent with the dashboard.
- Colors and visual tokens: only existing foreground, muted, cyan, panel, line, and primary-action tokens are used.
- Image quality and asset fidelity: this flow has no image assets; no placeholder artwork, custom SVG, emoji, or CSS illustration was introduced.
- Copy and content: the implementation makes the read-only boundary, provider prerequisite, evidence-backed suggestions, schedule behavior, and Source/run handoff explicit.

## Interaction checks

- Both project-choice cards are keyboard-addressable buttons.
- Existing-project path validation and runtime attachment succeeded against a temporary project.
- Provider connection is required and the setup dialog opens before scanning.
- Browser console contained no warnings or errors.
- Model scan parsing, bounded context exclusions, exact schedule validation, creation redirect, and first-run Source spotlight are covered by automated tests.

## Findings

- [P2] Source comparison unavailable
  Location: full onboarding flow.
  Evidence: implementation is browser-rendered, but the selected HTML mockup could not be opened under the browser URL policy.
  Impact: exact visual drift across the scan and suggestion states cannot be certified from a normalized side-by-side comparison.
  Fix: provide or capture the selected mockup as a PNG, then compare each matching state at the same viewport.

## Comparison history

1. Implementation first screen and provider gate were captured and inspected; no broken layout, clipping, or console errors were found.
2. Source capture was attempted in the selected built-in browser and blocked by browser URL policy. No alternate browser surface or policy workaround was used.

final result: blocked
