import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import type { Learning, LearningCategory } from './types';

/**
 * Resolve learning file path
 * - Default: {agent-dir}/{agent-name}.learnings.md
 * - Custom: config.file relative to agent file
 */
export function resolveLearningFilePath(
  agentFilePath: string,
  agentName: string,
  customFile?: string
): string {
  const agentDir = dirname(agentFilePath);
  if (customFile) {
    return resolve(agentDir, customFile);
  }
  return join(agentDir, `${agentName}.learnings.md`);
}

/**
 * Store for managing agent learnings in markdown format
 */
export class LearningStore {
  public readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static fromAgentFile(agentFilePath: string, agentName: string, customFile?: string): LearningStore {
    const filePath = resolveLearningFilePath(agentFilePath, agentName, customFile);
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
    const existing = await this.load();

    // Dedupe by similar instruction
    const toAdd = newLearnings.filter(n =>
      !existing.some(e => this.similar(e.instruction, n.instruction))
    );

    if (toAdd.length > 0) {
      await this.save([...existing, ...toAdd]);
    }
  }

  async incrementApplied(ids: string[]): Promise<void> {
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
    const regex = /### \[(\w+(?:-\w+)?)\] (.+)\n<!-- id:(\w+) \| confidence:([\d.]+) \| applied:(\d+) \| ([\d-]+) -->\n([\s\S]+?)(?=\n\n###|\n*$)/g;

    let match;
    while ((match = regex.exec(content)) !== null) {
      learnings.push({
        category: match[1] as LearningCategory,
        title: match[2],
        id: match[3],
        confidence: parseFloat(match[4]),
        appliedCount: parseInt(match[5]),
        extractedAt: match[6],
        instruction: match[7].trim(),
      });
    }
    return learnings;
  }

  private serializeMarkdown(learnings: Learning[]): string {
    const agentName = this.filePath.split('/').pop()?.replace('.learnings.md', '') || 'agent';
    let md = `# Learnings for ${agentName}\n\n`;

    for (const l of learnings) {
      md += `### [${l.category}] ${l.title}\n`;
      md += `<!-- id:${l.id} | confidence:${l.confidence.toFixed(2)} | applied:${l.appliedCount} | ${l.extractedAt.slice(0, 10)} -->\n`;
      md += `${l.instruction}\n\n`;
    }
    return md.trim() + '\n';
  }
}
