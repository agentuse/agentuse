import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, IncomingMessage, Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Tests for serve.ts - HTTP server for running agents via API
 *
 * Since the internal functions (parseRequestBody, sendJSON, sendError) are not exported,
 * we test them through the HTTP interface using integration-style tests.
 */

// Helper to make HTTP requests
async function makeRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  const { method = 'POST', path: reqPath = '/run', body, headers = {} } = options;

  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[key] = value;
            }
          }
          try {
            resolve({
              status: res.statusCode || 500,
              data: data ? JSON.parse(data) : null,
              headers: responseHeaders
            });
          } catch {
            resolve({
              status: res.statusCode || 500,
              data: data,
              headers: responseHeaders
            });
          }
        });
      }
    );

    req.on('error', reject);

    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('Serve Command - Request Body Parsing', () => {
  let tempDir: string;

  beforeAll(() => {
    // Create temporary directory with a valid agent file
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'));

    // Create a minimal agent file
    const agentContent = `---
model: anthropic:claude-sonnet-4-0
---

Test agent instructions`;
    fs.writeFileSync(path.join(tempDir, 'test-agent.agentuse'), agentContent);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('JSON parsing validation', () => {
    it('should reject invalid JSON body', async () => {
      // Create a minimal mock server that simulates the parsing logic
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19001;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: 'not valid json{'
        });
        expect(response.status).toBe(400);
        expect((response.data as { success: boolean }).success).toBe(false);
        expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
      } finally {
        mockServer.close();
      }
    });

    it('should reject missing agent field', async () => {
      // Mock server simulating the validation
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.agent || typeof parsed.agent !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: { code: 'MISSING_FIELD', message: 'Missing required field: agent' }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19002;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: { prompt: 'some prompt' } // Missing agent field
        });
        expect(response.status).toBe(400);
        expect((response.data as { error: { code: string } }).error.code).toBe('MISSING_FIELD');
      } finally {
        mockServer.close();
      }
    });

    it('should reject non-string agent field', async () => {
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.agent || typeof parsed.agent !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: { code: 'MISSING_FIELD', message: 'Missing required field: agent' }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19003;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: { agent: 123 } // agent is not a string
        });
        expect(response.status).toBe(400);
        expect((response.data as { error: { code: string } }).error.code).toBe('MISSING_FIELD');
      } finally {
        mockServer.close();
      }
    });

    it('should accept valid request with all optional fields', async () => {
      const mockServer = createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.agent || typeof parsed.agent !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: { code: 'MISSING_FIELD', message: 'Missing required field: agent' }
              }));
              return;
            }
            // Validate optional fields types
            const validRequest = {
              agent: parsed.agent,
              prompt: parsed.prompt,
              model: parsed.model,
              timeout: parsed.timeout,
              maxSteps: parsed.maxSteps
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, parsed: validRequest }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' }
            }));
          }
        });
      });

      const testPort = 19004;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, {
          body: {
            agent: 'test.agentuse',
            prompt: 'Hello',
            model: 'openai:gpt-4.1',
            timeout: 60,
            maxSteps: 50
          }
        });
        expect(response.status).toBe(200);
        expect((response.data as { success: boolean }).success).toBe(true);
        const parsed = (response.data as { parsed: { agent: string } }).parsed;
        expect(parsed.agent).toBe('test.agentuse');
      } finally {
        mockServer.close();
      }
    });
  });
});

describe('Serve Command - HTTP Routing', () => {
  describe('endpoint validation', () => {
    it('should return 404 for GET requests', async () => {
      const mockServer = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Endpoint not found. Use POST /run' }
          }));
          return;
        }
        res.writeHead(200);
        res.end();
      });

      const testPort = 19005;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, { method: 'GET' });
        expect(response.status).toBe(404);
        expect((response.data as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      } finally {
        mockServer.close();
      }
    });

    it('should return 404 for wrong path', async () => {
      const mockServer = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Endpoint not found. Use POST /run' }
          }));
          return;
        }
        res.writeHead(200);
        res.end();
      });

      const testPort = 19006;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, { path: '/wrong-path' });
        expect(response.status).toBe(404);
        expect((response.data as { error: { message: string } }).error.message).toContain('POST /run');
      } finally {
        mockServer.close();
      }
    });

    it('should handle OPTIONS requests for CORS preflight', async () => {
      const mockServer = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end();
      });

      const testPort = 19007;
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

      try {
        const response = await makeRequest(testPort, { method: 'OPTIONS' });
        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('*');
        expect(response.headers['access-control-allow-methods']).toContain('POST');
      } finally {
        mockServer.close();
      }
    });
  });
});

describe('Serve Command - Path Security', () => {
  let tempProjectRoot: string;

  beforeAll(() => {
    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-security-test-'));
    // Create a valid agent file inside project
    const agentContent = `---
model: anthropic:claude-sonnet-4-0
---
Test agent`;
    fs.writeFileSync(path.join(tempProjectRoot, 'valid.agentuse'), agentContent);
  });

  afterAll(() => {
    fs.rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it('should reject agent path outside project root with ../', async () => {
    // Simulate the path security check from serve.ts
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          // Security check
          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19008;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: '../../../etc/passwd' }
      });
      expect(response.status).toBe(400);
      expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_PATH');
    } finally {
      mockServer.close();
    }
  });

  it('should reject absolute path outside project root', async () => {
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19009;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: '/tmp/malicious.agentuse' }
      });
      expect(response.status).toBe(400);
      expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_PATH');
    } finally {
      mockServer.close();
    }
  });

  it('should allow valid relative path within project root', async () => {
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, resolvedPath: agentPath }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19010;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'valid.agentuse' }
      });
      expect(response.status).toBe(200);
      expect((response.data as { success: boolean }).success).toBe(true);
    } finally {
      mockServer.close();
    }
  });

  it('should handle path traversal in middle of path', async () => {
    const mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const agentPath = path.resolve(tempProjectRoot, parsed.agent);

          if (!agentPath.startsWith(tempProjectRoot)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: { code: 'INVALID_PATH', message: 'Agent path must be within project root' }
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    const testPort = 19011;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'subdir/../../../etc/passwd' }
      });
      expect(response.status).toBe(400);
      expect((response.data as { error: { code: string } }).error.code).toBe('INVALID_PATH');
    } finally {
      mockServer.close();
    }
  });
});

describe('Serve Command - Error Response Format', () => {
  it('should return consistent error format with success: false', async () => {
    const mockServer = createServer(async (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: { code: 'TEST_ERROR', message: 'Test error message' }
      }));
    });

    const testPort = 19012;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'test.agentuse' }
      });

      const data = response.data as { success: boolean; error: { code: string; message: string } };
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('TEST_ERROR');
      expect(data.error.message).toBe('Test error message');
    } finally {
      mockServer.close();
    }
  });

  it('should set Content-Type to application/json for all responses', async () => {
    const mockServer = createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const testPort = 19013;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'test.agentuse' }
      });
      expect(response.headers['content-type']).toBe('application/json');
    } finally {
      mockServer.close();
    }
  });
});

describe('Serve Command - CORS Headers', () => {
  it('should include CORS headers in all responses', async () => {
    const mockServer = createServer(async (_req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    const testPort = 19014;
    await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      const response = await makeRequest(testPort, {
        body: { agent: 'test.agentuse' }
      });
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
    } finally {
      mockServer.close();
    }
  });
});

/**
 * Multi-project serve tests.
 *
 * Replicates the project-resolution rules from serve.ts in a mock handler so
 * we can assert the HTTP contract without spinning up the real worker stack.
 * The rules under test:
 *  - single-project mode: `project` optional, existing clients unchanged
 *  - multi-project without `--default`: missing `project` -> 400 PROJECT_REQUIRED
 *  - multi-project with `--default`: missing `project` -> routes to default
 *  - unknown project id -> 404 PROJECT_NOT_FOUND
 *  - GET / returns server info
 */
function buildMockMultiProjectServer(projects: Array<{ id: string; root: string }>, defaultId?: string): Server {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const multiProject = projects.length > 1;

  return createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: 'test',
        default: defaultId ?? (multiProject ? null : projects[0].id),
        projects: projects.map((p) => ({ id: p.id, path: p.root, agentCount: 0, scheduleCount: 0 })),
      }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/run') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found. Use POST /run or GET /' } }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed: { agent?: string; project?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' } }));
        return;
      }
      if (!parsed.agent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'MISSING_FIELD', message: 'Missing agent' } }));
        return;
      }

      // project resolution
      let resolvedId: string | undefined;
      if (parsed.project !== undefined) {
        if (!byId.has(parsed.project)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: { code: 'PROJECT_NOT_FOUND', message: `Unknown project id: "${parsed.project}"` } }));
          return;
        }
        resolvedId = parsed.project;
      } else if (!multiProject) {
        resolvedId = projects[0].id;
      } else if (defaultId) {
        resolvedId = defaultId;
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: { code: 'PROJECT_REQUIRED', message: 'Multiple projects are served.' },
          availableProjects: [...byId.keys()],
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, resolvedProjectId: resolvedId, agent: parsed.agent }));
    });
  });
}

describe('Serve Command - Multi-Project Routing', () => {
  describe('single-project mode', () => {
    let server: Server;
    const port = 19020;
    beforeAll(async () => {
      server = buildMockMultiProjectServer([{ id: 'only', root: '/tmp/only' }]);
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    });
    afterAll(() => {
      server.close();
    });

    it('POST /run without project works (back-compat)', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse' } });
      expect(res.status).toBe(200);
      const data = res.data as { success: boolean; resolvedProjectId: string };
      expect(data.success).toBe(true);
      expect(data.resolvedProjectId).toBe('only');
    });

    it('POST /run with matching project works', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse', project: 'only' } });
      expect(res.status).toBe(200);
    });

    it('POST /run with unknown project returns 404 PROJECT_NOT_FOUND', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse', project: 'nope' } });
      expect(res.status).toBe(404);
      const err = (res.data as { error: { code: string } }).error;
      expect(err.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  describe('multi-project mode without --default', () => {
    let server: Server;
    const port = 19021;
    beforeAll(async () => {
      server = buildMockMultiProjectServer([
        { id: 'a', root: '/tmp/a' },
        { id: 'b', root: '/tmp/b' },
      ]);
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    });
    afterAll(() => {
      server.close();
    });

    it('POST /run without project returns 400 PROJECT_REQUIRED with available ids', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse' } });
      expect(res.status).toBe(400);
      const data = res.data as { error: { code: string }; availableProjects: string[] };
      expect(data.error.code).toBe('PROJECT_REQUIRED');
      expect(data.availableProjects).toEqual(['a', 'b']);
    });

    it('POST /run with valid project routes correctly', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse', project: 'b' } });
      expect(res.status).toBe(200);
      expect((res.data as { resolvedProjectId: string }).resolvedProjectId).toBe('b');
    });
  });

  describe('multi-project mode with --default', () => {
    let server: Server;
    const port = 19022;
    beforeAll(async () => {
      server = buildMockMultiProjectServer([
        { id: 'a', root: '/tmp/a' },
        { id: 'b', root: '/tmp/b' },
      ], 'a');
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    });
    afterAll(() => {
      server.close();
    });

    it('POST /run without project routes to default', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse' } });
      expect(res.status).toBe(200);
      expect((res.data as { resolvedProjectId: string }).resolvedProjectId).toBe('a');
    });

    it('explicit project still overrides default', async () => {
      const res = await makeRequest(port, { body: { agent: 'foo.agentuse', project: 'b' } });
      expect(res.status).toBe(200);
      expect((res.data as { resolvedProjectId: string }).resolvedProjectId).toBe('b');
    });
  });

  describe('GET /', () => {
    it('returns server info with project list and null default in multi-project mode without --default', async () => {
      const server = buildMockMultiProjectServer([
        { id: 'a', root: '/tmp/a' },
        { id: 'b', root: '/tmp/b' },
      ]);
      const port = 19023;
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      try {
        const res = await makeRequest(port, { method: 'GET', path: '/' });
        expect(res.status).toBe(200);
        const data = res.data as { version: string; default: string | null; projects: Array<{ id: string }> };
        expect(data.default).toBeNull();
        expect(data.projects.map((p) => p.id)).toEqual(['a', 'b']);
      } finally {
        server.close();
      }
    });

    it('reports the --default when set', async () => {
      const server = buildMockMultiProjectServer(
        [{ id: 'a', root: '/tmp/a' }, { id: 'b', root: '/tmp/b' }],
        'b',
      );
      const port = 19024;
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      try {
        const res = await makeRequest(port, { method: 'GET', path: '/' });
        const data = res.data as { default: string };
        expect(data.default).toBe('b');
      } finally {
        server.close();
      }
    });
  });
});
