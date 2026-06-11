import { fetchInfo } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';

function projectAnchor(projectId: string): string {
  return `project-${projectId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

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

  const projects = data?.projects ?? [];
  const totalAgents = projects.reduce((sum, p) => sum + p.agentCount, 0);
  const totalSchedules = projects.reduce((sum, p) => sum + p.scheduleCount, 0);
  const multiProject = projects.length > 1;
  const lede = multiProject
    ? `${plural(projects.length, 'project')} · ${plural(totalAgents, 'agent')} · ${plural(totalSchedules, 'scheduled run')}.`
    : `${plural(totalAgents, 'agent')} · ${plural(totalSchedules, 'scheduled run')} in this serve daemon.`;

  const countFor = (title: string): string | undefined =>
    title === 'Agents' ? plural(totalAgents, 'agent')
      : title === 'Schedules' ? plural(totalSchedules, 'run')
        : undefined;

  return (
    <div class="page-home">
      <Topbar />
      <main>
        <header>
          <div class="eyebrow">serve daemon</div>
          <h1>AgentUse</h1>
          <p class="lede">{data ? lede : loading ? 'Loading…' : ''}</p>
          {error && <div class="errors">Failed to load: {error.message}</div>}
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
                <a class="proj" href={`/agents#${projectAnchor(p.id)}`} key={p.id}>
                  <div>
                    <div class="proj-id">{p.id}{p.id === data?.default && <span class="proj-default">default</span>}</div>
                    <div class="proj-path">{p.path}{p.scope && p.scope !== p.path ? ` · scope ${p.scope}` : ''}</div>
                  </div>
                  <div class="proj-counts">{plural(p.agentCount, 'agent')} · {plural(p.scheduleCount, 'schedule')}<span class="proj-go" aria-hidden="true">›</span></div>
                </a>
              ))}
          </div>
        </section>
        {data && <p class="api-hint">Programmatic clients: server info JSON at <code>/api</code>, JSON twins at <code>/api/agents</code>, <code>/api/sessions</code>, <code>/api/schedules</code>. v{data.version}</p>}
      </main>
    </div>
  );
}
