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

/** Cloud's setup card: works before sign-in and reports whether AgentUse is ready. */
export const GET_STARTED_URI = 'ui://agentuse/get-started';
export const GET_STARTED_TOOL = 'get_started';

export interface GetStartedArgs {
  /** The user's original request, picked up again once AgentUse is ready. */
  request?: string;
}

export interface GetStartedMachine {
  id: string;
  name: string;
  online: boolean;
  /** Milliseconds since the epoch. */
  lastSeen?: number;
}

export interface GetStartedResult {
  state: 'sign_in' | 'no_machine' | 'ready' | 'offline';
  account?: string;
  machine?: GetStartedMachine;
  machines?: GetStartedMachine[];
  project?: string;
  connect_url: string;
  download_url: string;
  install_command: string;
  request?: string;
  /** The app calling, when Cloud can tell from the request: it decides how sign-in works there. */
  client?: 'codex' | 'claude-code';
}
