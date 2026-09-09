import { useMemo } from 'preact/hooks';
import type { ChangesetFile } from '../../../../agents/changeset-types';
import { changesetDiffStat, patchDiffLines } from '../lib/changeset-view';
import { revisionLineDiff } from '../lib/revision-diff';

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

  return (
    <section class="changeset-file-view" aria-label={`Changes to ${file.path}`}>
      <div class="changeset-file-head">
        <code class="changeset-file-title">{file.path}</code>
        <span class={`changeset-op is-${file.op}`}>{file.op}</span>
        {stat && (
          <span class="changeset-file-stat">
            <span class="draft-added">+{stat.added}</span> <span class="draft-removed">−{stat.removed}</span>
          </span>
        )}
        <div class="draft-tabs changeset-file-tabs" role="tablist" aria-label="File view">
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === 'diff'}
            class={props.tab === 'diff' ? 'is-active' : ''}
            onClick={() => props.onTab('diff')}
          >Diff</button>
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === 'source'}
            class={props.tab === 'source' ? 'is-active' : ''}
            onClick={() => props.onTab('source')}
          >Source</button>
        </div>
      </div>

      {file.kind === 'agent' && capabilityChanges.length > 0 && (
        <p class="draft-capability-note">Capability changes: {capabilityChanges.join('; ')}</p>
      )}
      {flags.length > 0 && (
        <ul class="changeset-flags" aria-label="Review flags">
          {flags.map((flag) => <li class="changeset-flag" key={flag}>{flag}</li>)}
        </ul>
      )}

      <div class="changeset-file-scroll">
        {props.tab === 'source'
          ? <pre class="draft-file-body" aria-label="File source">{file.content}</pre>
          : <pre class="draft-file-body is-diff" aria-label="File changes">
              {lines.map((line, index) => (
                <span class={`is-${line.kind}`} key={`${index}-${line.text}`}>
                  {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : line.kind === 'same' ? '  ' : ''}
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>}
      </div>
    </section>
  );
}
