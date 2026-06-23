import { describe, it, expect, spyOn } from 'bun:test';
import { resolve } from 'path';
import * as config from '../src/utils/config';
import { createSubAgentTool } from '../src/subagent';

// Regression guard: a delegated leaf's step budget must follow the same precedence as a
// standalone run - parent's subagent-entry maxSteps > the leaf's own `maxSteps:` >
// DEFAULT_MAX_STEPS (100). Before this fix, createSubAgentTool hard-defaulted to 50 and never
// consulted the leaf's own maxSteps, so a leaf declaring maxSteps:120 silently ran at 50 under a
// manager (it died mid-task at the cap). The budget is resolved at tool-creation time (right after
// parseAgent), so we can assert the wiring without executing a model.
//
// sub-plain.agentuse declares `maxSteps: 20` and has no approval gate.
describe('Sub-agent maxSteps precedence', () => {
  const fixturesPath = resolve(__dirname, '__fixtures__/approval');
  const leafPath = resolve(fixturesPath, 'sub-plain.agentuse');

  function spyResolve() {
    const real = config.resolveMaxSteps;
    return spyOn(config, 'resolveMaxSteps').mockImplementation((cli?: number, agent?: number) =>
      real(cli, agent)
    );
  }

  it("uses the leaf's own maxSteps when the parent entry omits it", async () => {
    const spy = spyResolve();
    try {
      await createSubAgentTool(leafPath, undefined, fixturesPath);
      expect(spy).toHaveBeenCalledWith(undefined, 20);
      expect(spy.mock.results.at(-1)?.value).toBe(20);
    } finally {
      spy.mockRestore();
    }
  });

  it("lets the parent's subagent-entry maxSteps override the leaf's own", async () => {
    const spy = spyResolve();
    try {
      await createSubAgentTool(leafPath, 30, fixturesPath);
      expect(spy).toHaveBeenCalledWith(30, 20);
      expect(spy.mock.results.at(-1)?.value).toBe(30);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to DEFAULT_MAX_STEPS (100), not 50, when neither is set', async () => {
    // Precedence contract the subagent path must honor (resolveMaxSteps default is 100).
    expect(config.resolveMaxSteps(undefined, undefined)).toBe(100);
  });
});
