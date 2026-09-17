import { describe, expect, it, spyOn } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { SessionListItem } from '../src/cli/serve/web/routes/sessions-list';
import { RunHistorySpark } from '../src/cli/serve/web/components/run-health';
import { WorkingStepMeta } from '../src/cli/serve/web/routes/session-detail';
import type { SessionRow } from '../src/cli/serve/web/lib/api';

const row: SessionRow = {
  sessionId: 'run', project: 'test', agent: { id: 'agent', name: 'Agent' },
  status: 'running', trigger: 'manual', createdAt: 0, updatedAt: 14_400_000,
  timing: { calculatedAt: 14_400_000, activeMs: 60_000, running: true },
};

function list(session: SessionRow, now = 14_430_000) {
  return renderToString(<SessionListItem row={session} selected={false} query="" href="/" now={now} />);
}

describe('active duration displays', () => {
  it('advances the working timer beside the step without a new server snapshot', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(14_430_000);
    try {
      expect(renderToString(<WorkingStepMeta step={45} timing={row.timing} />)).toContain('step 45 · <span');
      expect(renderToString(<WorkingStepMeta step={45} timing={row.timing} />)).toContain('1:30</span>');
      clock.mockReturnValue(14_431_000);
      expect(renderToString(<WorkingStepMeta step={45} timing={row.timing} />)).toContain('1:31</span>');
      expect(renderToString(<WorkingStepMeta step={45} timing={{ ...row.timing!, running: false }} />)).toContain('1:00</span>');
    } finally {
      clock.mockRestore();
    }
  });
  it('shows unavailable historical timing and supports working before the first step', () => {
    expect(renderToString(<WorkingStepMeta step={45} />)).toContain('Time unavailable');
    const html = renderToString(<WorkingStepMeta step={0} timing={{ calculatedAt: 0, activeMs: 0, running: false }} />);
    expect(html).toContain('0:00</span>');
    expect(html).not.toContain('step 0');
  });
  it('shows processing time instead of four hours of session age', () => {
    expect(list(row)).toContain('Working · 1m active');
    expect(list(row)).not.toContain('4h');
  });
  it('does not invent active time for historical sessions', () => {
    const { timing, ...legacy } = row;
    expect(list(legacy)).not.toContain('4h');
    expect(renderToString(<RunHistorySpark runs={[legacy]} />)).toContain('Active time unavailable');
  });
  it('sizes completed history by active time and names the measurement', () => {
    const completed = { ...row, status: 'completed', timing: { ...row.timing!, running: false } };
    const html = renderToString(<RunHistorySpark runs={[completed]} />);
    expect(html).toContain('60s active');
    expect(html).not.toContain('4h');
  });
});
