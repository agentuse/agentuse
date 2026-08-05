import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { randomUUID } from 'crypto';
import type { Learning, LearningCategory, LearningSource, LearningState } from './types';
import { learningSourceRank } from './ranking';

// Serialize read-modify-write sequences on the same learnings file so two
// concurrent saves (e.g. two serve approval decisions on the same agent) can't
// clobber each other. Intra-process only; cross-process races remain rare.
const fileLocks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run fn once, after prev settles either way
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
 * Resolve learning file path
 * - Default: {agent-dir}/{agent-file-basename}.learnings.md
 * - Custom: config.file relative to agent file
 */
export function resolveLearningFilePath(
  agentFilePath: string,
  customFile?: string
): string {
  const agentDir = dirname(agentFilePath);
  if (customFile) {
    return resolve(agentDir, customFile);
  }
  const agentFileBasename = basename(agentFilePath, '.md');
  return join(agentDir, `${agentFileBasename}.learnings.md`);
}

/**
 * Store for managing agent learnings in markdown format
 */
export class LearningStore {
  public readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static fromAgentFile(agentFilePath: string, customFile?: string): LearningStore {
    const filePath = resolveLearningFilePath(agentFilePath, customFile);
    return new LearningStore(filePath);
  }

  async load(): Promise<Learning[]> {
    if (!existsSync(this.filePath)) return [];

    const content = await readFile(this.filePath, 'utf-8');
    return this.parseMarkdown(content);
  }

  async save(learnings: Learning[]): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.filePath, this.render(learnings), 'utf-8');
  }

  /** The exact file contents a given set would be saved as. Lets the tidy-up
   *  diff its proposed result against the file on disk without writing it. */
  render(learnings: Learning[]): string {
    return this.serializeMarkdown(learnings);
  }

  async add(newLearnings: Learning[]): Promise<void> {
    await withFileLock(this.filePath, async () => {
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
   * @returns the learnings actually persisted, split by how they landed, so the
   * caller can report a truthful count instead of what the evaluator proposed.
   */
  async addOrEscalate(
    incoming: Learning[],
  ): Promise<{ inserted: Learning[]; escalated: Learning[]; alreadyGraduated: Learning[] }> {
    return withFileLock(this.filePath, async () => {
      const existing = await this.load();
      const inserted: Learning[] = [];
      const escalated: Learning[] = [];
      const alreadyGraduated: Learning[] = [];

      for (const draft of incoming) {
        const idx = existing.findIndex(e => this.similar(e.instruction, draft.instruction));

        if (idx >= 0 && existing[idx]!.state === 'graduated') {
          alreadyGraduated.push(existing[idx]!);
          continue;
        }

        if (idx < 0) {
          const taken = new Set(existing.map(l => l.id).filter(Boolean));
          const id = draft.id && draft.id.length >= 4 && !taken.has(draft.id)
            ? draft.id
            : generateLearningId(taken);
          const next = { ...draft, id };
          existing.push(next);
          inserted.push(next);
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

      if (inserted.length > 0 || escalated.length > 0) {
        await this.save(existing);
      }
      return { inserted, escalated, alreadyGraduated };
    });
  }

  /**
   * Move learnings between lifecycle states. Used by the tidy-up pass to retire
   * superseded entries and mark graduated ones, in one load+save under the lock.
   * @returns the ids that actually changed state
   */
  async setState(ids: string[], state: LearningState): Promise<string[]> {
    return withFileLock(this.filePath, async () => {
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
   * Credit the injected set for a run that a human approved without leaving a
   * comment — the only positive evidence the system gets that a rule is working.
   *
   * Deliberately NOT incremented for a run that drew a comment: the reviewer
   * corrected something, so the rules in force that run did not fully do their
   * job, and crediting them would let a bad rule graduate on the strength of
   * runs it was failing.
   */
  async recordApprovedRun(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await withFileLock(this.filePath, async () => {
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
  async upsertManual(draft: Learning): Promise<{ upgraded: boolean; graduated: boolean }> {
    return withFileLock(this.filePath, async () => {
      const existing = await this.load();
      const idx = existing.findIndex(e => this.similar(e.instruction, draft.instruction));
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
        return { upgraded: true, graduated: existing[idx]!.state === 'graduated' };
      }
      const taken = new Set(existing.map(l => l.id).filter(Boolean));
      const id = draft.id && draft.id.length >= 4 && !taken.has(draft.id)
        ? draft.id
        : generateLearningId(taken);
      await this.save([...existing, { ...draft, id }]);
      return { upgraded: false, graduated: false };
    });
  }

  async incrementApplied(ids: string[]): Promise<void> {
    await withFileLock(this.filePath, async () => {
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
    return withFileLock(this.filePath, async () => {
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
    // entry carries `state:retired` in its own metadata.
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
    const agentName = this.filePath.split('/').pop()?.replace('.learnings.md', '') || 'agent';
    let md = `# Learnings for ${agentName}\n\n`;

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
