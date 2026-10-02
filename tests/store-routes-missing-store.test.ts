import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServeContext, ServeRequest } from '../src/cli/serve/context';
import { storeRoutes } from '../src/cli/serve/routes/stores';
import { listStoreRows, readSessionResults } from '../src/cli/serve/stores';

type Captured = { status?: number; body?: string };

async function get(projects: Array<{ id: string; root: string }>, path: string) {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    setHeader() {},
    end(body?: string) {
      captured.body = body;
      return res;
    },
  };
  const requestUrl = new URL(path, 'http://127.0.0.1:4321');
  const rq: ServeRequest = {
    req: Object.assign(new EventEmitter(), { method: 'GET', headers: {} }) as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    requestUrl,
    routePath: requestUrl.pathname.slice('/api'.length),
    isApi: true,
    requestOrigin: undefined,
    crossOrigin: false,
    sessionAuthorized: () => true,
  };
  await storeRoutes({ projects } as unknown as ServeContext, rq);
  return { status: captured.status, json: captured.body ? JSON.parse(captured.body) : undefined };
}

async function projectWithStore(id: string): Promise<{ id: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-store-route-'));
  const createdAt = new Date().toISOString();
  await mkdir(join(root, '.agentuse', 'store', 'pipeline'), { recursive: true });
  await writeFile(join(root, '.agentuse', 'store', 'pipeline', 'items.json'), JSON.stringify({
    version: 1,
    items: [{ id: 'item1', title: 'One', createdAt, updatedAt: createdAt, data: {} }],
  }));
  return { id, root };
}

async function projectWithoutStore(id: string): Promise<{ id: string; root: string }> {
  return { id, root: await mkdtemp(join(tmpdir(), 'agentuse-store-route-empty-')) };
}

describe('store routes for a store that does not exist', () => {
  it('answers 404 for the rows of a missing store', async () => {
    const result = await get([await projectWithoutStore('a')], '/api/stores/pipeline');
    expect(result.status).toBe(404);
    expect(result.json.error.code).toBe('STORE_NOT_FOUND');
  });

  it('answers 404 for an item in a missing store', async () => {
    const result = await get([await projectWithoutStore('a')], '/api/stores/pipeline/item1');
    expect(result.status).toBe(404);
    expect(result.json.error.code).toBe('STORE_ITEM_NOT_FOUND');
  });

  it('does not report an error row for a project that lacks the store', async () => {
    const result = await get([await projectWithStore('a'), await projectWithoutStore('b')], '/api/stores/pipeline');
    expect(result.status).toBe(200);
    expect(result.json.rows.map((row: { projectId: string }) => row.projectId)).toEqual(['a']);
    expect(result.json.errors).toEqual([]);
  });

  it('still reports a store that exists but cannot be parsed', async () => {
    const project = await projectWithoutStore('a');
    await mkdir(join(project.root, '.agentuse', 'store', 'pipeline'), { recursive: true });
    await writeFile(join(project.root, '.agentuse', 'store', 'pipeline', 'items.json'), '{not json');
    const result = await get([project], '/api/stores/pipeline');
    expect(result.status).toBe(200);
    expect(result.json.errors).toHaveLength(1);
  });

  it('reads a missing store as no rows and no results', async () => {
    const project = await projectWithoutStore('a');
    expect(await listStoreRows(project, 'pipeline')).toBeNull();
    expect((await readSessionResults(project.root)).size).toBe(0);
  });
});
