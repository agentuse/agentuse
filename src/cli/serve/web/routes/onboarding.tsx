import { useLocation } from 'preact-iso';
import { FirstProjectEmptyState } from '../components/first-project-empty-state';
import { Loading } from '../components/loading';
import { ProjectAgentDiscovery } from '../components/project-agent-discovery';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { fetchInfo } from '../lib/api';
import { pageTitle } from '../lib/brand';

/** Dedicated first-use workflow. Dashboard routes stay operational surfaces. */
export default function Onboarding() {
  useTitle(pageTitle('Onboarding'));
  const location = useLocation();
  const info = useFetch('onboarding-info', () => fetchInfo());
  const requestedProjectId = typeof location.query.project === 'string' ? location.query.project : undefined;
  const project = requestedProjectId
    ? info.data?.projects.find((candidate) => candidate.id === requestedProjectId)
    : info.data?.projects.find((candidate) => candidate.id === info.data?.default) ?? info.data?.projects[0];

  return (
    <div class="page-onboarding" data-ambient="idle">
      <header class="onboarding-route-header">
        <a class="onboarding-route-brand" href="/" aria-label="AgentUse home">AGENTUSE</a>
        <a class="onboarding-route-exit" href="/agents">Exit onboarding</a>
      </header>
      <main class="onboarding-route-main">
        {info.loading && !info.data
          ? <Loading label="Loading onboarding…" />
          : info.error
            ? <div class="errors" role="alert">Failed to load: {info.error.message}</div>
            : !info.data || !requestedProjectId
              ? <FirstProjectEmptyState folderPickerAvailable={info.data?.capabilities?.projectFolderPicker === true} />
              : requestedProjectId && !project
                ? <div class="panel"><div class="empty">That project is not loaded. <a href="/onboarding">Choose another project</a>.</div></div>
                : project
                  ? <ProjectAgentDiscovery
                      projectId={project.id}
                      {...(project.about?.name ? { projectName: project.about.name } : {})}
                      projectPath={project.scope ?? project.path}
                      existingAgents={project.agentCount > 0}
                    />
                  : null}
      </main>
    </div>
  );
}
