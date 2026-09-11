import { useMemo } from 'preact/hooks';
import type { ChangesetFile } from '../../../../agents/changeset-types';
import { changesetDiffStat, patchDiffLines } from '../lib/changeset-view';
import { revisionLineDiff } from '../lib/revision-diff';
import { Tabs } from './tabs';

export type ChangesetFileTab = 'diff' | 'source';

/**
 * One file of the proposal: its diff or its full source, plus the two things a
 * reviewer has to see before pressing Apply — what capabilities the file gains
 * or loses, and every static flag the validator raised against it.
 */
export function ChangesetFileView(props: {
  file: ChangesetFile;
  tab: ChangesetFileTab;
  onTab: (tab: ChangesetFileTab) => void;
}) {
  const { file } = props;
  // The stored patch is what the server diffed against the real base. Without
  // one (an added file, or an older record) the whole content is the change.
  const lines = useMemo(
    () => (file.patch ? patchDiffLines(file.patch) : revisionLineDiff('', file.content)),
    [file.path, file.patch, file.content],
  );
  const stat = changesetDiffStat(file);
  const capabilityChanges = file.capabilityChanges ?? [];
  const flags = file.flags ?? [];
  const callers = [...new Set(flags.filter((flag) => flag.startsWith('also used by ')).map((flag) => flag.slice(13)))];
  const propertyLabels: Record<string, string> = {
    'shell script': 'Shell script',
    'manifest': 'Manifest',
    'makes network calls': 'Uses network',
    'reads environment variables': 'Reads environment variables',
  };
  const properties = flags.filter((flag) => propertyLabels[flag]).map((flag) => propertyLabels[flag]);
  const warnings = flags.filter((flag) => !propertyLabels[flag]
    && !flag.startsWith('also used by ')
    && flag !== 'existing project file outside the agent folder'
    && !(callers.length > 0 && flag === 'not referenced by any agent in this changeset'));


  return (
    <section class="changeset-file-view" aria-label={`Changes to ${file.path}`}>
      <Tabs
        idPrefix="changeset-file"
        listWrapClass="changeset-file-head"
        listClass="draft-tabs changeset-file-tabs"
        label="File view"
        value={props.tab}
        onChange={props.onTab}
        head={
          <>
            <code class="changeset-file-title">{file.path}</code>
            <span class={`changeset-op is-${file.op}`}>{file.op}</span>
            {stat && (
              <span class="changeset-file-stat">
                <span class="draft-added">+{stat.added}</span> <span class="draft-removed">−{stat.removed}</span>
              </span>
            )}
          </>
        }
        beforePanels={
          <>
            {file.kind === 'agent' && capabilityChanges.length > 0 && (
              <p class="draft-capability-note">Capability changes: {capabilityChanges.join('; ')}</p>
            )}
            {(properties.length > 0 || callers.length > 0 || warnings.length > 0) && (
              <div class="changeset-file-context">
                {properties.length > 0 && <p class="changeset-file-properties">{properties.join(' · ')}</p>}
                {callers.length > 0 && (
                  <details class="changeset-shared" key={file.path}>
                    <summary>
                      <span>Shared file · Used by {callers.length} other {callers.length === 1 ? 'agent' : 'agents'}</span>
                      <span class="changeset-shared-show">Show</span>
                      <span class="changeset-shared-hide">Hide</span>
                    </summary>
                    <ul>{callers.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
                  </details>
                )}
                {warnings.length > 0 && (
                  <ul class="changeset-file-warnings" aria-label="Review warnings">
                    {warnings.map((flag) => <li key={flag}>{flag}</li>)}
                  </ul>
                )}
              </div>
            )}
          </>
        }
        tabs={[
          {
            id: 'diff' as ChangesetFileTab,
            label: 'Diff',
            mount: 'active',
            panelClass: 'changeset-file-scroll',
            panel: (
              <pre class="draft-file-body is-diff" aria-label="File changes">
                {lines.map((line, index) => (
                  <span class={`is-${line.kind}`} key={`${index}-${line.text}`}>
                    {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : line.kind === 'same' ? '  ' : ''}
                    {line.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            ),
          },
          {
            id: 'source' as ChangesetFileTab,
            label: 'Source',
            mount: 'active',
            panelClass: 'changeset-file-scroll',
            panel: <pre class="draft-file-body" aria-label="File source">{file.content}</pre>,
          },
        ]}
      />
    </section>
  );
}
