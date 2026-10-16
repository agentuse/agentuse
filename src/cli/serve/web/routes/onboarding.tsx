import { useLocation } from 'preact-iso';
import { CodingAgentFirstRun } from '../components/coding-agent-first-run';
import { FirstProjectEmptyState } from '../components/first-project-empty-state';
import { Loading } from '../components/loading';
import { ProjectAgentDiscovery } from '../components/project-agent-discovery';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { fetchInfo } from '../lib/api';
import { pageTitle } from '../lib/brand';
import { WORDMARK_SVG } from '../../brand';
import { InlineError } from '../components/error-banner';

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
        <a class="onboarding-route-brand" href="/" aria-label="AgentUse home" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} />
        <a class="onboarding-route-exit" href="/agents">Exit onboarding</a>
      </header>
      <main class="onboarding-route-main">
        {info.loading && !info.data
          ? <Loading label="Loading onboarding…" />
          : info.error
            ? <InlineError>Failed to load: {info.error.message}</InlineError>
            : requestedProjectId && info.data && !project
              ? <div class="panel"><div class="empty">That project is not loaded. <a href="/onboarding">Choose another project</a>.</div></div>
              // Without ?project, carry on in the default project (the Mac app
              // and `agentuse setup` make one) instead of asking for a folder again.
              : !info.data || !project
                ? <FirstProjectEmptyState folderPickerAvailable={info.data?.capabilities?.projectFolderPicker === true} />
                // A local first run leads with the coding agent; ?project (Find agent ideas) still scans.
                : !requestedProjectId && project.agentCount === 0 && info.data.capabilities?.codingAgentSetup === true
                  ? <CodingAgentFirstRun
                      projectId={project.id}
                      projectName={project.about?.name ?? project.id}
                      projectPath={project.scope ?? project.path}
                    />
                  : <ProjectAgentDiscovery
                      projectId={project.id}
                      {...(project.about?.name ? { projectName: project.about.name } : {})}
                      projectPath={project.scope ?? project.path}
                      existingAgents={project.agentCount > 0}
                    />}
      </main>
    </div>
  );
}
