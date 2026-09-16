import { ApprovalPageInfo } from "./approval-page";
/**
 * What the worker answers when the daemon asks about one session: its full
 * approval/log payload, and the lighter status-only view. Moved out of serve.ts.
 */


export interface WorkerApprovalInfoResult {
  success: true;
  approval: ApprovalPageInfo;
}

export interface SessionStatusInfo {
  sessionId: string;
  sessionStatus: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
  };
  errorCause?: string;
  errorCode?: string;
  errorMessage?: string;
  mock?: boolean;
}
