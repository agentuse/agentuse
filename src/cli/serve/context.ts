/**
 * The shared state every serve route group closes over.
 *
 * `createServeCommand()` used to hold the whole HTTP route table inline, so the
 * routes simply reached for the locals around them. The route modules under
 * routes/ take those same locals through this one explicit context instead, so
 * each group can live in its own file without duplicating any state.
 *
 * Nothing here is new behaviour: every member is the same object, closure, or
 * value the inline route table used, passed by reference.
 */
import type { IncomingMessage, ServerResponse } from "http";
import type { Scheduler } from "../../scheduler";
import type { FileWatcher } from "../../watcher";
import type { AboutInfo } from "./about";
import type { PushCategory, PushPayload, PushService } from "./push";
import type { ApprovalEventHub, ApprovalListEventHub, NotificationEventHub } from "./sse";
import type { WebAssets } from "./static";
import type { AgentSummary } from "./agents-data";
import type { Project } from "./project";
import type { SessionPurpose } from "./types";
import type { AgentDraftRecord } from "../../agents/draft";
import type { AgentRevisionRecord } from "../../agents/revision";
import type { ChangesetProposal, ChangesetRecord } from "../../agents/changeset-types";
import type { RecoveredAgentSourceSubmission } from "../../onboarding/internal-job-store.js";
import type { AgentWorker, BackgroundSessionFailure, WorkerPreparingSessionResult } from "../serve";
import type { ApprovalListPayload, SessionsPayload } from "./list-payloads";
import type { AgentCreationRecoveryInput, OnboardingModelJob, PersistedOnboardingModelJob } from "./internal-jobs";
import type { RunRequest } from "./run-request";
import type { SessionStatusInfo, WorkerApprovalInfoResult } from "./session-types";
import type { startOrphanReconcileLoop } from "./orphan-reconcile";
import type { WorkerExecuteError } from "./worker-types";
import type { SessionTrigger } from "../../session/types";

/** A learning captured from a `remember` correction, ready to persist. */
export interface RememberedLearningTarget {
  agentFilePath: string;
  stateRoot: string;
  instruction: string;
  model?: string | undefined;
  agentInstructions?: string | undefined;
  sessionTranscript?: string | undefined;
  sessionId?: string | undefined;
  cap?: number | undefined;
}

/** Native notification fan-out payload (the desktop app's SSE feed). */
export interface NativeNotificationEvent {
  category: PushCategory;
  payload: Pick<PushPayload, "title" | "body" | "url" | "tag" | "appBadge">;
}

/**
 * The handful of daemon locals that routes REASSIGN rather than mutate in
 * place. They were `let` bindings in the inline route table; a shared object
 * keeps every reader and writer pointed at the same cell across modules.
 */
export interface ServeMutableState {
  /** True once more than one project is loaded (attach/detach move it). */
  multiProject: boolean;
  /** Project id new runs fall back to; cleared when that project detaches. */
  effectiveDefault: string | undefined;
  /** Serializes attach/detach so two project mutations never interleave. */
  projectMutationInFlight: boolean;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
}

export interface ServeContext {
  // --- identity / config -------------------------------------------------
  /** The parsed `agentuse serve` flags, as commander handed them over. */
  options: { debug?: boolean };
  apiKey: string | undefined;
  serverUrl: string;
  effectivePublicUrl: string;
  effectiveHost: string;
  effectiveHideAgentSource: boolean;
  brandNameCfg: string | undefined;
  manifestJson: string;
  serverStartTime: number;
  state: ServeMutableState;

  // --- projects ----------------------------------------------------------
  projects: Project[];
  projectsById: Map<string, Project>;
  projectSeeds: Array<Omit<Project, "agentFiles">>;
  agentCounts: Map<string, number>;
  idSeen: Map<string, string>;
  pathSeen: Map<string, string>;
  fileWatchers: FileWatcher[];
  projectWatchers: Map<string, FileWatcher>;
  attachProject: (seed: Omit<Project, "agentFiles">) => Promise<{ project: Project; rollback: () => Promise<void> }>;
  onboardingProjectInfo: (project: Project) => Promise<{
    id: string;
    path: string;
    agentCount: number;
    scheduleCount: number;
    about?: AboutInfo;
  }>;
  updateRegistryCounts: () => void;
  refreshProjectLists: (
    project: { id: string; root: string },
    options?: { externalActivity?: boolean },
  ) => Promise<void>;
  resolveRequestProject: (
    body: RunRequest,
  ) =>
    | { project: Project }
    | { error: { status: number; code: string; message: string; extra?: Record<string, unknown> } };

  // --- workers -----------------------------------------------------------
  workers: Map<string, AgentWorker>;
  testRunWorkers: Map<string, AgentWorker>;
  workerReadyAt: Map<string, number>;
  resetWorkerProviderPlugins: () => Promise<void>;

  // --- scheduling --------------------------------------------------------
  scheduler: Scheduler;
  pausedSchedulesByProject: Map<string, Set<string>>;
  schedulerLocksHeld: Set<string>;
  scheduleIsEnabled: (project: Project | Omit<Project, "agentFiles">, agentPath: string) => boolean;
  canArmSchedules: (projectId: string, projectRoot: string) => boolean;
  orphanReconcileLoop: ReturnType<typeof startOrphanReconcileLoop>;

  // --- static / push / SSE ----------------------------------------------
  staticAssets: WebAssets;
  pushService: PushService;
  notificationHub: NotificationEventHub<NativeNotificationEvent>;
  approvalHub: ApprovalEventHub;
  approvalListHub: ApprovalListEventHub<ApprovalListPayload>;
  sessionListHub: ApprovalListEventHub<SessionsPayload>;
  deliverNotification: (category: PushCategory, payload: PushPayload) => Promise<void>;
  wakeListHubs: () => void;

  // --- session / approval lookup ----------------------------------------
  findApprovalInfo: (options: {
    projectId?: string;
    sessionId: string;
    resumeToken: string;
    allowHistorical?: boolean;
  }) => Promise<
    | { success: true; project: Project; info: WorkerApprovalInfoResult }
    | { success: false; status: number; code: string; message: string }
  >;
  findSessionInfo: (
    sessionId: string,
    projectId?: string,
  ) => Promise<
    | { success: true; project: Project; info: WorkerApprovalInfoResult }
    | { success: false; status: number; code: string; message: string }
  >;
  findSessionStatusInfo: (
    sessionId: string,
    projectId?: string,
  ) => Promise<
    | { success: true; project: Project; session: SessionStatusInfo }
    | { success: false; status: number; code: string; message: string }
  >;
  sessionPurposeFor: (
    project: { id: string; root: string } | undefined,
    sessionId: string,
  ) => Promise<SessionPurpose | null>;
  buildSessionsPayload: (
    requestUrl: URL,
  ) => Promise<
    | { success: true; payload: SessionsPayload }
    | { success: false; status: number; code: string; message: string }
  >;
  buildApprovalListPayload: (
    requestUrl: URL,
  ) => Promise<
    | { success: true; payload: ApprovalListPayload }
    | { success: false; status: number; code: string; message: string }
  >;

  // --- approval / continuation lifecycle --------------------------------
  activeApprovalResumes: Map<string, Promise<unknown>>;
  activeSessionContinuations: Map<string, Promise<unknown>>;
  activeCascadeRecoveries: Set<string>;
  backgroundSessionFailures: Map<string, BackgroundSessionFailure>;
  loggedApprovalRequests: Map<string, number>;
  notifiedFinishedSessions: Map<string, number>;
  approvalActionSessionId: (info: WorkerApprovalInfoResult, fallbackSessionId: string) => string;
  applyResumeError: <T extends { errorMessage?: string; sessionStatus?: string }>(
    approvalObj: T,
    activeKey: string,
  ) => T;
  validateDecisionChoice: (
    info: WorkerApprovalInfoResult,
    status: string,
    choice: string | undefined,
  ) => { code: string; message: string } | null;
  startApprovalResume: (
    res: ServerResponse,
    params: {
      project: Project;
      sessionId: string;
      info: WorkerApprovalInfoResult;
      resumeToken: string;
      status: string;
      comment?: string | undefined;
      choice?: string | undefined;
      responseExtra?: Record<string, unknown> | undefined;
      onResumeFailure?: (() => void) | undefined;
    },
  ) => void;
  startSessionContinue: (
    res: ServerResponse,
    params: { project: Project; sessionId: string; prompt: string },
  ) => void;
  startCascadeRetry: (res: ServerResponse, params: { project: Project; sessionId: string }) => void;

  // --- learnings ---------------------------------------------------------
  readRememberField: (body: Record<string, unknown>) => string | undefined;
  resolveRememberedLearning: (
    info: WorkerApprovalInfoResult,
    remember: string | undefined,
    sessionId: string,
  ) => Promise<RememberedLearningTarget | null>;
  persistRememberedLearning: (target: RememberedLearningTarget | null) => void;

  // --- internal (onboarding / creation / revision) jobs ------------------
  onboardingJobs: Map<string, OnboardingModelJob>;
  agentCreationRecoveryInputs: Map<string, AgentCreationRecoveryInput>;
  internalViewCleanups: Map<string, () => Promise<void>>;
  revisionMutations: Set<string>;
  draftMutations: Set<string>;
  changesetMutations: Set<string>;
  preferredAgentCreationModel: string | undefined;
  cleanupInternalView: (sessionId: string) => Promise<void>;
  pruneOnboardingJobs: () => void;
  persistOnboardingJob: (job: OnboardingModelJob) => Promise<void>;
  loadPersistedOnboardingJob: (id: string) => Promise<PersistedOnboardingModelJob | null>;
  beginInternalAgentJob: (options: {
    job: OnboardingModelJob;
    worker: AgentWorker;
    project: Project;
    agentId: string;
    agentName: string;
    agentDescription: string;
    timeout: number;
    maxSteps: number;
    trigger: SessionTrigger;
  }) => Promise<WorkerPreparingSessionResult | WorkerExecuteError>;
  recoverAgentCreationJob: (job: OnboardingModelJob, missingIsInterrupted?: boolean) => Promise<void>;
  recoverProjectDiscoveryJob: (job: OnboardingModelJob, missingIsInterrupted?: boolean) => Promise<void>;
  resolveAgentCreationRecovery: (jobId: string, record: AgentDraftRecord) => Promise<AgentCreationRecoveryInput>;
  finishAgentCreation: (
    project: Project,
    recovery: AgentCreationRecoveryInput,
    submission: Pick<RecoveredAgentSourceSubmission, "source" | "name" | "fileName">,
  ) => Promise<{ success: true; agent: AgentSummary }>;
  draftViewPayload: (
    project: Project,
    record: AgentDraftRecord,
  ) => AgentDraftRecord & { sessionToken?: string; sessionHref: string };
  reconcileAgentDraftRecord: (project: Project, record: AgentDraftRecord) => Promise<AgentDraftRecord>;
  reconcileAgentRevisionRecord: (project: Project, record: AgentRevisionRecord) => Promise<AgentRevisionRecord>;
  reconcileChangesetRecord: (project: Project, record: ChangesetRecord) => Promise<ChangesetRecord>;
  startMockTestRun: (
    project: Project,
    candidate: { source: string; name: string; fileName: string; model: string; index: number },
    onSettled?: (
      sessionId: string,
      outcome: { status: "completed" | "error"; error?: { code: string; message: string } },
    ) => Promise<void>,
  ) => Promise<{ sessionId: string; draftIndex: number; sessionToken?: string }>;
  startChangesetTestRun: (
    project: Project,
    record: ChangesetRecord,
    proposal: ChangesetProposal,
  ) => Promise<{ sessionId: string; proposalIndex: number; sessionToken?: string }>;
  settleStaleChangesetTestRuns: (project: Project, record: ChangesetRecord) => Promise<ChangesetRecord>;
}

/**
 * Everything a single in-flight request carries, computed once by the dispatch
 * prologue in serve.ts and handed to each route group in turn.
 */
export interface ServeRequest {
  req: IncomingMessage;
  res: ServerResponse;
  requestUrl: URL;
  /** True when the caller used the canonical `/api/*` prefix (JSON surface). */
  isApi: boolean;
  /** Request path with any `/api` prefix stripped. */
  routePath: string;
  requestOrigin: string | undefined;
  crossOrigin: boolean;
  /** Capability auth for `/sessions/:id` and its action subroutes. */
  sessionAuthorized: (sessionId: string, token?: string) => boolean;
}

/**
 * A route group. Returns true when it answered the request, false to let the
 * next group in the chain try — mirroring the fall-through order of the
 * original inline if-chain exactly.
 */
export type ServeRouteGroup = (ctx: ServeContext, rq: ServeRequest) => boolean | Promise<boolean>;
