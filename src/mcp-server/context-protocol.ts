/** Shared wire contract for the Cloud destination picker. Kept import-free for mirroring. */
export const CONTEXT_PICKER_URI = 'ui://agentuse/context-picker';
export const CHOOSE_CONTEXT_TOOL = 'choose_context';

export interface MachineChoice {
  id: string;
  name: string;
  online: boolean;
  platform?: string;
}

export interface ProjectChoice {
  id: string;
  name: string;
  description?: string;
  agent_count?: number;
}

export interface ChooseContextArgs {
  machine_id?: string;
  project?: string;
  context?: string;
}

export interface ContextPickerResult {
  machines: MachineChoice[];
  machine_id?: string;
  projects?: ProjectChoice[];
  project?: string;
  context?: string;
  selection?: {
    machine: { id: string; name: string };
    project: { id: string; name: string };
  };
  setup_url?: string;
  error?: { code: string; message: string };
}
