import { describe, expect, it } from 'bun:test';
import renderToString from 'preact-render-to-string';
import { UpdateBanner } from '../src/cli/serve/web/components/update-banner';
import { consumeUpdatePreview, debugSettingsEnabled, previewUpdate, requestUpdatePreview } from '../src/cli/serve/web/lib/update-preview';

describe('UpdateBanner', () => {
  it('shows versions, an exact package-manager command, and a dismissal', () => {
    const html = renderToString(<UpdateBanner update={{
      currentVersion: '0.17.0',
      latestVersion: '0.18.0',
      packageManager: 'pnpm',
      command: 'pnpm add -g agentuse@latest',
    }} />);

    expect(html).toContain('AgentUse 0.18.0 is available');
    expect(html).toContain('Installed 0.17.0');
    expect(html).toContain('pnpm add -g agentuse@latest');
    expect(html).toContain('Dismiss update 0.18.0');
  });

  it('builds next-minor preview data without touching the real update cache', () => {
    expect(previewUpdate('0.17.0')).toEqual({
      currentVersion: '0.17.0',
      latestVersion: '0.18.0',
      packageManager: 'npm',
      command: 'npm install -g agentuse@latest',
    });
  });

  it('carries the Settings preview to Home exactly once', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    requestUpdatePreview(storage);
    expect(consumeUpdatePreview(storage)).toBe(true);
    expect(consumeUpdatePreview(storage)).toBe(false);
  });

  it('shows debug controls only for an explicit debug query', () => {
    expect(debugSettingsEnabled('')).toBe(false);
    expect(debugSettingsEnabled('?debug=0')).toBe(false);
    expect(debugSettingsEnabled('?debug=1')).toBe(true);
    expect(debugSettingsEnabled('?project=demo&debug=1')).toBe(true);
  });
});
