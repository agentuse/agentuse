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

The full native About tab preserves the existing application icon, app name,
version, tab bar, window dimensions, and centered composition. Only the updater
status region changes. The rebuilt helper was inspected through macOS
accessibility and a native screenshot.

## Focused-region comparison evidence

The normalized side-by-side comparison shows the old status region on the left
and the rebuilt status region on the right. The new version replaces the loose
green dot and repeated version sentence with a semantic SF Symbol, a concise
headline, calm supporting copy, and a low-emphasis link action. This matches the
hierarchy of Sparkle's standard macOS updater UI without copying its window.

## Required fidelity surfaces

- Fonts and typography: Native system fonts are retained. The state headline
  uses callout/medium hierarchy; support and progress copy use caption styling;
  technical error details use a selectable monospaced caption.
- Spacing and layout rhythm: The existing centered layout and app identity are
  preserved. The updater region uses 8-point icon spacing and 12-point vertical
  rhythm. Progress is constrained to 220 points and error details to 320 points.
- Colors and visual tokens: Semantic system green, red, secondary, and accent
  colors replace the undifferentiated status dot. Colors remain appearance-aware.
- Image quality and asset fidelity: The supplied application icon is unchanged.
  Update states use native SF Symbols rather than custom-drawn assets.
- Copy and content: Success no longer repeats the current version. Available,
  downloading, ready, and error states use short action-oriented language. Raw
  updater failures are hidden behind an explicit Show Details disclosure.

## Findings

No actionable P0, P1, or P2 issues remain.

The first expanded-error capture exposed a P2 vertical overflow: long technical
details reached the bottom edge of the window. The details scroll area was then
given a fixed 72-point height. The post-fix capture keeps the full disclosure
inside the About tab and makes long details scrollable.

The first downloading capture showed both an indeterminate spinner and a linear
progress bar. The final implementation uses a semantic download icon plus the
determinate bar, removing redundant progress signals.

## Interaction checks

- Up-to-date: quiet Check Again link
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

final result: passed
