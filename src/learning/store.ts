import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, relative, basename, isAbsolute } from 'path';
import { randomUUID, createHash } from 'crypto';
import type { Learning, LearningCategory, LearningDraft, LearningSource, LearningState } from './types';
import { learningSourceRank, rankLearnings } from './ranking';
import { getProjectDirSync, sanitizeAgentName } from '../storage/paths';
import { computeAgentId } from '../utils/agent-id';
import { logger } from '../utils/logger';
import { withOwnershipLock } from '../utils/ownership-lock';
import { atomicWriteFile } from '../utils/atomic-write';

// Serialize read-modify-write sequences on the same learnings file so two
// concurrent saves (e.g. two serve approval decisions on the same agent) can't
// clobber each other. The promise chain orders callers in this process; the
// ownership lock orders the runner, serve daemon, and CLI across processes.
const fileLocks = new Map<string, Promise<unknown>>();
export async function withLearningFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const locked = () => withOwnershipLock(`${key}.lock`, fn, { label: 'learnings' });
  const run = prev.then(locked, locked); // run fn once, after prev settles either way
  fileLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

/** Collision-checked 8-char hex id (randomUUID is always long enough, unlike
 *  Math.random().toString(36) which can yield 1-char ids like from 0.5). */
export function generateLearningId(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  let id = randomUUID().replace(/-/g, '').slice(0, 8);
  while (taken.has(id)) id = randomUUID().replace(/-/g, '').slice(0, 8);
  return id;
}

/** Local-timezone YYYY-MM-DD (new Date().toISOString().slice(0,10) drifts to
 *  UTC, showing the wrong calendar day for non-UTC reviewers). */
function toLocalDate(iso: string): string {
  // An already-serialized date is local and must pass through untouched. `new
  // Date('2026-07-30')` parses as UTC midnight, so re-converting it to local
  // walks the day backwards in any negative UTC offset. Every save re-serializes
  // every entry, so without this guard each write aged the whole file by a day:
  // in PDT a learning saved on four runs read as four days older than it was.
  // Harmless while dates were decorative; not once ranking sorts by them.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;

  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The key one agent's corrections file is stored under, inside the project's
 * learnings directory.
 *
 * Normally {@link computeAgentId} — the project-relative path minus the
 * extension — so learnings, sessions and stores all key an agent the same way,
 * and subdirectories keep two `write.agentuse` files apart.
 */
function learningKey(agentFilePath: string, stateRoot: string, agentName?: string): string {
  // A URL or stdin agent has no path to key on, so its own name is the only
  // stable identifier there is.
  if (!agentFilePath || /^https?:\/\//i.test(agentFilePath)) {
    if (!agentName) {
      throw new Error(
        `Cannot resolve a learnings file for "${agentFilePath || '(no agent file)'}" without an agent name`
      );
    }
    return sanitizeAgentName(agentName);
  }

  const absolute = resolve(agentFilePath);
  // Falling back to the absolute path means a missing stateRoot lands in the
  // digest branch below rather than producing an id that escapes the directory.
  const id = computeAgentId(absolute, stateRoot, absolute);
  if (id && !id.startsWith('..') && !isAbsolute(id)) return id;

  // The agent file sits outside the state root, so `relative()` walked up out of
  // the tree and there is no project-relative id. Key by name plus a digest of
  // the absolute path — the same shape, for the same reason, as the
  // consolidation snapshot directory.
  const digest = createHash('sha256').update(absolute).digest('hex').slice(0, 8);
  return `${sanitizeAgentName(basename(absolute, '.agentuse'))}-${digest}`;
}

/**
 * Where an agent's corrections file lives:
 * `{projectDir(stateRoot)}/learnings/{agentId}.learnings.md`.
 *
 * One computed path — no fallbacks, no config key, and deliberately not the old
 * sibling `{agent}.learnings.md`. The file is generated state that every run
 * rewrites, so it belongs beside the session logs in the AgentUse state
 * directory rather than in the user's repository.
 *
 * Anchored on `stateRoot` (agent-file-derived) rather than the cwd-derived
 * project root, so one agent resolves to one file whichever shell it ran from.
 */
export function resolveLearningFilePath(
  agentFilePath: string,
  stateRoot: string,
  agentName?: string
): string {
  return join(
    getProjectDirSync(stateRoot),
    'learnings',
    `${learningKey(agentFilePath, stateRoot, agentName)}.learnings.md`
  );
}

/**
 * Where corrections used to live, before they moved into the state directory:
 * `{agent-dir}/{agent-basename}.learnings.md`. Reproduces the pre-0.17 resolver,
 * which stripped only a `.md` extension — so `x.agentuse` paired with
 * `x.agentuse.learnings.md`, and the rarer `x.md` with `x.learnings.md`.
 *
 * Nothing reads this file. It exists so we can *notice* one and say so, and so
 * `learnings migrate` can move it. Those two must agree on the path or the
 * notice points at a file the migration will not find, which is why there is one
 * implementation here rather than a copy in each caller.
 */
export function legacyLearningFilePath(agentFilePath: string): string {
  const absolute = resolve(agentFilePath);
  return join(dirname(absolute), `${basename(absolute, '.md')}.learnings.md`);
}

/** Project-relative when the path is inside the project, absolute otherwise.
 *  A warning that prints the operator's home directory is both harder to read
 *  and, in a shared serve session view, more than the reader asked for. */
function displayPath(target: string, root: string): string {
  const rel = relative(root, target);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target;
}

/**
 * Where this agent's learnings are stranded, ready to show a reader, or `null`
 * when nothing is stranded.
 *
 * Reads the sibling's EXISTENCE and nothing else — never its contents, never an
 * entry count. That is what keeps this a notice rather than a compatibility
 * path: behaviour is byte-identical whether or not the old file is there, so it
 * is not a second source of authority and has no expiry date attached to it.
 *
 * The single detector behind all three surfaces that report this — the run
 * warning, `doctor`, and the web learnings panel. They must agree, because a
 * surface that stays quiet is read as "nothing stranded here".
 */
export function strandedLearningsFile(agentFilePath: string, stateRoot: string): string | null {
  // A URL or stdin agent never had a sibling file to leave behind.
  if (!agentFilePath || /^https?:\/\//i.test(agentFilePath)) return null;

  const sibling = legacyLearningFilePath(resolve(agentFilePath));
  return existsSync(sibling) ? displayPath(sibling, stateRoot) : null;
}

/**
 * The "your learnings are somewhere we no longer look" notice, or `null` when
 * there is nothing to say.
 *
 * It exists because the alternative is worse than a missing feature: an
 * unwatched scheduled fleet silently dropping forty learnings and continuing as
 * though it never had any.
 *
 * Deliberately NOT gated on whether the keyed file already exists. An agent that
 * captured one learning after upgrading has a populated new file and forty still
 * stranded beside it — exactly the state where going quiet does the most damage,
 * because the panel now shows learnings and everything looks healthy.
 */
export function strandedLearningsNotice(agentFilePath: string, stateRoot: string): string | null {
  const sibling = strandedLearningsFile(agentFilePath, stateRoot);
  if (!sibling) return null;

  return [
    `learnings found at the old location for ${displayPath(resolve(agentFilePath), stateRoot)}`,
    `  ${sibling}`,
    `  No longer read. Move them:  agentuse learnings migrate --all`,
  ].join('\n');
}

/** Agents already reported on in this process. */
const legacyNoticeGiven = new Set<string>();

/**
 * {@link strandedLearningsNotice}, but only the first time it is asked about a
 * given agent; `null` on every later call.
 *
 * Consuming rather than merely returning is what makes "warn once" a property of
 * the notice itself instead of a rule each caller has to remember. A single run
 * loads a store several times (injection, capture, ranking), and `doctor` both
 * loads a store and prints its own diagnostic line — one notice per agent per
 * process, whichever of them asks first.
 */
export function takeLegacyLearningsNotice(agentFilePath: string, stateRoot: string): string | null {
  const key = `${resolve(agentFilePath)}\0${stateRoot}`;
  // Record the question, not just the answer, so an agent with no old file
  // doesn't re-stat it on every load for the life of the process.
  if (legacyNoticeGiven.has(key)) return null;
  legacyNoticeGiven.add(key);
  return strandedLearningsNotice(agentFilePath, stateRoot);
}

/** The agent a store was built from, kept only so an empty load can point at
 *  corrections stranded at the old location. */
interface LegacyNoticeSource {
  agentFilePath: string;
  stateRoot: string;
}

/**
 * Store for managing agent learnings in markdown format
 */
export class LearningStore {
  public readonly filePath: string;
  private readonly legacySource: LegacyNoticeSource | undefined;

  constructor(filePath: string, legacySource?: LegacyNoticeSource) {
    this.filePath = filePath;
    this.legacySource = legacySource;
  }

  /**
   * @param stateRoot the agent file's own project root (`resolveProjectContext`),
   *   not the cwd-derived one — it decides which project directory the
   *   corrections live in.
   * @param agentName only used for a URL/stdin agent, which has no path to key on.
   */
  static fromAgentFile(agentFilePath: string, stateRoot: string, agentName?: string): LearningStore {
    const filePath = resolveLearningFilePath(agentFilePath, stateRoot, agentName);
    return new LearningStore(filePath, { agentFilePath, stateRoot });
  }

  async load(): Promise<Learning[]> {
    // Asked on every load, not only an empty one. An agent that captured a
    // learning after upgrading loads a non-empty store and still has the old
    // file beside it; that is the case worth warning about, not the easy one.
    this.reportLegacyLocationOnce();
    if (!existsSync(this.filePath)) return [];

    const content = await readFile(this.filePath, 'utf-8');
    return this.parseMarkdown(content);
  }

  /**
   * Say once that this agent's learnings are sitting at the old location.
   * `logger.warn` mirrors into the session log sink, so the line reaches the
   * terminal and the serve session view from one call — which is the whole point
   * for a fleet nobody is watching run.
   */
  private reportLegacyLocationOnce(): void {
    if (!this.legacySource) return;
    const notice = takeLegacyLearningsNotice(this.legacySource.agentFilePath, this.legacySource.stateRoot);
    if (notice) logger.warn(notice);
  }

  async save(learnings: Learning[]): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await atomicWriteFile(this.filePath, this.render(learnings));
  }

  /** The exact file contents a given set would be saved as. Lets the tidy-up
   *  diff its proposed result against the file on disk without writing it. */
  render(learnings: Learning[]): string {
    return this.serializeMarkdown(learnings);
  }

  async add(newLearnings: Learning[]): Promise<void> {
    await withLearningFileLock(this.filePath, async () => {
      const existing = await this.load();
      const toAdd = newLearnings.filter(n =>
        !existing.some(e => this.similar(e.instruction, n.instruction))
      );
      if (toAdd.length === 0) return;
      const taken = new Set(existing.map(l => l.id).filter(Boolean));
      for (const l of toAdd) {
        if (!l.id || l.id.length < 4 || taken.has(l.id)) l.id = generateLearningId(taken);
        taken.add(l.id);
      }
      await this.save([...existing, ...toAdd]);
    });
  }

  /**
   * Persist captured learnings, RE-ASSERTING a repeat rather than discarding it.
   *
   * {@link add} drops anything resembling a stored learning, which silently threw
   * away the highest-signal event the system gets: a human repeating a correction
   * they already gave. A repeat almost always means the stored rule was not in
   * force — it sat past the injection cap — so the right response is to refresh it
   * (keep its id and appliedCount, take the newer wording, move it to the front
   * of the recency ordering) rather than treat it as redundant. Observed case: a
   * reviewer's "cut the teaching-mode phrasing" was captured, never injected, and
   * when the reviewer said it again seven weeks later the repeat was dropped as a
   * duplicate of a rule the agent had never seen.
   *
   * A weaker source never rewrites a stronger one: an auto-extracted learning
   * that merely overlaps a human rule is genuinely redundant and is still
   * dropped.
   *
   * A match against a GRADUATED rule is neither inserted nor escalated: that
   * rule already applies through the agent file's own instructions, so writing
   * it back into the store would state it twice. It is returned separately so
   * the caller can say "already permanent" rather than reporting nothing.
   *
   * A match against a RETIRED rule revives it. A human re-asserting something we
   * retired is proof the retirement was wrong, and it is the only correction
   * signal the archive can ever receive.
   *
   * When `cap` is given, the ACTIVE set is bounded and a genuinely new rule has
   * to be paid for. In order:
   *
   *  1. `draft.supersedes` names a rule → retire it, insert the draft. This is
   *     the move the capture evaluator is asked to make, and it covers both
   *     folding two rules into one and trading away the least valuable rule.
   *  2. Otherwise, if the set is full, retire the weakest AUTO rule to make
   *     room. A reviewer correction always wins that trade; an auto draft only
   *     wins it if it outranks the rule it would displace, so the set keeps the
   *     best N rather than the last N.
   *  3. If nothing may be dropped — every active rule is a human correction —
   *     an auto draft is REFUSED, and a human correction is inserted over cap.
   *
   * Step 3 is a fallback for a model that ignored the instruction, NOT the way
   * a full set is meant to absorb a correction. Capture asks for `supersedes`
   * on every learning once the set is full, human ones included, and folding
   * there is what keeps the set at its size. Letting a correction land over cap
   * as policy is what builds a backlog, and a backlog cannot drain: rules past
   * the cap are never injected, so nothing about them can ever be observed, and
   * they cannot be evicted either. Measured before this changed: one agent held
   * 70 human corrections outside the cap, permanently unreachable.
   *
   * It stays as a fallback because the alternative is worse. Dropping a
   * reviewer's correction because a helper model failed to name a rule to fold
   * it into would lose the highest-signal input the system gets. Over cap and
   * reported beats silently gone.
   *
   * A re-asserted rule is never evictable: the repeat is evidence the wording
   * needs rewriting, which is the opposite of evidence it should be dropped.
   *
   * @returns the learnings actually persisted, split by how they landed, so the
   * caller can report a truthful count instead of what the evaluator proposed.
   */
  async addOrEscalate(
    incoming: LearningDraft[],
    options?: { cap?: number | undefined },
  ): Promise<{
    inserted: Learning[];
    escalated: Learning[];
    alreadyGraduated: Learning[];
    /** Rules retired to make room, whether superseded, traded away, or drained
     *  from a file that was already over cap before this write. */
    retired: Learning[];
    /** Auto drafts dropped because the set was full and nothing was evictable. */
    refused: LearningDraft[];
    /** Active rules above the cap after the write. Non-zero only when they are
     *  all human corrections, which is the one case worth interrupting for. */
    overCap: number;
  }> {
    return withLearningFileLock(this.filePath, async () => {
      const existing = await this.load();
      const inserted: Learning[] = [];
      const escalated: Learning[] = [];
      const alreadyGraduated: Learning[] = [];
      const retired: Learning[] = [];
      const refused: LearningDraft[] = [];
      const cap = options?.cap;

      const active = () => existing.filter(l => (l.state ?? 'active') === 'active');
      const retire = (l: Learning) => { l.state = 'retired'; retired.push(l); };

      /** The active rule we are most willing to lose: lowest-ranked, auto-only,
       *  never one a human has repeated. `undefined` when nothing qualifies,
       *  which is what makes "never drop a human correction" structural. */
      const weakestEvictable = (): Learning | undefined => {
        const candidates = active().filter(l => l.source === 'auto' && (l.reasserted ?? 0) === 0);
        return candidates.length > 0 ? rankLearnings(candidates).at(-1) : undefined;
      };

      const insert = (draft: LearningDraft): void => {
        const taken = new Set(existing.map(l => l.id).filter(Boolean));
        const id = draft.id && draft.id.length >= 4 && !taken.has(draft.id)
          ? draft.id
          : generateLearningId(taken);
        // `supersedes` is an instruction to this method, not a property of the
        // rule; it has been acted on by the time we get here, so it must not
        // travel into the stored entry.
        const { supersedes: _consumed, ...rest } = draft;
        const next: Learning = { ...rest, id };
        existing.push(next);
        inserted.push(next);
      };

      for (const draft of incoming) {
        const idx = existing.findIndex(e => this.similar(e.instruction, draft.instruction));

        if (idx >= 0 && existing[idx]!.state === 'graduated') {
          alreadyGraduated.push(existing[idx]!);
          continue;
        }

        if (idx < 0) {
          // The draft names a rule it replaces. Honour it only for an ACTIVE
          // rule of equal or weaker provenance — a graduated rule lives in the
          // agent file and is not the store's to retire, and an auto capture
          // may not evict a human correction by naming it.
          const target = draft.supersedes
            ? existing.find(e =>
                e.id === draft.supersedes
                && (e.state ?? 'active') === 'active'
                && learningSourceRank(draft.source) <= learningSourceRank(e.source))
            : undefined;

          if (target) {
            retire(target);
            insert(draft);
            continue;
          }

          if (cap !== undefined && active().length >= cap) {
            const victim = weakestEvictable();
            // An auto draft has to be worth more than what it displaces; a
            // reviewer correction outranks every auto rule by definition.
            const wins = victim !== undefined
              && (draft.source !== 'auto' || rankLearnings([victim, draft]).at(-1) === victim);
            if (wins) {
              retire(victim);
            } else if (draft.source === 'auto') {
              refused.push(draft);
              continue;
            }
            // A human correction the evaluator did not fold, with nothing
            // evictable behind it. Falls through and lands over cap: reported,
            // never dropped. See the note on step 3 above — this is the
            // non-compliance path, not the intended one.
          }

          insert(draft);
          continue;
        }

        const prior = existing[idx]!;
        if (learningSourceRank(draft.source) > learningSourceRank(prior.source)) continue;

        const next: Learning = {
          ...prior,
          category: draft.category,
          title: draft.title,
          instruction: draft.instruction,
          source: draft.source,
          confidence: Math.max(prior.confidence, draft.confidence),
          // Re-asserted now, so it ranks as recent and gets injected next run.
          extractedAt: draft.extractedAt,
          ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
          // A repeat is the evidence that the stored wording is not landing.
          // Counting it is what later lets the tidy-up REWRITE the rule instead
          // of retiring it or stacking a near-copy beside it.
          reasserted: (prior.reasserted ?? 0) + 1,
          // Revive on re-assertion: a human repeating something we archived is
          // the archive being overruled.
          state: 'active',
        };
        // Move it to the tail rather than rewriting it in place. Dates persist to
        // day precision, so a rule re-asserted on the same day as its peers ties
        // with them and the ranking breaks that tie by file position. Left at its
        // original (early) index, the refreshed rule would still sort last among
        // that day's entries and stay dormant, which is exactly the outcome
        // re-assertion is supposed to prevent.
        existing.splice(idx, 1);
        existing.push(next);
        escalated.push(next);
      }

      // Drain a file that was already over cap before this write — every store
      // predating the cap is. It takes from the bottom of the same ranking
      // injection reads from the top of, so the rules it retires are ones that
      // were not reaching the model anyway, and it stops the moment only human
      // corrections are left (the state `overCap` exists to report).
      //
      // What it removes is inert; what it PROMOTES is the point. The entries
      // eviction may not touch — human corrections, and rules a human has
      // repeated — rise into the injected window as the auto pile around them
      // retires. Measured on a real store: a rule re-asserted three times sat at
      // rank 27 of 70 and had never once reached the agent; draining to the cap
      // moved it into force. A correction someone gave three times not applying
      // is the failure this whole cap exists to end.
      if (cap !== undefined) {
        while (active().length > cap) {
          const victim = weakestEvictable();
          if (!victim) break;
          retire(victim);
        }
      }

      if (inserted.length > 0 || escalated.length > 0 || retired.length > 0) {
        await this.save(existing);
      }
      return {
        inserted,
        escalated,
        alreadyGraduated,
        retired,
        refused,
        overCap: cap === undefined ? 0 : Math.max(0, active().length - cap),
      };
    });
  }

  /**
   * Move learnings between lifecycle states. Used by the tidy-up pass to retire
   * superseded entries and mark graduated ones, in one load+save under the lock.
   * @returns the ids that actually changed state
   */
  async setState(ids: string[], state: LearningState): Promise<string[]> {
    return withLearningFileLock(this.filePath, async () => {
      const learnings = await this.load();
      const wanted = new Set(ids);
      const changed: string[] = [];
      for (const l of learnings) {
        if (!wanted.has(l.id) || (l.state ?? 'active') === state) continue;
        l.state = state;
        changed.push(l.id);
      }
      if (changed.length > 0) await this.save(learnings);
      return changed;
    });
  }

  /**
   * Credit the injected set for approval GATES a human resolved without leaving
   * a comment — the only positive evidence the system gets that a rule works.
   *
   * Deliberately not credited for a gate that drew a comment: the reviewer had
   * to correct something, and crediting the rules in force would let a bad rule
   * graduate on the strength of the runs it was failing.
   *
   * The unit is the gate, not the run. Requiring a whole run to pass
   * uncommented made this unreachable on any agent whose reviewer steers it —
   * measured at 0 across 750 rules.
   */
  async recordApprovedRun(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await withLearningFileLock(this.filePath, async () => {
      const learnings = await this.load();
      let changed = false;
      for (const l of learnings) {
        if (!ids.includes(l.id)) continue;
        l.approvedRuns++;
        changed = true;
      }
      if (changed) await this.save(learnings);
    });
  }

  /**
   * Persist an explicit manual rule. Unlike add(), this never silently drops on a
   * similarity match: an existing similar learning is upgraded in place to a
   * manual, confidence-1 rule (the reviewer's wording wins) while keeping its id
   * and appliedCount; otherwise the rule is inserted with a fresh id. Single
   * load+save under the file lock.
   * @returns whether an existing learning was upgraded (vs. a new one inserted),
   * and whether that learning is graduated — in which case the caller must
   * re-render the agent file's block so the reviewer's new wording reaches the
   * copy that is actually in force.
   */
  async upsertManual(
    draft: LearningDraft,
  ): Promise<{ upgraded: boolean; graduated: boolean; retired: Learning[] }> {
    return withLearningFileLock(this.filePath, async () => {
      const existing = await this.load();
      const retired: Learning[] = [];

      // An explicit fold named by the refiner. Checked BEFORE the similarity
      // match, because that matcher needs 60% shared vocabulary and the whole
      // point of the reconcile step is catching a collision between two rules
      // that share almost none — which is exactly what a human writes when they
      // are correcting an earlier note of their own.
      const named = draft.supersedes
        ? existing.find(e => e.id === draft.supersedes && (e.state ?? 'active') === 'active')
        : undefined;
      if (named) {
        named.state = 'retired';
        retired.push(named);
      }

      // Never re-match the entry just retired above: the upgrade path revives a
      // retired rule, which would silently undo the fold the refiner asked for.
      const idx = existing.findIndex(
        e => e !== named && this.similar(e.instruction, draft.instruction),
      );
      if (idx >= 0) {
        const prior = existing[idx]!;
        const { sessionId: _priorSessionId, ...priorWithoutSession } = prior;
        existing[idx] = {
          ...priorWithoutSession,
          category: draft.category,
          title: draft.title,
          instruction: draft.instruction,
          source: 'manual',
          confidence: 1,
          extractedAt: draft.extractedAt,
          // The re-asserting session owns the rule now (or none, for an
          // agent-level rule); keep prior.id and prior.appliedCount.
          ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
          // A human writing a rule we already hold is a repeat like any other.
          reasserted: (prior.reasserted ?? 0) + 1,
          // Revive a retired rule, but leave a GRADUATED one graduated: it lives
          // in the agent file, and flipping it back to active would state the
          // same rule twice, once there and once in the injected block. The
          // reviewer's new wording still wins — the caller re-renders the agent
          // file block so the permanent copy is the one that changes.
          ...(prior.state === 'retired' ? { state: 'active' as const } : {}),
        };
        await this.save(existing);
        return { upgraded: true, graduated: existing[idx]!.state === 'graduated', retired };
      }
      const taken = new Set(existing.map(l => l.id).filter(Boolean));
      const id = draft.id && draft.id.length >= 4 && !taken.has(draft.id)
        ? draft.id
        : generateLearningId(taken);
      // `supersedes` is an instruction to this method, already acted on above;
      // it must not travel into the stored entry.
      const { supersedes: _consumed, ...rest } = draft;
      await this.save([...existing, { ...rest, id }]);
      return { upgraded: false, graduated: false, retired };
    });
  }

  async incrementApplied(ids: string[]): Promise<void> {
    await withLearningFileLock(this.filePath, async () => {
      const learnings = await this.load();
      let changed = false;
      for (const l of learnings) {
        if (ids.includes(l.id)) {
          l.appliedCount++;
          changed = true;
        }
      }
      if (changed) {
        await this.save(learnings);
      }
    });
  }

  /** Remove a learning by id. Returns whether anything was removed. */
  async remove(id: string): Promise<boolean> {
    return withLearningFileLock(this.filePath, async () => {
      const learnings = await this.load();
      const next = learnings.filter((l) => l.id !== id);
      if (next.length === learnings.length) return false;
      await this.save(next);
      return true;
    });
  }

  private similar(a: string, b: string): boolean {
    // Extract words (letters only, >4 chars) for comparison
    const extractWords = (text: string) =>
      new Set(text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 4));
    const wordsA = extractWords(a);
    const wordsB = extractWords(b);
    if (wordsA.size === 0 || wordsB.size === 0) return false;
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    return intersection >= Math.min(wordsA.size, wordsB.size) * 0.6;
  }

  private parseMarkdown(content: string): Learning[] {
    const learnings: Learning[] = [];
    // Capture the metadata comment as a single token blob so fields can be
    // parsed positionally-or-by-key. This keeps old files (no `src:`) readable.
    // The `## Retired` heading that separates the archive is not matched by the
    // `###` entry regex, so it needs no special handling here — each retired
    // entry carries `state:retired` in its own metadata. Same for the `<!-- agent:
    // … -->` breadcrumb under the H1: a comment is only captured as metadata when
    // a `### [category] title` line immediately precedes it.
    const regex = /### \[([\w-]+)\] (.+)\n<!-- (.+?) -->\n([\s\S]+?)(?=\n\n###|\n\n## |\n*$)/g;

    let match;
    while ((match = regex.exec(content)) !== null) {
      const meta = this.parseMeta(match[3]);
      learnings.push({
        category: match[1] as LearningCategory,
        title: match[2],
        id: meta.id ?? '',
        confidence: meta.confidence ?? 0,
        appliedCount: meta.applied ?? 0,
        extractedAt: meta.date ?? '',
        source: meta.source ?? 'auto',
        ...(meta.sessionId && { sessionId: meta.sessionId }),
        ...(meta.state && meta.state !== 'active' && { state: meta.state }),
        reasserted: meta.reasserted ?? 0,
        approvedRuns: meta.approved ?? 0,
        instruction: match[4].trim(),
      });
    }
    return learnings;
  }

  /**
   * Parse the metadata comment body, e.g.
   * `id:AB12 | confidence:0.92 | applied:0 | src:approval | sess:abc123 | 2024-01-15`.
   * Every field except the date is optional and defaults, so learnings files
   * written before provenance (`src:`), the lifecycle (`state:`) or the evidence
   * counters (`re:`, `ok:`) still load. Unknown tokens are ignored rather than
   * rejected, which is what lets a newer field be added without a migration.
   */
  private parseMeta(meta: string): {
    id?: string; confidence?: number; applied?: number; source?: LearningSource;
    sessionId?: string; date?: string; state?: LearningState;
    reasserted?: number; approved?: number;
  } {
    const out: {
      id?: string; confidence?: number; applied?: number; source?: LearningSource;
      sessionId?: string; date?: string; state?: LearningState;
      reasserted?: number; approved?: number;
    } = {};
    for (const token of meta.split('|').map(t => t.trim())) {
      if (token.startsWith('id:')) out.id = token.slice(3);
      else if (token.startsWith('confidence:')) out.confidence = parseFloat(token.slice(11));
      else if (token.startsWith('applied:')) out.applied = parseInt(token.slice(8));
      else if (token.startsWith('src:')) {
        const source = token.slice(4);
        out.source = source === 'manual' || source === 'approval' ? source : 'auto';
      }
      else if (token.startsWith('sess:')) out.sessionId = token.slice(5);
      else if (token.startsWith('state:')) {
        const state = token.slice(6);
        out.state = state === 'graduated' || state === 'retired' ? state : 'active';
      }
      else if (token.startsWith('re:')) out.reasserted = parseInt(token.slice(3)) || 0;
      else if (token.startsWith('ok:')) out.approved = parseInt(token.slice(3)) || 0;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(token)) out.date = token;
    }
    return out;
  }

  /**
   * Render one entry. Optional metadata is omitted when it carries no
   * information (state active, counters at zero) so a file that predates these
   * fields round-trips byte-identical through a save it did not need.
   */
  private serializeEntry(l: Learning): string {
    const sess = l.sessionId ? ` | sess:${l.sessionId}` : '';
    const state = l.state && l.state !== 'active' ? ` | state:${l.state}` : '';
    // `?? 0` guards the FILE, not the type: a counter that reached the serializer
    // as undefined would write `re:NaN` into a user's corrections file and every
    // later parse would read it back as garbage.
    const re = (l.reasserted ?? 0) > 0 ? ` | re:${l.reasserted}` : '';
    const ok = (l.approvedRuns ?? 0) > 0 ? ` | ok:${l.approvedRuns}` : '';
    return `### [${l.category}] ${l.title}\n`
      + `<!-- id:${l.id} | confidence:${l.confidence.toFixed(2)} | applied:${l.appliedCount}`
      + ` | src:${l.source}${sess}${state}${re}${ok} | ${toLocalDate(l.extractedAt)} -->\n`
      + `${l.instruction}\n\n`;
  }

  /**
   * Retired entries sink to a trailing `## Retired` section rather than being
   * deleted. The system never destroys a lesson a human or a run produced: a
   * retirement is a judgement that something is superseded, and the evidence
   * that it was wrong is a human re-asserting the rule — which
   * {@link addOrEscalate} can only detect if the entry is still there to match.
   */
  private serializeMarkdown(learnings: Learning[]): string {
    // The file is keyed by agent id, so its path carries the agent's own
    // subdirectories (`learnings/agents/x/x-news-post.learnings.md`). Only the
    // last segment is the name.
    const agentName = basename(this.filePath, '.learnings.md') || 'agent';
    let md = `# Learnings for ${agentName}\n`;

    // A breadcrumb, deliberately not a mechanism: nothing ever reads this back,
    // there is no format version behind it and no rename recovery built on it.
    // It is here because a file sitting under `project/9f2c…/learnings/` is
    // otherwise unattributable by eye, and because if rename recovery is ever
    // built the source path is already recorded in every file that would need
    // it. `parseMarkdown` only matches a metadata comment that follows a
    // `### [category]` heading, so this one cannot parse back as a learning.
    const source = this.legacySource;
    if (source?.agentFilePath) {
      // A URL agent's address is its source; anything else is shown relative to
      // the project, since the absolute path leads into the state directory of
      // whoever happened to run it.
      const label = /^https?:\/\//i.test(source.agentFilePath)
        ? source.agentFilePath
        : displayPath(resolve(source.agentFilePath), source.stateRoot);
      md += `<!-- agent: ${label} -->\n`;
    }
    md += '\n';

    for (const l of learnings) {
      if (l.state === 'retired') continue;
      md += this.serializeEntry(l);
    }

    const retired = learnings.filter((l) => l.state === 'retired');
    if (retired.length > 0) {
      md += `## Retired\n\n`;
      for (const l of retired) md += this.serializeEntry(l);
    }
    return md.trim() + '\n';
  }
}
