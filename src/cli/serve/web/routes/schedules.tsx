import type { SerializedSchedule } from '../../../../scheduler';
import { fetchSchedules } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { formatApprovalTime } from '../lib/format';

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' });
}
function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function Slot(props: { schedule: SerializedSchedule; multiProject: boolean }) {
  const { schedule, multiProject } = props;
  const ms = schedule.nextRun ? Date.parse(schedule.nextRun) : NaN;
  const time = Number.isFinite(ms) ? timeLabel(ms) : '—';
  const staggerNote = schedule.jitterMs > 0 ? ` · stagger +${Math.round(schedule.jitterMs / 1000)}s` : '';
  const lastRunSessionId = schedule.lastResult?.sessionId;
  const lastRunText = schedule.lastRun
    ? `${schedule.lastResult ? (schedule.lastResult.success ? 'ran ok' : 'ran failed') : 'ran'} ${formatApprovalTime(Date.parse(schedule.lastRun))}`
    : '';
  const lastRun = schedule.lastRun
    ? (lastRunSessionId
      ? <a href={`/sessions/${encodeURIComponent(lastRunSessionId)}`} class={schedule.lastResult && !schedule.lastResult.success ? 'failed' : 'ok'}>{lastRunText}</a>
      : <span class={schedule.lastResult && !schedule.lastResult.success ? 'failed' : 'ok'}>{lastRunText}</span>)
    : null;
  return (
    <div class={`slot${schedule.nextRun ? '' : ' disabled'}`}>
      <div class="slot-time">{time}</div>
      <div class="slot-main">
        {multiProject && <div class="slot-proj">{schedule.projectId}</div>}
        <div class="slot-agent"><code>{schedule.agentPath}</code></div>
        <div class="slot-cadence" title={`${schedule.expression}${staggerNote}`}>{schedule.human}</div>
      </div>
      <div class="slot-side">{lastRun}</div>
    </div>
  );
}

export default function Schedules() {
  useTitle('AgentUse / Schedules');
  const { data, error, loading } = useFetch('schedules', () => fetchSchedules(), { refreshMs: 30_000 });

  const schedules = data?.schedules ?? [];
  const multiProject = new Set(schedules.map((s) => s.projectId)).size > 1;

  const days = new Map<string, SerializedSchedule[]>();
  const disabled: SerializedSchedule[] = [];
  for (const schedule of schedules) {
    if (!schedule.nextRun) { disabled.push(schedule); continue; }
    const label = dayLabel(Date.parse(schedule.nextRun));
    const list = days.get(label);
    if (list) list.push(schedule);
    else days.set(label, [schedule]);
  }

  const renderDay = (label: string, list: SerializedSchedule[]) => (
    <section class="day" key={label}>
      <h2 class="day-title"><span>{label}</span><span class="count">{list.length}</span><span class="rule"></span></h2>
      <div class="timetable">{list.map((s) => <Slot key={s.id} schedule={s} multiProject={multiProject} />)}</div>
    </section>
  );

  const hasContent = days.size > 0 || disabled.length > 0;

  return (
    <div class="page-schedules">
      <Topbar currentPage="schedules" />
      <main>
        <header>
          <div class="eyebrow">scheduled agents</div>
          <h1>Schedules</h1>
          <p class="lede">{data ? `${schedules.length} scheduled agent${schedules.length === 1 ? '' : 's'}, upcoming runs first.` : loading ? 'Loading…' : ''}</p>
          {error && <div class="errors">Failed to load schedules: {error.message}</div>}
        </header>
        {hasContent
          ? <>
            {[...days.entries()].map(([label, list]) => renderDay(label, list))}
            {disabled.length > 0 && renderDay('Disabled', disabled)}
          </>
          : <div class="panel"><div class="empty">{loading ? 'Loading…' : 'No scheduled agents. Add a schedule: field to an agent file.'}</div></div>}
      </main>
    </div>
  );
}
