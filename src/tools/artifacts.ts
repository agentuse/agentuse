import type { Tool } from 'ai';
import { z } from 'zod';
import matter from 'gray-matter';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { ToolOutput, ToolErrorOutput } from './types.js';
import { getArtifactUrl } from './await-human.js';
import {
  DEFAULT_ARTIFACTS_DIR,
  getManifestPath,
  readArtifactManifest,
  upsertArtifactEntry,
} from './artifact-manifest.js';

export interface ArtifactToolContext {
  projectRoot: string;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  /** Project-relative artifact directory. Defaults to `.agentuse/artifacts`. */
  dir?: string | undefined;
}

function errOut(error: string): ToolOutput {
  return { output: JSON.stringify({ success: false, error } satisfies ToolErrorOutput) };
}

/** URL-safe slug: lowercase, non-alphanumerics → hyphen, trimmed, capped. */
function slug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Reduce an arbitrary `name` to a single safe filename. Strips any directory
 * components (the tool owns the layout), slugifies the stem, and keeps a sane
 * extension — defaulting to `.md` when none/odd so the viewer can always render.
 */
function safeFileName(name: string): string {
  const base = path.basename(name);
  const ext = path.extname(base).toLowerCase();
  const stem = ext ? base.slice(0, -ext.length) : base;
  const safeStem = slug(stem) || 'artifact';
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.md';
  return safeStem + safeExt;
}

/** True only when `child` resolves strictly inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Merge title/tags into a markdown file's YAML frontmatter (explicit args win). */
function applyFrontmatter(content: string, title?: string, tags?: string[]): string {
  if (title === undefined && (!tags || tags.length === 0)) return content;
  const parsed = matter(content);
  const data: Record<string, unknown> = { ...parsed.data };
  if (title !== undefined) data.title = title;
  if (tags && tags.length > 0) data.tags = tags;
  return matter.stringify(parsed.content, data);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * `tools__artifact_save` — save a viewable, session-linked deliverable under
 * `.agentuse/artifacts/<group>/<file>`. The tool owns the path (so no broad
 * filesystem-write grant is needed), normalizes markdown frontmatter, records a
 * manifest entry that links the file to this run, and returns a viewable URL.
 */
export function createArtifactTool(context: ArtifactToolContext): Tool {
  const dir = context.dir ?? DEFAULT_ARTIFACTS_DIR;
  return {
    description: `Save a substantial deliverable (report, plan, spec, HTML page, dashboard, chart) as a project artifact under ${dir}/. The file is rendered in the AgentUse viewer and linked to this run, and the tool returns a viewable URL. Prefer this over the filesystem write tool for anything the user will want to preview. Group related files by passing the same \`group\`.`,
    inputSchema: z.object({
      name: z.string().describe('File name including extension, e.g. "index.md", "report.html", "chart.svg". Renderable types: md, html, svg, pdf, txt, json, csv, png, jpg. No extension defaults to .md.'),
      content: z.string().describe('Full file content. For markdown, `title`/`tags` are merged into YAML frontmatter.'),
      group: z.string().optional().describe('Group folder slug to keep related files together (e.g. "client-report"). Defaults to a slug of the title or file name.'),
      title: z.string().optional().describe('Human-readable title shown in the viewer and recorded in the manifest.'),
      tags: z.array(z.string()).optional().describe('Optional tags recorded in markdown frontmatter.'),
    }),
    execute: async ({ name, content, group, title, tags }: {
      name: string;
      content: string;
      group?: string;
      title?: string;
      tags?: string[];
    }): Promise<ToolOutput> => {
      try {
        const artifactsRoot = path.resolve(context.projectRoot, dir);
        const groupSlug = slug(group ?? title ?? path.basename(name, path.extname(name))) || 'artifact';
        const fileName = safeFileName(name);
        const targetAbs = path.resolve(artifactsRoot, groupSlug, fileName);
        if (!isInside(artifactsRoot, targetAbs)) {
          return errOut(`Refusing to write artifact outside ${dir}/`);
        }

        const ext = path.extname(fileName).slice(1).toLowerCase();
        const finalContent = (ext === 'md' || ext === 'markdown')
          ? applyFrontmatter(content, title, tags)
          : content;

        await writeFileAtomic(targetAbs, finalContent);

        const relName = path.relative(context.projectRoot, targetAbs).split(path.sep).join('/');
        const now = new Date().toISOString();
        await upsertArtifactEntry(getManifestPath(context.projectRoot, dir), {
          name: relName,
          group: groupSlug,
          ...(title !== undefined ? { title } : {}),
          type: ext,
          bytes: Buffer.byteLength(finalContent, 'utf8'),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.agentId ? { agentId: context.agentId } : {}),
          createdAt: now,
          updatedAt: now,
        });

        const url = getArtifactUrl(context.sessionId, relName, context.projectRoot);
        return {
          output: JSON.stringify({
            success: true,
            path: relName,
            group: groupSlug,
            ...(url ? { url } : {}),
          }),
        };
      } catch (err) {
        return errOut(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/**
 * `tools__artifact_list` — enumerate project artifacts from the manifest.
 * Reading an artifact's content is just `filesystem_read` on its path; this tool
 * exists for discovery (what artifacts exist, incl. ones from prior runs).
 */
export function createListArtifactsTool(context: ArtifactToolContext): Tool {
  const dir = context.dir ?? DEFAULT_ARTIFACTS_DIR;
  return {
    description: `List project artifacts saved under ${dir}/ (from the artifact manifest), including ones from previous runs. To read an artifact's content, use the filesystem read tool on its path.`,
    inputSchema: z.object({
      session: z.enum(['current', 'all']).optional().describe('"current" lists only this run\'s artifacts; "all" (default) lists every artifact incl. prior runs.'),
      group: z.string().optional().describe('Only list artifacts in this group folder.'),
    }),
    execute: async ({ session, group }: {
      session?: 'current' | 'all';
      group?: string;
    }): Promise<ToolOutput> => {
      try {
        const manifest = await readArtifactManifest(getManifestPath(context.projectRoot, dir));
        let items = manifest.artifacts;
        if (session === 'current') {
          items = context.sessionId ? items.filter((a) => a.sessionId === context.sessionId) : [];
        }
        if (group) items = items.filter((a) => a.group === group);

        const artifacts = items.map((a) => {
          const url = getArtifactUrl(context.sessionId, a.name, context.projectRoot);
          return {
            name: a.name,
            ...(a.title !== undefined ? { title: a.title } : {}),
            type: a.type,
            group: a.group,
            ...(a.sessionId ? { sessionId: a.sessionId } : {}),
            ...(a.agentId ? { agentId: a.agentId } : {}),
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
            ...(url ? { url } : {}),
          };
        });

        return { output: JSON.stringify({ success: true, count: artifacts.length, artifacts }) };
      } catch (err) {
        return errOut(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
