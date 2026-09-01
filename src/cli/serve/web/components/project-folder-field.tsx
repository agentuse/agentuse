import { useState } from 'preact/hooks';
import { pickProjectFolder } from '../lib/api';

interface ProjectFolderFieldProps {
  id: string;
  value: string;
  pickerAvailable: boolean;
  disabled?: boolean;
  autofocus?: boolean;
  onChange: (path: string) => void;
  onPickingChange?: (picking: boolean) => void;
  onError?: (message: string) => void;
}

/** Shared project-directory input for onboarding and Settings. The API helper
 *  selects Desktop IPC when hosted by the Mac app and the guarded native
 *  server picker for local Web, so consumers do not need host-specific logic. */
export function ProjectFolderField(props: ProjectFolderFieldProps) {
  const [picking, setPicking] = useState(false);

  const chooseFolder = async () => {
    if (picking || props.disabled || !props.pickerAvailable) return;
    setPicking(true);
    props.onPickingChange?.(true);
    try {
      const selected = await pickProjectFolder();
      if (selected) props.onChange(selected);
    } catch (err) {
      props.onError?.((err as Error).message || 'Could not open the folder chooser.');
    } finally {
      setPicking(false);
      props.onPickingChange?.(false);
    }
  };

  return (
    <>
      <label class="project-folder-field-label" for={props.id}>Project folder path</label>
      <div class="project-folder-field">
        <input
          id={props.id}
          value={props.value}
          placeholder="Choose a folder or enter its path"
          autofocus={props.autofocus}
          disabled={props.disabled || picking}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
        {props.pickerAvailable && (
          <button
            type="button"
            class="project-folder-choose"
            disabled={props.disabled || picking}
            aria-busy={picking}
            onClick={() => void chooseFolder()}
          >{picking ? 'Choosing…' : 'Choose folder…'}</button>
        )}
      </div>
    </>
  );
}
