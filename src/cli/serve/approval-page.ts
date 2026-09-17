/**
 * The approval payload a session page renders, and the token accounting that
 * rides along with it. Moved verbatim out of serve.ts.
 */
import type { ImportantDescendantEvent, ImportantDescendantSummary } from "../../session/important-descendants";
import type { ActiveContextUsage, ReviewEscalation } from "../../session/types";
import { ApprovalLogEntry, ChildSessionSummary } from "./session-log";

export interface ApprovalPageInfo {
  sessionId: string;
  sessionStatus: string;
  approvalKind?: 'await_human' | 'tool_approval';
  toolApproval?: {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    canonicalInput: string;
    canonicalInputDigest: string;
    signedRawInput: string;
    signedRawInputDigest: string;
    signature?: string;
  };
  /** Resolved project id, stamped by the serve daemon (see findApprovalInfo). */
  project?: string;
  /** Absolute directory watched for agent files, stamped by the serve daemon. */
  projectPath?: string;
  createdAt?: number;
  model?: string;
  agent: {
    id: string;
    name: string;
    filePath?: string;
    /** Scope-relative path of the agent file, stamped by the serve daemon so the
     *  session page can link to the agent detail hub (see findApprovalInfo). */
    runPath?: string;
    description?: string;
  };
  learning?: {
    capture: boolean;
    apply: boolean;
  };
  prompt?: string;
  summary?: string;
  draft?: string;
  /** Mirrors what the normalizer actually produces (buildAwaitHumanDetails in
   *  src/index.ts): the runtime has carried `displayContent` and `optionId`
   *  since gates grew commands and options, and declaring the narrower shape
   *  here silently dropped both for every consumer that trusts this type. */
  changes?: Array<{ label?: string; content: string; displayContent?: string; displayParts?: string[]; optionId?: string }>;
  reference?: { label?: string; author?: string; title?: string; url?: string; excerpt?: string };
  options?: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
  draftUrl?: string;
  artifactUrl?: string;
  context?: string;
  risk?: string;
  /** Strict automated review exhausted; approval stays blocked while the reviewer guides another revision. */
  reviewEscalation?: ReviewEscalation;
  surface?: string;
  approvalUrl?: string;
  currentResumeToken?: string;
  expiresAt?: number;
  suspendedAt?: number;
  channelMessage?: {
    type?: string;
    channel?: string;
    ts?: string;
    actionTs?: string;
    url?: string;
  };
  decision?: unknown;
  errorCode?: string;
  errorMessage?: string;
  /** Resume the parent by retrying its interrupted delegated child. */
  cascadeRetryable?: boolean;
  childSessions?: ChildSessionSummary[];
  importantDescendants?: ImportantDescendantSummary[];
  importantDescendantEvents?: ImportantDescendantEvent[];
  originAgent?: {
    id: string;
    name: string;
    filePath?: string;
    description?: string;
  };
  viewOnly?: boolean;
  rootSessionId?: string;
  parentSessionId?: string;
  parentAgentName?: string;
  parentHref?: string;
  tokenUsage?: SessionTokenUsage;
  timing?: {
    calculatedAt: number;
    wallMs: number;
    activeMs: number | null;
    running: boolean;
    approvalMs: number;
    approvalCount: number;
  };
  logs?: ApprovalLogEntry[];
  mock?: boolean;
}

export interface SessionTokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  context?: ActiveContextUsage;
}
