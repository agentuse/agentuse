/**
 * `submit_changes`, the structured handoff for a multi-file changeset
 * (agentuse-lab #226, #227, #236).
 *
 * The model never passes file content through this call. It writes through the
 * filesystem overlay, which stages every write under
 * `.agentuse/changeset/<id>/edit/` and records the base hash of any real file
 * it touched. This tool walks that folder, rebuilds the `add`/`modify` file
 * set, re-validates everything from scratch, and appends one proposal to the
 * durable record. A rejection comes back as a tool error, so the same session
 * can correct the files and submit again.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { Tool } from 'ai';
import { glob } from 'glob';
import { z } from 'zod';
import { appendChangesetProposal, readChangesetRecord } from '../agents/changeset.js';
import {
  CHANGESET_CAUSES,
  changesetBasePath,
  changesetEditRoot,
  type ChangesetMode,
} from '../agents/changeset-types.js';
import { validateChangesetFiles, type ChangesetInputFile } from '../agents/changeset-validate.js';

export const SUBMIT_CHANGES_TOOL = 'submit_changes';

export interface ChangesetSubmission {
  outcome?: 'proposed' | 'no-change';
}

export interface ChangesetSubmissionContract {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  scopeRoot: string;
  mode: ChangesetMode;
  /** Revise only: project-relative path of the agent the changeset is about. */
  targetPath?: string;
  availableModels: string[];
  availableSkills: string[];
}

export interface SubmitChangesDeps {
  loadedSkillNames?: () => readonly string[];
  /** Web URLs read while producing this proposal, for provenance in review. */
  externalReads?: () => readonly string[];
  /** The create flow's capability review, run once per added agent file. */
  /** Create mode: the host's capability review of each added agent, given the operator's instruction as context. */
  reviewCapabilities?: (agentSource: string, objective: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Read the private contract carried by the in-memory creator/reviser agent.
 * Host-authored, never inferred from model output, so `submit_changes` cannot
 * appear in an ordinary AgentUse run.
 */
export function changesetSubmissionContract(
  metadata: Record<string, unknown> | undefined,
): ChangesetSubmissionContract | undefined {
  if (metadata?.internal !== true || metadata.changeset !== 'agent') return undefined;
  const { sessionId, projectId, projectRoot, scopeRoot, mode, targetPath } = metadata;
  const required = [sessionId, projectId, projectRoot, scopeRoot];
  if (!required.every((value) => typeof value === 'string' && value.length > 0)) return undefined;
  if (mode !== 'create' && mode !== 'revise') return undefined;
  if (targetPath !== undefined && (typeof targetPath !== 'string' || targetPath.length === 0)) return undefined;
  const { availableModels, availableSkills } = metadata;
  if (!Array.isArray(availableModels) || !availableModels.every((value) => typeof value === 'string')) return undefined;
  if (!Array.isArray(availableSkills) || !availableSkills.every((value) => typeof value === 'string')) return undefined;
  return {
    sessionId: sessionId as string,
    projectId: projectId as string,
    projectRoot: projectRoot as string,
    scopeRoot: scopeRoot as string,
    mode,
    ...(typeof targetPath === 'string' && { targetPath }),
    availableModels: availableModels as string[],
    availableSkills: availableSkills as string[],
  };
}

/**
 * One object, not a discriminated union of two. A union converts to a JSON
 * schema with no top-level `type`, which the Anthropic tool API rejects
 * outright, so the outcome-specific fields are optional here and required in
 * `execute`, where a miss returns a readable error to the model.
 */
const changesetSubmissionSchema = z.object({
  outcome: z.enum(['proposed', 'no-change'])
    .describe('proposed when the files you wrote should be reviewed, no-change when the project should stay as it is.'),
  summary: z.string().min(1).max(1000)
    .describe('One plain-language sentence describing the practical outcome, or why nothing should change. Avoid file paths, commands, and internal jargon.'),
  diagnosis: z.string().max(12_000).optional()
    .describe('Explain the problem, cause, and practical effect in plain language. Separate ideas with blank lines; put essential technical details in a separate paragraph or code block. Required in practice for a no-change outcome.'),
  entry: z.string().max(400).optional()
    .describe('Required for proposed: project-relative path of the .agentuse file a test run should execute.'),
  recommendedAction: z.string().max(2000).optional()
    .describe('Required for no-change: explain what the operator should do next in plain language. Use short paragraphs separated by blank lines, or bullets for multiple steps.'),
  cause: z.enum(CHANGESET_CAUSES as [string, ...string[]]).optional()
    .describe('Required for no-change: which layer owns the cause. agent when the agent file or its scripts are wrong; project when the fix belongs in project code outside this agent; setup when a provider, credential, or environment needs changing; agentuse only when the AgentUse runtime itself misbehaved (a tool, the runner, approvals, sessions) in a way no agent edit can work around.'),
}).strict();

type ChangesetSubmissionInput = z.infer<typeof changesetSubmissionSchema>;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/** Every staged file under the edit folder, as project-relative posix paths. */
async function listStagedFiles(editRoot: string): Promise<string[]> {
  const walk = async (dir: string, prefix: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const found: string[] = [];
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) found.push(...await walk(join(dir, entry.name), rel));
      else if (entry.isFile()) found.push(rel);
    }
    return found;
  };
  return (await walk(editRoot, '')).sort();
}

async function readBaseHashes(basePath: string): Promise<Record<string, string>> {
  const raw = await readFile(basePath, 'utf8').catch(() => undefined);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const hashes: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') hashes[key] = value;
    }
    return hashes;
  } catch {
    return {};
  }
}

/** Reader bound to the served scope; refuses anything that escapes it. */
export function projectFileReader(scopeRoot: string): (relPath: string) => Promise<string | undefined> {
  const root = resolve(scopeRoot);
  return async (relPath) => {
    if (isAbsolute(relPath)) return undefined;
    const absolute = resolve(root, relPath);
    const inside = relative(root, absolute);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
    try {
      return await readFile(absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
}

export async function listProjectAgents(scopeRoot: string): Promise<string[]> {
  const matches = await glob('**/*.agentuse', {
    cwd: scopeRoot,
    nodir: true,
    dot: true,
    follow: false,
    ignore: ['.agentuse/**', 'node_modules/**', '.git/**'],
  });
  return matches.map(toPosix).sort();
}

/**
 * Rebuild the proposed file set from the staged edit folder. A `modify` whose
 * real file no longer matches the base the overlay recorded means the project
 * moved under the session, which no amount of correcting the files can fix.
 */
async function collectStagedFiles(
  contract: ChangesetSubmissionContract,
): Promise<ChangesetInputFile[]> {
  const editRoot = changesetEditRoot(contract.projectRoot, contract.sessionId);
  const staged = await listStagedFiles(editRoot);
  if (staged.length === 0) {
    throw new Error('No files were written. Write the agent files first, then call submit_changes.');
  }
  const baseHashes = await readBaseHashes(changesetBasePath(contract.projectRoot, contract.sessionId));
  const readProjectFile = projectFileReader(contract.scopeRoot);

  const files: ChangesetInputFile[] = [];
  for (const path of staged) {
    const content = await readFile(join(editRoot, ...path.split('/')), 'utf8');
    const baseHash = baseHashes[path];
    if (baseHash === undefined) {
      files.push({ path, op: 'add', baseHash: null, content });
      continue;
    }
    const baseContent = await readProjectFile(path);
    if (baseContent === undefined || sha256(baseContent) !== baseHash) {
      throw new Error(`${path} changed after this session started. Stop and ask the operator to start a new session from the current source.`);
    }
    files.push({ path, op: 'modify', baseHash, content, baseContent });
  }
  return files;
}

/**
 * A creator/reviser-only structured handoff. Validation runs inside the tool
 * call, so a rejected change set returns to the model as a tool error while the
 * session still has project context and steps left for a correction.
 */
export function createSubmitChangesTool(
  submission: ChangesetSubmission,
  contract: ChangesetSubmissionContract,
  deps: SubmitChangesDeps = {},
): Tool {
  let submissionInProgress = false;
  return {
    description:
      'Submit the files you already wrote in this project as one change set for operator review, or report that nothing should change. '
      + 'Do not paste file content into this call: the host reads the files from the project itself. '
      + 'The host validates every file and its cross-file references; if the call is rejected, correct the files and call this tool again. '
      + 'After it is accepted, call report_complete with a short headline and no source.',
    inputSchema: changesetSubmissionSchema,
    execute: async (input: ChangesetSubmissionInput, options?: { abortSignal?: AbortSignal }) => {
      if (submissionInProgress) {
        throw new Error('A change set is already being reviewed. Wait for its result before submitting another.');
      }
      submissionInProgress = true;
      try {
        const record = await readChangesetRecord(contract.projectRoot, contract.sessionId);
        if (!record || record.status !== 'running') throw new Error('This change set is no longer active');
        if (
          record.sessionId !== contract.sessionId
          || record.projectId !== contract.projectId
          || record.scopeRoot !== contract.scopeRoot
          || record.mode !== contract.mode
          || record.target?.path !== contract.targetPath
        ) {
          throw new Error('The private changeset contract does not match its durable host record');
        }

        const loadedSkills = [...(deps.loadedSkillNames?.() ?? [])];
        const externalReads = [...(deps.externalReads?.() ?? [])];
        const diagnosis = input.diagnosis?.trim();

        if (input.outcome === 'no-change') {
          const recommendedAction = input.recommendedAction?.trim();
          if (!recommendedAction) {
            throw new Error('A no-change outcome requires a recommendedAction. Add it and call submit_changes again.');
          }
          if (!input.cause) {
            throw new Error('A no-change outcome requires a cause: agent, project, setup, or agentuse. Add it and call submit_changes again.');
          }
          await appendChangesetProposal(contract.projectRoot, contract.sessionId, {
            reply: recommendedAction,
            ...(diagnosis && { diagnosis }),
            cause: input.cause as (typeof CHANGESET_CAUSES)[number],
            files: [],
            ...(loadedSkills.length > 0 && { loadedSkills }),
            ...(externalReads.length > 0 && { externalReads }),
          });
          submission.outcome = 'no-change';
          return 'Accepted: the no-change diagnosis is ready for operator review. Call report_complete with a short headline and no source.';
        }

        const entry = input.entry?.trim();
        if (!entry) {
          throw new Error('A proposed outcome requires an entry: the project-relative path of the .agentuse file a test run should execute. Add it and call submit_changes again.');
        }
        const summary = input.summary.trim();
        const staged = await collectStagedFiles(contract);

        let files;
        try {
          files = await validateChangesetFiles({
            mode: contract.mode,
            scopeRoot: contract.scopeRoot,
            projectRoot: contract.projectRoot,
            ...(contract.targetPath && { target: { path: contract.targetPath } }),
            entry: posix.normalize(entry).replace(/^\.\//u, ''),
            files: staged,
            availableModels: contract.availableModels,
            availableSkills: contract.availableSkills,
            ...(deps.loadedSkillNames && { loadedSkills }),
            readProjectFile: projectFileReader(contract.scopeRoot),
            listProjectAgents: () => listProjectAgents(contract.scopeRoot),
          });
        } catch (error) {
          throw new Error(`Changes rejected: ${(error as Error).message}. Correct the files and call submit_changes again.`);
        }

        if (deps.reviewCapabilities) {
          for (const file of files) {
            if (file.kind !== 'agent' || file.op !== 'add') continue;
            options?.abortSignal?.throwIfAborted();
            try {
              await deps.reviewCapabilities(file.content, record.instruction, options?.abortSignal);
            } catch (error) {
              // The review is a separate 60s-capped model call. When the
              // provider stalls, the session must not burn its own budget on
              // an opaque abort: tell the model exactly what to do next.
              if (options?.abortSignal?.aborted) throw error;
              const message = (error as Error).message;
              if (/abort|timeout/iu.test(message)) {
                throw new Error(`Capability review of ${file.path} timed out before finishing. The files were not rejected; call submit_changes again to rerun the review.`);
              }
              throw new Error(`Changes rejected: ${file.path}: ${message}. Correct the files and call submit_changes again.`);
            }
          }
          options?.abortSignal?.throwIfAborted();
        }

        await appendChangesetProposal(contract.projectRoot, contract.sessionId, {
          reply: summary,
          ...(diagnosis && { diagnosis }),
          entry: posix.normalize(entry).replace(/^\.\//u, ''),
          files,
          ...(loadedSkills.length > 0 && { loadedSkills }),
          ...(externalReads.length > 0 && { externalReads }),
        });
        submission.outcome = 'proposed';
        const names = files.map((file) => `${file.op === 'add' ? '+' : '~'}${file.path}`).join(', ');
        return `Accepted: ${files.length} file${files.length === 1 ? '' : 's'} passed validation (${names}) and are ready for operator review. Call report_complete with a short headline and no source.`;
      } finally {
        submissionInProgress = false;
      }
    },
  };
}
