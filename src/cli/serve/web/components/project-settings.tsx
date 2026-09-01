import { useEffect, useState } from 'preact/hooks';
import { attachExistingProject, fetchInfo, removeProject, type InfoPayload } from '../lib/api';
import { ProjectFolderField } from './project-folder-field';
import { SettingsGroup, SettingsRow } from './settings-layout';

export function RestartOnboardingGroup() {
  return (
    <SettingsGroup title="Onboarding">
      <SettingsRow label="Create or connect a project" hint="Restart the guided setup, then build an agent step by step.">
        <a class="settings-item" href="/onboarding">
          Start onboarding again
        </a>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function ProjectsSettingsGroup() {
  const [info, setInfo] = useState<InfoPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const next = await fetchInfo();
    setInfo(next);
  };

  useEffect(() => {
    refresh().catch((err) => setError((err as Error).message)).finally(() => setLoading(false));
  }, []);

  const add = async (event: Event) => {
    event.preventDefault();
    if (adding || picking || !path.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await attachExistingProject(path.trim());
      setPath('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (projectId: string, label: string) => {
    if (removing || !confirm(`Remove “${label}” from AgentUse?\n\nThe project folder and its files will stay on disk.`)) return;
    setRemoving(projectId);
    setError(null);
    try {
      await removeProject(projectId);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoving(null);
    }
  };

  const folderPickerAvailable = (typeof window !== 'undefined' && Boolean(window.agentuseDesktop?.chooseProjectFolder))
    || info?.capabilities?.projectFolderPicker === true;

  return (
    <>
      <SettingsGroup title="Add project">
        <form class="project-settings-add" onSubmit={add}>
          <ProjectFolderField
            id="settings-project-path"
            value={path}
            pickerAvailable={folderPickerAvailable}
            disabled={adding}
            onChange={setPath}
            onPickingChange={setPicking}
            onError={setError}
          />
          <div class="project-settings-add-footer">
            <small>The folder stays in place. AgentUse only connects it to this server.</small>
            <button type="submit" class="settings-item" disabled={adding || picking || !path.trim()} aria-busy={adding}>
              {adding ? 'Adding…' : 'Add project'}
            </button>
          </div>
        </form>
      </SettingsGroup>
      <SettingsGroup title="Projects">
        <p class="settings-group-hint">Projects connected to this server. Removing one leaves its files untouched.</p>
        <div class="project-settings-list" aria-live="polite">
          {loading && <div class="project-settings-empty">Loading projects…</div>}
          {!loading && info?.projects.length === 0 && <div class="project-settings-empty">No projects are connected yet.</div>}
          {info?.projects.map((project) => {
            const label = project.about?.name ?? project.id;
            return (
              <div class="project-settings-row" key={project.id}>
                <div class="project-settings-copy">
                  <a href={`/agents/${encodeURIComponent(project.id)}`}>{label}</a>
                  <code title={project.scope ?? project.path}>{project.scope ?? project.path}</code>
                  <small>{project.agentCount} {project.agentCount === 1 ? 'agent' : 'agents'} · {project.scheduleCount} {project.scheduleCount === 1 ? 'schedule' : 'schedules'}{info.default === project.id ? ' · Default' : ''}</small>
                </div>
                <button
                  type="button"
                  class="project-settings-remove"
                  disabled={removing !== null}
                  aria-busy={removing === project.id}
                  onClick={() => void remove(project.id, label)}
                >{removing === project.id ? 'Removing…' : 'Remove'}</button>
              </div>
            );
          })}
        </div>
        {error && <div class="project-settings-error" role="alert">{error}</div>}
      </SettingsGroup>
    </>
  );
}
