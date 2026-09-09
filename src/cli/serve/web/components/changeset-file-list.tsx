import type { ChangesetFile } from '../../../../agents/changeset-types';
import { changesetDiffStat, changesetFileGroups } from '../lib/changeset-view';

/**
 * The left rail of the review page: every file in the proposal, grouped so the
 * agents read first and anything no agent references reads last.
 */
export function ChangesetFileList(props: {
  files: readonly ChangesetFile[];
  selected: string | undefined;
  onSelect: (path: string) => void;
}) {
  const groups = changesetFileGroups(props.files);
  if (groups.length === 0) {
    return <p class="changeset-files-empty">No files in this proposal.</p>;
  }
  return (
    <nav class="changeset-files" aria-label="Files in this changeset">
      {groups.map((group) => (
        <div class="changeset-file-group" key={group.id}>
          <h3 class="changeset-file-group-label">{group.label}</h3>
          <ul>
            {group.files.map((file) => {
              const stat = changesetDiffStat(file);
              const selected = file.path === props.selected;
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    class={`changeset-file-row${selected ? ' is-active' : ''}`}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => props.onSelect(file.path)}
                  >
                    <span class={`changeset-op is-${file.op}`}>{file.op}</span>
                    <span class="changeset-file-path" title={file.path}>{file.path}</span>
                    {stat && (
                      <span class="changeset-file-stat">
                        <span class="draft-added">+{stat.added}</span>{' '}
                        <span class="draft-removed">−{stat.removed}</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
