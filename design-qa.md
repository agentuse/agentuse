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
