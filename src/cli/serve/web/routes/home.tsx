import { fetchInfo, fetchApprovals, fetchAgents } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const CARDS: Array<{ href: string; title: string; desc: string }> = [
  { href: '/agents', title: 'Agents', desc: 'Browse the agents loaded by this daemon.' },
  { href: '/sessions', title: 'Sessions', desc: 'Run logs and approvals for every run.' },
  { href: '/schedules', title: 'Schedules', desc: 'Upcoming and recent scheduled runs.' },
  { href: '/stores', title: 'Stores', desc: 'Key-value data written by agents.' },
  { href: '/approvals', title: 'Approvals', desc: 'Tool calls awaiting a decision.' },
];

export default function Home() {
  useTitle('AgentUse');
  const { data, error, loading } = useFetch('home', () => fetchInfo(), { refreshMs: 30_000 });
  // Pending approvals are the one count worth surfacing live on the landing page:
  // it tells the operator at a glance whether anything needs them right now.
  const approvals = useFetch('home-approvals', () => fetchApprovals(), { refreshMs: 30_000 });
  const pendingApprovals = approvals.data?.buckets.pending.length ?? 0;

  // The /api rollup counts every discovered .agentuse file, including ones that
  // fail to parse; the Agents page counts only successfully-loaded agents, so
  // the two disagree when a file is broken. Drive Home's agent counts off the
  // same /api/agents payload the Agents page uses so they always match, and
  // surface the parse failures rather than hiding them in the total.
  const agents = useFetch('home-agents', () => fetchAgents(), { refreshMs: 30_000 });
  const agentRows = agents.data?.agents;
  const failedAgents = agents.data?.errors.length ?? 0;
  const loadedByProject = new Map<string, number>();
  for (const a of agentRows ?? []) loadedByProject.set(a.projectId, (loadedByProject.get(a.projectId) ?? 0) + 1);
  const loadedFor = (p: { id: string; agentCount: number }): number =>
    agentRows ? (loadedByProject.get(p.id) ?? 0) : p.agentCount;

  const projects = data?.projects ?? [];
  // Prefer the parsed loaded count; fall back to the file count until the
  // agents payload arrives so the lede does not flash a spurious "0 agents".
  const totalAgents = agentRows ? agentRows.length : projects.reduce((sum, p) => sum + p.agentCount, 0);
  const totalSchedules = projects.reduce((sum, p) => sum + p.scheduleCount, 0);
  const multiProject = projects.length > 1;
  const agentsPhrase = `${plural(totalAgents, 'agent')}${failedAgents > 0 ? ` (${failedAgents} failed to parse)` : ''}`;
  const lede = multiProject
    ? `${plural(projects.length, 'project')} · ${agentsPhrase} · ${plural(totalSchedules, 'scheduled run')}.`
    : `${agentsPhrase} · ${plural(totalSchedules, 'scheduled run')} in this serve daemon.`;

  // Counts appear only on cards backed by a cheap, stable total already in hand:
  // agents and schedules come straight from /api, pending approvals from the
  // approvals poll. Sessions and Stores stay countless on purpose - sessions are
  // windowed (any number would need a time range to mean anything) and stores
  // are per-project scans; neither has a single figure worth a second fetch here.
  const countFor = (title: string): string | undefined =>
    title === 'Agents' ? plural(totalAgents, 'agent')
      : title === 'Schedules' ? plural(totalSchedules, 'run')
        : title === 'Approvals' ? (pendingApprovals > 0 ? `${pendingApprovals} pending` : undefined)
          : undefined;

  return (
    <div class="page-home">
      <Topbar />
      <main>
        <header>
          <div class="eyebrow">serve daemon</div>
          <h1>AgentUse</h1>
          <p class="lede">{data ? lede : loading ? 'Loading…' : ''}</p>
          {error && <div class="errors" role="alert">Failed to load: {error.message}</div>}
        </header>
        <div class="cards">
          {CARDS.map((card) => {
            const count = countFor(card.title);
            return (
              <a class="card" href={card.href} key={card.href}>
                <div class="card-top"><span class="card-title">{card.title}</span>{count && <span class="card-count">{count}</span>}</div>
                <div class="card-desc">{card.desc}</div>
              </a>
            );
          })}
        </div>
        <section class="group">
          <h2 class="group-title"><span>Projects</span><span class="count">{projects.length}</span><span class="rule"></span></h2>
          <div class="panel">
            {projects.length === 0
              ? <div class="empty">{loading ? 'Loading projects…' : 'No projects loaded.'}</div>
              : projects.map((p) => (
                <a class="proj" href={`/agents/${encodeURIComponent(p.id)}`} key={p.id}>
                  <div>
                    <div class="proj-id">{p.id}{p.id === data?.default && <span class="proj-default">default</span>}</div>
                    <div class="proj-path">{p.path}{p.scope && p.scope !== p.path ? ` · scope ${p.scope}` : ''}</div>
                  </div>
                  <div class="proj-counts">{plural(loadedFor(p), 'agent')} · {plural(p.scheduleCount, 'schedule')}<span class="proj-go" aria-hidden="true">›</span></div>
                </a>
              ))}
          </div>
        </section>
        {data && <p class="api-hint">Programmatic clients: server info JSON at <code>/api</code>, JSON twins at <code>/api/agents</code>, <code>/api/sessions</code>, <code>/api/schedules</code>. v{data.version}</p>}
      </main>
    </div>
  );
}
