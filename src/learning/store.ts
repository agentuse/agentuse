import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { randomUUID } from 'crypto';
import type { Learning, LearningCategory, LearningSource } from './types';
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
    await writeFile(this.filePath, this.serializeMarkdown(learnings), 'utf-8');
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
   * @returns the learnings actually persisted, split by how they landed, so the
   * caller can report a truthful count instead of what the evaluator proposed.
   */
  async addOrEscalate(
    incoming: Learning[],
  ): Promise<{ inserted: Learning[]; escalated: Learning[] }> {
    return withFileLock(this.filePath, async () => {
      const existing = await this.load();
      const inserted: Learning[] = [];
      const escalated: Learning[] = [];

      for (const draft of incoming) {
        const idx = existing.findIndex(e => this.similar(e.instruction, draft.instruction));

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
        };
        existing[idx] = next;
        escalated.push(next);
      }

      if (inserted.length > 0 || escalated.length > 0) {
        await this.save(existing);
      }
      return { inserted, escalated };
    });
  }

  /**
   * Persist an explicit manual rule. Unlike add(), this never silently drops on a
   * similarity match: an existing similar learning is upgraded in place to a
   * manual, confidence-1 rule (the reviewer's wording wins) while keeping its id
   * and appliedCount; otherwise the rule is inserted with a fresh id. Single
   * load+save under the file lock.
   * @returns whether an existing learning was upgraded (vs. a new one inserted)
   */
  async upsertManual(draft: Learning): Promise<{ upgraded: boolean }> {
    return withFileLock(this.filePath, async () => {
      const existing = await this.load();
      const idx = existing.findIndex(e => this.similar(e.instruction, draft.instruction));
      if (idx >= 0) {
        const prior = existing[idx];
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
        };
        await this.save(existing);
        return { upgraded: true };
      }
      const taken = new Set(existing.map(l => l.id).filter(Boolean));
      const id = draft.id && draft.id.length >= 4 && !taken.has(draft.id)
        ? draft.id
        : generateLearningId(taken);
      await this.save([...existing, { ...draft, id }]);
      return { upgraded: false };
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
    const regex = /### \[([\w-]+)\] (.+)\n<!-- (.+?) -->\n([\s\S]+?)(?=\n\n###|\n*$)/g;

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
        instruction: match[4].trim(),
      });
    }
    return learnings;
  }

  /**
   * Parse the metadata comment body, e.g.
   * `id:AB12 | confidence:0.92 | applied:0 | src:approval | sess:abc123 | 2024-01-15`.
   * `src:` and `sess:` are optional so learnings files written before
   * provenance still load.
   */
  private parseMeta(meta: string): {
    id?: string; confidence?: number; applied?: number; source?: LearningSource; sessionId?: string; date?: string;
  } {
    const out: { id?: string; confidence?: number; applied?: number; source?: LearningSource; sessionId?: string; date?: string } = {};
    for (const token of meta.split('|').map(t => t.trim())) {
      if (token.startsWith('id:')) out.id = token.slice(3);
      else if (token.startsWith('confidence:')) out.confidence = parseFloat(token.slice(11));
      else if (token.startsWith('applied:')) out.applied = parseInt(token.slice(8));
      else if (token.startsWith('src:')) {
        const source = token.slice(4);
        out.source = source === 'manual' || source === 'approval' ? source : 'auto';
      }
      else if (token.startsWith('sess:')) out.sessionId = token.slice(5);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(token)) out.date = token;
    }
    return out;
  }

  private serializeMarkdown(learnings: Learning[]): string {
    const agentName = this.filePath.split('/').pop()?.replace('.learnings.md', '') || 'agent';
    let md = `# Learnings for ${agentName}\n\n`;

    for (const l of learnings) {
      md += `### [${l.category}] ${l.title}\n`;
      const sess = l.sessionId ? ` | sess:${l.sessionId}` : '';
      md += `<!-- id:${l.id} | confidence:${l.confidence.toFixed(2)} | applied:${l.appliedCount} | src:${l.source}${sess} | ${toLocalDate(l.extractedAt)} -->\n`;
      md += `${l.instruction}\n\n`;
    }
    return md.trim() + '\n';
  }
}
